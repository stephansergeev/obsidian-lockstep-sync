// SPDX-License-Identifier: MIT

import type { App } from "obsidian";
import { ApiError, ConflictError, SyncClient, type ChangeEntry } from "./api";
import { merge3 } from "./diff3";
import type { LocalIndex } from "./index-store";
import { conflictName, sha256, toNFC } from "./paths";
import type { SyncSettings } from "./settings";

/**
 * The two-way sync.
 *
 * Two rules govern everything here and neither is negotiable:
 *
 *   1. Nothing is overwritten silently. Where a decision could lose text, both
 *      versions end up on disk and the user is told.
 *   2. An edit beats a deletion. A resurrected note is an annoyance; a lost one is
 *      the failure this project exists to prevent.
 */

/** Text large enough that merging it line by line stops being sensible. */
const MERGE_SIZE_LIMIT = 1024 * 1024;

export interface SyncReport {
	downloaded: number;
	uploaded: number;
	deleted: number;
	renamed: number;
	merged: number;
	conflicts: number;
	skipped: number;
	errors: string[];
}

function emptyReport(): SyncReport {
	return {
		downloaded: 0,
		uploaded: 0,
		deleted: 0,
		renamed: 0,
		merged: 0,
		conflicts: 0,
		skipped: 0,
		errors: [],
	};
}

export interface EngineDeps {
	app: App;
	index: LocalIndex;
	settings: SyncSettings;
	client: () => SyncClient | null;
	onConflict: (path: string, copy: string) => void;
	log: (message: string, error?: unknown) => void;
}

export class SyncEngine {
	/** Paths this plugin is writing right now, so its own writes do not look like edits. */
	private suppressed = new Set<string>();
	private running = false;
	private queued = false;

	constructor(private deps: EngineDeps) {}

	/** Settings are edited in place by the settings tab, so the engine re-reads them. */
	updateSettings(settings: SyncSettings): void {
		this.deps.settings = settings;
	}

	get busy(): boolean {
		return this.running;
	}

	/** True while the plugin itself is writing this path. */
	isSuppressed(path: string): boolean {
		return this.suppressed.has(path);
	}

	private async write(path: string, data: ArrayBuffer): Promise<void> {
		this.suppressed.add(path);
		try {
			await this.ensureParent(path);
			await this.deps.app.vault.adapter.writeBinary(path, data);
		} finally {
			// Obsidian delivers the change event after the write returns, so the guard
			// is held a moment longer than the write itself.
			setTimeout(() => this.suppressed.delete(path), 1500);
		}
	}

	private async ensureParent(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash <= 0) return;
		const dir = path.slice(0, slash);
		if (!(await this.deps.app.vault.adapter.exists(dir))) {
			await this.deps.app.vault.adapter.mkdir(dir);
		}
	}

	isExcluded(path: string): boolean {
		return this.deps.settings.excludes.some((p) => path === p || path.startsWith(p));
	}

	/**
	 * One full pass: take what the server has, then send what we have.
	 *
	 * Pull runs first on purpose. Uploading against a stale revision only produces
	 * conflicts that a pull would have avoided.
	 */
	async sync(): Promise<SyncReport> {
		if (this.running) {
			// A pass is already in flight. Remember that something changed while it ran
			// and let the caller schedule another one rather than interleaving two.
			this.queued = true;
			return emptyReport();
		}
		this.running = true;
		const report = emptyReport();
		try {
			const client = this.deps.client();
			if (!client) return report;
			await this.pull(client, report);
			await this.push(client, report);
		} finally {
			this.running = false;
			await this.deps.index.save();
		}
		return report;
	}

	/** True when another change arrived while the last pass was running. */
	takeQueued(): boolean {
		const q = this.queued;
		this.queued = false;
		return q;
	}

	// --- pull -----------------------------------------------------------------

	private async pull(client: SyncClient, report: SyncReport): Promise<void> {
		for (;;) {
			const page = await client.changes(this.deps.index.lastSeq, 200);
			for (const entry of page.entries) {
				const path = toNFC(entry.path);
				if (this.isExcluded(path)) {
					report.skipped++;
					this.deps.index.setLastSeq(entry.seq);
					continue;
				}
				try {
					await this.applyRemote(client, entry, path, report);
				} catch (e) {
					report.errors.push(`${path}: ${describe(e)}`);
					this.deps.log(`pull ${path}`, e);
				}
				// Checkpoint after every entry: the app can be killed right here.
				this.deps.index.setLastSeq(entry.seq);
				await this.deps.index.save();
			}
			this.deps.index.setLastSeq(page.next_seq);
			if (!page.has_more) break;
		}
	}

	private async applyRemote(
		client: SyncClient,
		entry: ChangeEntry,
		path: string,
		report: SyncReport,
	): Promise<void> {
		const adapter = this.deps.app.vault.adapter;
		const known = this.deps.index.get(path);

		// The echo of our own upload: same revision, same author, nothing to do.
		if (known && known.base_rev === entry.rev && entry.updated_by === this.deviceName()) {
			report.skipped++;
			return;
		}

		if (entry.folder) {
			if (!(await adapter.exists(path))) await adapter.mkdir(path);
			this.deps.index.set(path, {
				base_rev: entry.rev,
				base_hash: "",
				local_hash: "",
				mtime: entry.mtime,
				folder: true,
			});
			return;
		}

		if (entry.deleted) {
			await this.applyRemoteDeletion(path, entry, report);
			return;
		}

		// A rename arrives as a marked destination. Moving the local file keeps its
		// history in Obsidian instead of making it look like a delete plus a download.
		if (entry.renamed_from) {
			const from = toNFC(entry.renamed_from);
			if (!this.isExcluded(from) && (await adapter.exists(from)) && !(await adapter.exists(path))) {
				const local = await adapter.readBinary(from);
				if ((await sha256(local)) === entry.hash) {
					this.suppressed.add(from);
					this.suppressed.add(path);
					await this.ensureParent(path);
					await adapter.rename(from, path);
					setTimeout(() => {
						this.suppressed.delete(from);
						this.suppressed.delete(path);
					}, 1500);
					this.deps.index.remove(from);
					this.deps.index.set(path, {
						base_rev: entry.rev,
						base_hash: entry.hash ?? "",
						local_hash: entry.hash ?? "",
						mtime: entry.mtime,
					});
					report.renamed++;
					return;
				}
			}
		}

		if (!(await adapter.exists(path))) {
			await this.download(client, entry, path);
			report.downloaded++;
			return;
		}

		const local = await adapter.readBinary(path);
		const localHash = await sha256(local);
		if (localHash === entry.hash) {
			this.deps.index.set(path, {
				base_rev: entry.rev,
				base_hash: entry.hash ?? "",
				local_hash: localHash,
				mtime: entry.mtime,
			});
			report.skipped++;
			return;
		}

		// The local file differs. If it never diverged from what we last saw, the
		// server simply moved ahead and we take its version.
		if (known && known.base_hash === localHash) {
			await this.download(client, entry, path);
			report.downloaded++;
			return;
		}

		// Both sides changed. This is the merge path.
		await this.reconcile(client, path, local, localHash, entry.rev, known?.base_rev ?? 0, report);
	}

	private async applyRemoteDeletion(
		path: string,
		entry: ChangeEntry,
		report: SyncReport,
	): Promise<void> {
		const adapter = this.deps.app.vault.adapter;
		const known = this.deps.index.get(path);
		if (!(await adapter.exists(path))) {
			this.deps.index.remove(path);
			report.skipped++;
			return;
		}
		const local = await adapter.readBinary(path);
		const localHash = await sha256(local);
		if (known && known.base_hash === localHash) {
			// Untouched here since we last saw it, so the deletion is safe to apply.
			this.suppressed.add(path);
			await adapter.remove(path);
			setTimeout(() => this.suppressed.delete(path), 1500);
			this.deps.index.remove(path);
			report.deleted++;
			return;
		}
		// Edited here, deleted there. The edit wins and goes back up as a new revision.
		this.deps.index.set(path, {
			base_rev: entry.rev,
			base_hash: "",
			local_hash: localHash,
			mtime: Date.now(),
			dirty: true,
		});
		report.conflicts++;
		this.deps.log(`kept a locally edited file the server deleted: ${path}`);
	}

	private async download(client: SyncClient, entry: ChangeEntry, path: string): Promise<void> {
		const { data, hash } = await client.getFile(path, entry.rev);
		const actual = await sha256(data);
		if (entry.hash && actual !== entry.hash) {
			throw new Error(`corrupt download: expected ${entry.hash}, got ${actual}`);
		}
		await this.write(path, data);
		this.deps.index.set(path, {
			base_rev: entry.rev,
			base_hash: hash || actual,
			local_hash: actual,
			mtime: entry.mtime,
		});
	}

	// --- push -----------------------------------------------------------------

	private async push(client: SyncClient, report: SyncReport): Promise<void> {
		const adapter = this.deps.app.vault.adapter;

		// Renames go first. Sending them as a move keeps the file's history instead of
		// showing up on other devices as a deletion followed by an unfamiliar new file.
		for (const rename of [...this.deps.index.renames]) {
			try {
				const res = await client.rename(rename.from, rename.to, rename.base_rev);
				this.deps.index.clearRename(rename);
				const moved = this.deps.index.get(rename.to);
				this.deps.index.set(rename.to, {
					base_rev: res.rev,
					base_hash: moved?.base_hash ?? res.hash,
					local_hash: moved?.local_hash ?? res.hash,
					mtime: Date.now(),
					dirty: moved?.dirty ?? false,
				});
				this.deps.index.remove(rename.from);
				report.renamed++;
			} catch (e) {
				// A conflicting or impossible move degrades to an ordinary upload of the
				// new path. Nothing is lost, the file just arrives without its history.
				this.deps.index.clearRename(rename);
				this.deps.log(`rename ${rename.from} -> ${rename.to}`, e);
			}
		}

		for (const path of this.deps.index.paths()) {
			const entry = this.deps.index.get(path);
			if (!entry || entry.folder || !entry.dirty || this.isExcluded(path)) continue;
			try {
				if (!(await adapter.exists(path))) {
					await this.pushDeletion(client, path, entry.base_rev, report);
					continue;
				}
				const data = await adapter.readBinary(path);
				const hash = await sha256(data);
				if (hash === entry.base_hash) {
					// Changed and changed back. Nothing to send.
					this.deps.index.set(path, { ...entry, local_hash: hash, dirty: false });
					report.skipped++;
					continue;
				}
				await this.upload(client, path, data, hash, entry.base_rev, report);
			} catch (e) {
				report.errors.push(`${path}: ${describe(e)}`);
				this.deps.log(`push ${path}`, e);
			}
		}
	}

	private async upload(
		client: SyncClient,
		path: string,
		data: ArrayBuffer,
		hash: string,
		baseRev: number,
		report: SyncReport,
	): Promise<void> {
		try {
			const res = await client.putFile(path, baseRev, data, Date.now());
			this.deps.index.set(path, {
				base_rev: res.rev,
				base_hash: res.hash || hash,
				local_hash: hash,
				mtime: Date.now(),
				dirty: false,
			});
			report.uploaded++;
		} catch (e) {
			if (!(e instanceof ConflictError)) throw e;
			await this.reconcile(client, path, data, hash, e.serverRev, baseRev, report);
		}
	}

	private async pushDeletion(
		client: SyncClient,
		path: string,
		baseRev: number,
		report: SyncReport,
	): Promise<void> {
		try {
			await client.deleteFile(path, baseRev);
			this.deps.index.remove(path);
			report.deleted++;
		} catch (e) {
			if (!(e instanceof ConflictError)) throw e;
			// Deleted here, edited there. The edit wins: bring the file back.
			const entry = await client.getFile(path);
			await this.write(path, entry.data);
			this.deps.index.set(path, {
				base_rev: entry.rev,
				base_hash: entry.hash,
				local_hash: entry.hash,
				mtime: Date.now(),
			});
			report.conflicts++;
			this.deps.log(`restored a file deleted here and edited on the server: ${path}`);
		}
	}

	// --- merge ----------------------------------------------------------------

	/**
	 * Both sides changed the same file. Nothing here may overwrite without keeping a
	 * copy of what it replaced.
	 */
	private async reconcile(
		client: SyncClient,
		path: string,
		localData: ArrayBuffer,
		localHash: string,
		serverRev: number,
		baseRev: number,
		report: SyncReport,
	): Promise<void> {
		const server = await client.getFile(path, serverRev);
		const localText = decodeText(localData);
		const serverText = decodeText(server.data);

		if (
			localText === null ||
			serverText === null ||
			localData.byteLength > MERGE_SIZE_LIMIT ||
			server.data.byteLength > MERGE_SIZE_LIMIT
		) {
			await this.keepBothWithoutMerging(path, localData, server, report);
			return;
		}

		let baseText = "";
		if (baseRev > 0) {
			try {
				const base = await client.getFile(path, baseRev);
				baseText = decodeText(base.data) ?? "";
			} catch (e) {
				// The ancestor is gone, most likely collected. Without it a merge would be
				// guesswork, so both versions are kept instead.
				if (!(e instanceof ApiError)) throw e;
				await this.keepBothWithoutMerging(path, localData, server, report);
				return;
			}
		}

		const merged = merge3(baseText, localText, serverText, this.deviceName(), "server");

		if (merged.clean) {
			const data = encodeText(merged.text);
			await this.write(path, data);
			const hash = await sha256(data);
			const res = await client.putFile(path, serverRev, data, Date.now());
			this.deps.index.set(path, {
				base_rev: res.rev,
				base_hash: res.hash || hash,
				local_hash: hash,
				mtime: Date.now(),
				dirty: false,
			});
			report.merged++;
			return;
		}

		// Overlapping edits. The file on disk becomes the server version, and the merge
		// with its markers is placed alongside so nothing has to be reconstructed.
		const copy = conflictName(path, this.deviceName(), new Date());
		await this.write(copy, encodeText(merged.text));
		await this.write(path, server.data);
		this.deps.index.set(path, {
			base_rev: server.rev,
			base_hash: server.hash,
			local_hash: server.hash,
			mtime: Date.now(),
		});
		this.deps.index.remove(copy);
		report.conflicts++;
		this.deps.onConflict(path, copy);
		void localHash;
	}

	/** Binary content, or text too large to merge line by line. */
	private async keepBothWithoutMerging(
		path: string,
		localData: ArrayBuffer,
		server: { data: ArrayBuffer; rev: number; hash: string },
		report: SyncReport,
	): Promise<void> {
		const copy = conflictName(path, this.deviceName(), new Date());
		await this.write(copy, localData);
		await this.write(path, server.data);
		this.deps.index.set(path, {
			base_rev: server.rev,
			base_hash: server.hash,
			local_hash: server.hash,
			mtime: Date.now(),
		});
		this.deps.index.remove(copy);
		report.conflicts++;
		this.deps.onConflict(path, copy);
	}

	private deviceName(): string {
		return this.deps.settings.deviceName || "local";
	}
}

function describe(e: unknown): string {
	if (e instanceof ApiError) return `${e.status} ${e.kind}: ${e.message}`;
	return e instanceof Error ? e.message : String(e);
}

/** Decode as UTF-8, or null when the bytes are not text we should be merging. */
function decodeText(data: ArrayBuffer): string | null {
	const bytes = new Uint8Array(data);
	for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) return null;
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch {
		return null;
	}
}

function encodeText(text: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(text);
	return encoded.buffer.slice(
		encoded.byteOffset,
		encoded.byteOffset + encoded.byteLength,
	) as ArrayBuffer;
}
