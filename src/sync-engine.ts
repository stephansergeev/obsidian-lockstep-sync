// SPDX-License-Identifier: MIT

import type { App } from "obsidian";
import { ApiError, ConflictError, SyncClient, type ChangeEntry } from "./api";

export { SyncClient } from "./api";
import { merge3 } from "./diff3";
import type { DeferredChange, LocalIndex } from "./index-store";
import { conflictName, defaultDeviceName, sha256, toNFC } from "./paths";
import { plaintext as plaintextCipher, type Cipher, type PathCipher } from "./crypto";
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

/** What encryptInPlace needs beyond the engine's own dependencies. */
export interface EncryptInPlaceArgs {
	/** Talks to the server by the names it holds now: the readable ones. */
	plain: SyncClient;
	/** Talks to the server by hidden names, which is how every device talks to it afterwards. */
	sealed: SyncClient;
	cipher: Cipher;
	paths: PathCipher;
}

export interface EncryptReport {
	/** Readable files the server had that this device did not, or had differently, taken in first. */
	pulled: number;
	uploaded: number;
	/** Already on the server under their hidden names with the same content: a resumed run. */
	kept: number;
	/** Readable copies erased, folders included. */
	erased: number;
	purgedBytes: number;
}

export interface EngineDeps {
	app: App;
	index: LocalIndex;
	settings: SyncSettings;
	client: () => SyncClient | null;
	/** Encryption in force right now, or the pass-through when it is off. */
	cipher: () => Cipher;
	/**
	 * A reason not to sync at all, or empty when there is none. Checked before
	 * anything is read or written.
	 */
	guard: (manual: boolean) => Promise<string>;
	onConflict: (path: string, copy: string) => void;
	/** Every file path in the vault right now. Cheap: Obsidian keeps this in memory. */
	listLocalFiles: () => string[];
	/** How many files the server holds, or 0 if unknown. Gives a pull a denominator. */
	serverFileCount?: () => number;
	/**
	 * A folder of this plugin's own, for the pieces of a download in progress. A
	 * phone suspends the app whenever the screen goes dark, and a large file
	 * fetched in one request was lost each time; fetched in slices that land on
	 * disk, it continues from the last whole slice instead.
	 */
	scratchDir: string;
	/** Slice size for large downloads. Files under one slice are fetched whole. */
	chunkBytes?: number;
	/** First wait before a failed change is tried again; doubles each time, up to an hour. */
	deferBaseMs?: number;
	/**
	 * True once the plugin has been unloaded. A pass is a chain of awaits, and
	 * unloading does not cancel it: an updated plugin's old copy kept uploading for
	 * two minutes after its replacement had started, sending every remaining file
	 * twice and then overwriting the journal with its own. Checked between files.
	 */
	stopped: () => boolean;
	/**
	 * Called as each file moves. total is known for uploads, where the queue is
	 * counted before it starts, and zero for downloads, which arrive in pages.
	 */
	onProgress?: (done: number, total: number, path: string) => void;
	/**
	 * One line per decision, kept in a ring on disk. When something syncs wrongly the
	 * question is always "which branch took this entry", and the answer has to come
	 * from the device where it happened, not from a guess at a distance.
	 */
	trace?: (line: string) => void;
	log: (message: string, error?: unknown) => void;
}

export class SyncEngine {
	/** Paths this plugin is writing right now, so its own writes do not look like edits. */
	private suppressed = new Set<string>();
	/**
	 * The cipher for the duration of one pass, taken once at its start. Reading it
	 * live meant that wiping the passphrase mid-pass swapped the cipher under a
	 * running upload, and the tail of that pass went up in plaintext.
	 */
	private passCipher: Cipher | null = null;
	/** Which half of a pass is running, for progress wording. */
	phase: "idle" | "pull" | "push" | "encrypt" = "idle";
	private running = false;
	private queued = false;

	constructor(private deps: EngineDeps) {}

	/**
	 * Start over when the key situation has changed since the last pull.
	 *
	 * A vault read without its key, or read with one after being read without, was
	 * read wrongly. The cursor has to go back to the beginning, or the entries that
	 * were misread are never offered again.
	 */
	private async resetCursorIfCipherChanged(): Promise<void> {
		const now = this.deps.cipher().enabled;
		if (this.deps.index.readEncrypted === now) return;
		if (now) this.forgetServerRevisions();
		this.deps.index.setReadEncrypted(now);
		this.deps.index.resetCursor();
		await this.deps.index.save();
	}

	/**
	 * Keep what is known about the files on disk, forget what was known about the
	 * server's copies of them.
	 *
	 * This device read the vault readable, and the vault has since been encrypted:
	 * every file on the server is now a different entry under a different name, and
	 * the revisions the index remembers belong to entries that no longer exist. A
	 * merge based on them would fetch the wrong ancestor. With the base gone, a file
	 * that is the same on both sides is simply adopted, and one that differs is kept
	 * in both versions, which is the honest answer when the ancestor is unknown.
	 */
	private forgetServerRevisions(): void {
		for (const path of this.deps.index.paths()) {
			const entry = this.deps.index.get(path);
			if (entry) this.deps.index.set(path, { ...entry, base_rev: 0, base_hash: "" });
		}
	}

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
			window.setTimeout(() => this.suppressed.delete(path), 1500);
		}
	}

	/**
	 * Remove folders our own move or deletion has just emptied.
	 *
	 * Renaming a folder arrives here as its files moving one by one. The files land
	 * in the right place, and the folder they came from stays behind, empty, looking
	 * exactly like a duplicate of the folder that was renamed.
	 *
	 * Only the parents of the path we just touched are considered, and only while
	 * they are empty, so a folder somebody made deliberately is never swept up by a
	 * deletion that happened to be its last file.
	 */
	private async pruneEmptyParents(path: string): Promise<void> {
		const adapter = this.deps.app.vault.adapter;
		let dir = path.slice(0, path.lastIndexOf("/"));
		while (dir && dir !== "/" && !dir.startsWith(".")) {
			try {
				const listing = await adapter.list(dir);
				if (listing.files.length > 0 || listing.folders.length > 0) {
					this.trace(`kept folder ${dir}: not empty`);
					return;
				}
				this.suppressed.add(dir);
				// recursive=true even though the folder was just verified empty:
				// Obsidian's desktop adapter throws EISDIR on rmdir(dir, false), and a
				// silent catch here left ghost folders behind every rename received on
				// a desktop while phones, on a different adapter, cleaned up fine.
				await adapter.rmdir(dir, true);
				this.trace(`pruned empty folder ${dir}`);
				window.setTimeout(() => this.suppressed.delete(dir), 1500);
			} catch (e) {
				this.trace(`could not prune ${dir}: ${e instanceof Error ? e.message : e}`);
				return;
			}
			dir = dir.slice(0, dir.lastIndexOf("/"));
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

	/**
	 * Whether these plaintext bytes are what the server stores under that hash.
	 *
	 * The server only ever knows ciphertext hashes, and the disk only ever holds
	 * plaintext, so the two sides could not be compared directly and every earlier
	 * comparison leaned on optional index fields that were lost in enough places to
	 * matter. Deterministic encryption closes the gap: sealing the same bytes always
	 * yields the same ciphertext, so sealing what is on disk and hashing it gives
	 * exactly the number the server would have. One more reason the nonce is derived
	 * rather than random.
	 */
	private cipher(): Cipher {
		return this.passCipher ?? this.deps.cipher();
	}

	private async matchesRemote(plain: ArrayBuffer, remoteHash: string | undefined): Promise<boolean> {
		if (!remoteHash) return false;
		const sealed = await this.cipher().encrypt(plain);
		return (await sha256(sealed)) === remoteHash;
	}

	private trace(line: string): void {
		this.deps.trace?.(line);
	}

	/** True when this path is a folder in the vault rather than a file. */
	private isFolder(path: string): boolean {
		const known = this.deps.app.vault.getAbstractFileByPath?.(path);
		if (!known) return false;
		return !("stat" in known);
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
	async sync(manual = false): Promise<SyncReport> {
		if (this.running) {
			// A pass is already in flight. Remember that something changed while it ran
			// and let the caller schedule another one rather than interleaving two.
			this.queued = true;
			return emptyReport();
		}
		this.running = true;
		const report = emptyReport();
		try {
			await this.pruneConflicts();
			const client = this.deps.client();
			if (!client) return report;
			// Reading an encrypted vault without the key produces filenames that are
			// ciphertext and content that is noise. Better to do nothing and say why.
			const barrier = await this.deps.guard(manual);
			if (barrier) {
				report.errors.push(barrier);
				return report;
			}
			await this.resetCursorIfCipherChanged();
			this.passCipher = this.deps.cipher();
			// Renames go to the server before anything is read from it. A pass used to
			// start by pulling, and at that moment the server still believed the old
			// paths: they were missing locally, unknown to the index, and so were
			// downloaded straight back. The device then fought its own rename, kept
			// the resurrected file as a local edit, and pushed it to every other
			// device. Telling the server where things live first closes the window.
			await this.flushRenames(client, report);
			this.phase = "pull";
			await this.pull(client, report);
			this.adoptUnknownFiles();
			this.phase = "push";
			await this.push(client, report);
		} finally {
			this.phase = "idle";
			this.passCipher = null;
			this.running = false;
			await this.deps.index.save();
		}
		return report;
	}

	/**
	 * Turn encryption on for a vault that is already on the server, readable.
	 *
	 * Three moves, in an order that never leaves a file in neither form:
	 *
	 *   1. Take in whatever the server holds readable that this device does not,
	 *      through the ordinary pull, so that nothing is erased that was never
	 *      re-uploaded. A file edited on both sides is kept in both versions, as it
	 *      would be in any sync.
	 *   2. Upload every local file under its hidden name, encrypted, notes first. A
	 *      file already there with the same content is left alone, which is what
	 *      makes an interrupted run finish rather than start over.
	 *   3. Erase the readable copies, then their history, then the marker.
	 *
	 * The server accepts writes from nobody else while the marker stands, so the
	 * list taken in step 1 is still the truth in step 3. Every step can be repeated:
	 * if the app dies at any point the next run does the remaining part and the
	 * skipped parts cost a hash each.
	 */
	async encryptInPlace(args: EncryptInPlaceArgs): Promise<EncryptReport> {
		if (this.running) throw new Error("a sync is running; try again in a moment");
		this.running = true;
		this.phase = "encrypt";
		const adapter = this.deps.app.vault.adapter;
		const out: EncryptReport = { pulled: 0, uploaded: 0, kept: 0, erased: 0, purgedBytes: 0 };
		try {
			await args.plain.setMigration();

			// What the server holds, sorted by which name it holds it under. A name
			// the key cannot open is a readable one from before.
			const readable = new Map<string, ChangeEntry>();
			const hidden = new Map<string, ChangeEntry>();
			for (let since = 0; ; ) {
				const page = await args.plain.changes(since, 500);
				for (const entry of page.entries) {
					if (entry.deleted) continue;
					let local: string | null = null;
					try {
						local = await args.paths.decrypt(entry.path);
					} catch {
						local = null;
					}
					if (local === null) readable.set(toNFC(entry.path), entry);
					else hidden.set(toNFC(local), entry);
				}
				since = page.next_seq;
				if (!page.has_more) break;
			}
			this.trace(`encrypt: server holds ${readable.size} readable, ${hidden.size} hidden`);

			// 1. Pull the readable entries, exactly as a plaintext pass would.
			this.passCipher = plaintextCipher;
			const pull = emptyReport();
			for (const [path, entry] of readable) {
				if (this.deps.stopped()) throw new Error("stopped");
				if (this.isExcluded(path)) continue;
				await this.applyRemote(args.plain, entry, path, pull);
			}
			out.pulled = pull.downloaded + pull.merged + pull.conflicts;
			this.adoptUnknownFiles();
			// Moves not yet sent are moot: the destination goes up under its own name
			// and the source is about to be erased with every other readable path.
			for (const rename of [...this.deps.index.renames]) this.deps.index.clearRename(rename);
			await this.deps.index.save();

			// 2. Upload everything on disk, hidden. Notes first, as on a first sync.
			this.passCipher = args.cipher;
			const onDisk = new Set<string>();
			for (const path of [...this.deps.listLocalFiles(), ...this.deps.index.paths()]) {
				if (this.isExcluded(path) || this.deps.index.get(path)?.folder) continue;
				if (await adapter.exists(path)) onDisk.add(path);
			}
			const queue = [...onDisk].sort((a, b) => weight(a) - weight(b) || a.localeCompare(b));
			let done = 0;
			let next = 0;
			let lastCheckpoint = Date.now();
			const one = async (path: string): Promise<void> => {
				if (this.isFolder(path)) return;
				const data = await adapter.readBinary(path);
				const hash = await sha256(data);
				const have = hidden.get(toNFC(path));
				if (have && (await this.matchesRemote(data, have.hash))) {
					this.deps.index.set(path, {
						base_rev: have.rev,
						base_hash: have.hash ?? "",
						plain_hash: hash,
						local_hash: hash,
						mtime: have.mtime,
						dirty: false,
					});
					out.kept++;
					return;
				}
				const sealed = await args.cipher.encrypt(data);
				const res = await args.sealed.putFile(path, have?.rev ?? 0, sealed, Date.now());
				this.deps.index.set(path, {
					base_rev: res.rev,
					base_hash: res.hash || (await sha256(sealed)),
					plain_hash: hash,
					local_hash: hash,
					mtime: Date.now(),
					dirty: false,
				});
				out.uploaded++;
				this.trace(`encrypted ${path} (${data.byteLength} bytes)`);
			};
			const worker = async (): Promise<void> => {
				while (next < queue.length) {
					if (this.deps.stopped()) throw new Error("stopped");
					const path = queue[next++] as string;
					await one(path);
					done++;
					this.deps.onProgress?.(done, queue.length, path);
					if (Date.now() - lastCheckpoint > 2000) {
						lastCheckpoint = Date.now();
						await this.deps.index.save();
					}
				}
			};
			await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
			await this.deps.index.save();

			// 3. The readable copies go, files before the folders that held them.
			let lastSeq = 0;
			const targets = [...readable.entries()].sort((a, b) => Number(a[1].folder) - Number(b[1].folder));
			for (const [path, entry] of targets) {
				if (this.deps.stopped()) throw new Error("stopped");
				const res = await args.plain.deleteFile(path, entry.rev);
				lastSeq = Math.max(lastSeq, res.seq);
				out.erased++;
			}
			// Paths the index still knows that are not on disk were deleted here and
			// never sent; their readable copies are gone with the rest.
			for (const path of this.deps.index.paths()) {
				if (!(await adapter.exists(path))) this.deps.index.remove(path);
			}
			out.purgedBytes = (await args.plain.purgeDeleted()).bytes;
			await args.plain.clearMigration();

			// This device has seen everything it just did. From here it reads with
			// the key, and the cursor starts past its own work.
			this.deps.index.setReadEncrypted(true);
			this.deps.index.setLastSeq(lastSeq);
			this.trace(
				`encrypt: done, ${out.pulled} pulled, ${out.uploaded} uploaded, ${out.kept} kept, ` +
					`${out.erased} readable copies erased, ${out.purgedBytes} bytes purged`,
			);
			return out;
		} finally {
			this.phase = "idle";
			this.passCipher = null;
			this.running = false;
			await this.deps.index.save();
		}
	}

	/**
	 * Forget conflicts whose copy is no longer on disk.
	 *
	 * Deleting the copy by hand is a perfectly ordinary way of saying the question
	 * does not need answering. Leaving the entry behind means offering a choice
	 * between two versions when one of them is gone, and the offer fails when taken.
	 */
	async pruneConflicts(): Promise<boolean> {
		const adapter = this.deps.app.vault.adapter;
		let changed = false;
		for (const conflict of [...this.deps.index.conflicts]) {
			if (await adapter.exists(conflict.copy)) continue;
			this.deps.index.clearConflict(conflict.path);
			changed = true;
			this.deps.log(`forgot a conflict whose copy was deleted: ${conflict.path}`);
		}
		if (changed) await this.deps.index.save();
		return changed;
	}

	/** True when another change arrived while the last pass was running. */
	takeQueued(): boolean {
		const q = this.queued;
		this.queued = false;
		return q;
	}

	// --- pull -----------------------------------------------------------------

	private async pull(client: SyncClient, report: SyncReport): Promise<void> {
		// The cursor is checkpointed on a clock, not per entry. Saving the index after
		// every one of 844 arrivals cost more than the arrivals did; a kill now loses
		// at most two seconds of cursor, and the entries it forgets are simply applied
		// again, which for content already on disk is a hash check and nothing else.
		let lastCheckpoint = Date.now();
		const checkpoint = async (force = false) => {
			if (force || Date.now() - lastCheckpoint > 2000) {
				lastCheckpoint = Date.now();
				await this.deps.index.save();
			}
		};
		try {
			await this.retryDeferred(client, report);
			for (;;) {
				const page = await client.changes(this.deps.index.lastSeq, 200);
				for (const entry of page.entries) {
					if (this.deps.stopped()) return;
					const path = toNFC(entry.path);
					// A path that is queued to move away is already spoken for. Touching it
					// here would recreate it moments before our own rename deletes it.
					if (this.deps.index.renames.some((r) => r.from === path)) {
						this.trace(`pull skipped ${path}: queued to move away`);
						report.skipped++;
						this.deps.index.setLastSeq(entry.seq);
						continue;
					}
					if (this.isExcluded(path)) {
						report.skipped++;
						this.deps.index.setLastSeq(entry.seq);
						continue;
					}
					try {
						await this.applyRemote(client, entry, path, report);
					} catch (e) {
						// The change log never offers this entry again, so it cannot simply
						// be skipped. It used to stop the cursor instead, and one file a
						// phone could not finish held every file behind it. Now the entry
						// itself is kept, the cursor moves on, and it is tried again ahead
						// of the next pass, with a wait that grows each time it fails.
						this.defer(path, entry, e, report);
					}
					this.deps.index.setLastSeq(entry.seq);
					await checkpoint();
					// A catch-up pull has a denominator: the number of files the server
					// holds. It is only exact for a device starting from nothing, which
					// is exactly when somebody is watching the number.
					const arrived = report.downloaded + report.renamed + report.merged;
					const total = this.deps.index.lastSeq === 0 || arrived > 0 ? (this.deps.serverFileCount?.() ?? 0) : 0;
					this.deps.onProgress?.(arrived, arrived >= 5 ? total : 0, path);
				}
				this.deps.index.setLastSeq(page.next_seq);
				if (!page.has_more || this.deps.stopped()) break;
			}
		} finally {
			await checkpoint(true);
		}
	}

	private defer(path: string, entry: ChangeEntry, e: unknown, report: SyncReport): void {
		const known = this.deps.index.deferred.find((d) => d.path === path);
		const attempts = (known?.attempts ?? 0) + 1;
		const base = this.deps.deferBaseMs ?? 60_000;
		const wait = Math.min(base * 2 ** (attempts - 1), 60 * 60_000);
		this.deps.index.defer({
			path,
			entry: entry as unknown as Record<string, unknown>,
			seq: entry.seq,
			attempts,
			next_try: Date.now() + wait,
			error: describe(e),
		});
		// Said once, then only to the journal: a file that fails every pass would
		// otherwise announce itself every fifteen seconds.
		if (attempts === 1) report.errors.push(`${path}: ${describe(e)}`);
		this.deps.log(`pull ${path} (attempt ${attempts}, next in ${Math.round(wait / 1000)}s)`, e);
	}

	private async retryDeferred(client: SyncClient, report: SyncReport): Promise<void> {
		for (const d of [...this.deps.index.deferred]) {
			if (this.deps.stopped()) return;
			if (d.next_try > Date.now()) continue;
			const entry = d.entry as unknown as ChangeEntry;
			// A later change for the same path has arrived and been applied since;
			// the old one would only roll it back.
			const known = this.deps.index.get(d.path);
			if (known && known.base_rev >= entry.rev) {
				this.deps.index.undefer(d.path);
				continue;
			}
			try {
				await this.applyRemote(client, entry, d.path, report);
				this.deps.index.undefer(d.path);
				this.trace(`deferred ${d.path} applied on attempt ${d.attempts + 1}`);
			} catch (e) {
				this.defer(d.path, entry, e, report);
			}
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
			// Changing only the letter case is a rename to itself on macOS, iOS and
			// Windows, where the filesystem does not distinguish the two names. Asking
			// whether the destination exists answers yes, about the source, and the move
			// used to be skipped: the index believed the new name while the disk kept
			// the old one forever.
			const caseOnly = from !== path && from.toLowerCase() === path.toLowerCase();
			const destTaken = !caseOnly && (await adapter.exists(path));
			const fromExists = await adapter.exists(from);
			if (!this.isExcluded(from) && fromExists && !destTaken) {
				const local = await adapter.readBinary(from);
				// Compared as ciphertext, which is the only currency both sides hold.
				// Every earlier version compared through optional index fields, and a
				// record that had lost one fell through to downloading a second copy
				// while the first stayed where it was and later came back everywhere.
				const sameContent = await this.matchesRemote(local, entry.hash);
				if (sameContent) {
					this.suppressed.add(from);
					this.suppressed.add(path);
					await this.ensureParent(path);
					if (caseOnly) {
						// Two steps through a name that collides with neither, because one
						// step is a no-op where case is not part of identity.
						const parked = `${path}.lockstep-${Date.now()}`;
						this.suppressed.add(parked);
						await adapter.rename(from, parked);
						await adapter.rename(parked, path);
						this.suppressed.delete(parked);
					} else {
						await adapter.rename(from, path);
					}
					window.setTimeout(() => {
						this.suppressed.delete(from);
						this.suppressed.delete(path);
					}, 1500);
					this.deps.index.remove(from);
					// The plaintext hash travels with the file. Recording the server's
					// hash as the local one leaves the entry describing bytes that are
					// not on disk, and the next thing that happens to this path, a
					// deletion most often, is read as an edit made here.
					const plainHash = await sha256(local);
					this.deps.index.set(path, {
						base_rev: entry.rev,
						base_hash: entry.hash ?? "",
						plain_hash: plainHash,
						local_hash: plainHash,
						mtime: entry.mtime,
					});
					await this.pruneEmptyParents(from);
					this.trace(`rename moved ${from} -> ${path}`);
					report.renamed++;
					return;
				}
				this.trace(`rename fell through ${from} -> ${path}: content differs from server`);
			} else {
				this.trace(
					`rename fell through ${from} -> ${path}: ` +
						(this.isExcluded(from)
							? "source excluded"
							: !fromExists
								? "source not on disk"
								: "destination taken"),
				);
			}
		}

		if (!(await adapter.exists(path))) {
			// Deleted here and not sent yet. Downloading it now would undo the deletion
			// before push ever sees it, and on the device that created the file that
			// meant it could never be deleted at all.
			if (known?.dirty) {
				report.skipped++;
				return;
			}
			await this.download(client, entry, path);
			report.downloaded++;
			return;
		}

		const local = await adapter.readBinary(path);
		const localHash = await sha256(local);
		if (await this.matchesRemote(local, entry.hash)) {
			// What is on disk is exactly what the server holds, whatever the index
			// thought it knew about either of them.
			this.deps.index.set(path, {
				base_rev: entry.rev,
				base_hash: entry.hash ?? "",
				plain_hash: localHash,
				local_hash: localHash,
				mtime: entry.mtime,
			});
			this.trace(`same content, indexed ${path} at rev ${entry.rev}`);
			report.skipped++;
			return;
		}

		// The local file differs from what we last saw. If it never diverged, the
		// server simply moved ahead and we take its version.
		if (known && known.plain_hash === localHash) {
			await this.download(client, entry, path);
			report.downloaded++;
			return;
		}

		// Both sides changed. This is the merge path.
		await this.reconcile(
			client, path, local, entry.rev, known?.base_rev ?? 0, report, entry.updated_by ?? "",
		);
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
		const matchesBase = known !== undefined && (await this.matchesRemote(local, known.base_hash));
		const matchesPlain = known !== undefined && known.plain_hash === localHash;
		this.trace(
			`deletion check ${path}: base=${known?.base_hash?.slice(0, 8) ?? "none"} ` +
				`plain=${known?.plain_hash?.slice(0, 8) ?? "none"} disk=${localHash.slice(0, 8)} ` +
				`matchesBase=${matchesBase} matchesPlain=${matchesPlain}`,
		);
		const untouched = matchesBase || matchesPlain;
		if (untouched) {
			// Untouched here since we last saw it, so the deletion is safe to apply.
			this.suppressed.add(path);
			await adapter.remove(path);
			window.setTimeout(() => this.suppressed.delete(path), 1500);
			this.deps.index.remove(path);
			await this.pruneEmptyParents(path);
			this.trace(`deletion applied ${path}`);
			report.deleted++;
			return;
		}
		this.trace(`deletion resisted ${path}: local content differs, keeping it`);
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

	/**
	 * Fetch a revision and decrypt it.
	 *
	 * The integrity check is done on the bytes as the server stored them, before
	 * decryption: that is the only hash both sides agree on.
	 */
	private async fetch(
		client: SyncClient,
		path: string,
		rev?: number,
		expectHash?: string,
		size?: number,
	): Promise<{ plain: ArrayBuffer; cipherHash: string; plainHash: string; rev: number }> {
		const got =
			size !== undefined && size > this.chunkBytes()
				? await this.fetchInSlices(client, path, rev, size, expectHash)
				: await client.getFile(path, rev);
		const cipherHash = await sha256(got.data);
		if (expectHash && cipherHash !== expectHash) {
			await this.dropSlices(path);
			throw new Error(`corrupt download: expected ${expectHash}, got ${cipherHash}`);
		}
		await this.dropSlices(path);
		const plain = await this.cipher().decrypt(got.data);
		return { plain, cipherHash, plainHash: await sha256(plain), rev: got.rev || rev || 0 };
	}

	private chunkBytes(): number {
		return this.deps.chunkBytes ?? 4 * 1024 * 1024;
	}

	private async sliceDir(path: string): Promise<string> {
		return `${this.deps.scratchDir}/parts/${(await sha256(new TextEncoder().encode(path).buffer)).slice(0, 32)}`;
	}

	/**
	 * A large file, one slice at a time, each slice written to disk as it lands. A
	 * run that is cut off resumes at the first slice that is not there. The slices
	 * are keyed by the revision and the expected hash, so a file that changed on
	 * the server meanwhile starts over rather than being stitched from two versions.
	 */
	private async fetchInSlices(
		client: SyncClient,
		path: string,
		rev: number | undefined,
		size: number,
		expectHash: string | undefined,
	): Promise<{ data: ArrayBuffer; rev: number; hash: string }> {
		const adapter = this.deps.app.vault.adapter;
		const dir = await this.sliceDir(path);
		const chunk = this.chunkBytes();
		const count = Math.ceil(size / chunk);
		const stamp = `${rev ?? 0}:${expectHash ?? ""}:${size}`;
		const stampFile = `${dir}/stamp`;
		let have = 0;
		if ((await adapter.exists(stampFile)) && (await adapter.read(stampFile)) === stamp) {
			while (have < count && (await adapter.exists(`${dir}/${have}`))) have++;
		} else {
			await this.dropSlices(path);
			await adapter.mkdir(`${this.deps.scratchDir}/parts`).catch(() => undefined);
			await adapter.mkdir(dir).catch(() => undefined);
			await adapter.write(stampFile, stamp);
		}
		this.trace(
			have > 0
				? `resumed ${path} at slice ${have} of ${count}`
				: `fetching ${path} in ${count} slices of ${chunk} bytes`,
		);
		for (let i = have; i < count; i++) {
			if (this.deps.stopped()) throw new Error("stopped");
			const start = i * chunk;
			const end = Math.min(size, start + chunk) - 1;
			const got = await client.getFileRange(path, rev, start, end);
			if (got.data.byteLength !== end - start + 1) {
				throw new Error(`short slice ${i} of ${path}: ${got.data.byteLength} bytes`);
			}
			await adapter.writeBinary(`${dir}/${i}`, got.data);
			this.deps.onProgress?.(i + 1, count, path);
		}
		const joined = new Uint8Array(size);
		for (let i = 0; i < count; i++) {
			joined.set(new Uint8Array(await adapter.readBinary(`${dir}/${i}`)), i * chunk);
		}
		return { data: joined.buffer, rev: rev ?? 0, hash: expectHash ?? "" };
	}

	private async dropSlices(path: string): Promise<void> {
		const dir = await this.sliceDir(path);
		try {
			if (await this.deps.app.vault.adapter.exists(dir)) {
				await this.deps.app.vault.adapter.rmdir(dir, true);
			}
		} catch {
			/* leftovers cost disk, not correctness */
		}
	}

	/** Encrypt and upload. Returns what the index needs to remember. */
	private async send(
		client: SyncClient,
		path: string,
		baseRev: number,
		plain: ArrayBuffer,
		plainHash: string,
	): Promise<void> {
		const sealed = await this.cipher().encrypt(plain);
		const res = await client.putFile(path, baseRev, sealed, Date.now());
		this.deps.index.set(path, {
			base_rev: res.rev,
			base_hash: res.hash || (await sha256(sealed)),
			plain_hash: plainHash,
			local_hash: plainHash,
			mtime: Date.now(),
			dirty: false,
		});
	}

	private async download(client: SyncClient, entry: ChangeEntry, path: string): Promise<void> {
		const got = await this.fetch(client, path, entry.rev, entry.hash, entry.size);
		await this.write(path, got.plain);
		this.deps.index.set(path, {
			base_rev: entry.rev,
			base_hash: entry.hash ?? got.cipherHash,
			plain_hash: got.plainHash,
			local_hash: got.plainHash,
			mtime: entry.mtime,
		});
	}

	// --- push -----------------------------------------------------------------

	/**
	 * Queue every file the index has never heard of.
	 *
	 * The watcher only sees what happens after the plugin started. A vault that
	 * existed before it was connected, which is every vault worth syncing, has
	 * hundreds of files the watcher will never mention, and the first sync of it
	 * used to finish instantly having sent nothing. Runs after pull, so files that
	 * just arrived from the server are already indexed and are not sent back.
	 */
	private adoptUnknownFiles(): void {
		let adopted = 0;
		for (const path of this.deps.listLocalFiles()) {
			const normal = toNFC(path);
			if (this.isExcluded(normal) || this.deps.index.get(normal)) continue;
			this.deps.index.set(normal, {
				base_rev: 0,
				base_hash: "",
				local_hash: "",
				mtime: Date.now(),
				dirty: true,
			});
			adopted++;
		}
		if (adopted > 0) this.trace(`adopted ${adopted} files the index had never seen`);
	}

	private async flushRenames(client: SyncClient, report: SyncReport): Promise<void> {
		// Sent as moves so the file keeps its history, instead of showing up on other
		// devices as a deletion followed by an unfamiliar new file.
		for (const rename of [...this.deps.index.renames]) {
			if (this.deps.stopped()) return;
			try {
				const res = await client.rename(rename.from, rename.to, rename.base_rev);
				this.deps.index.clearRename(rename);
				const moved = this.deps.index.get(rename.to);
				this.deps.index.set(rename.to, {
					base_rev: res.rev,
					base_hash: res.hash || (moved?.base_hash ?? ""),
					plain_hash: moved?.plain_hash,
					local_hash: moved?.local_hash ?? "",
					mtime: Date.now(),
					dirty: moved?.dirty ?? false,
				});
				this.trace(`rename sent ${rename.from} -> ${rename.to}`);
				this.deps.index.remove(rename.from);
				report.renamed++;
			} catch (e) {
				// A conflicting or impossible move degrades to an ordinary upload of the
				// new path. Nothing is lost, the file just arrives without its history.
				this.deps.index.clearRename(rename);
				this.deps.log(`rename ${rename.from} -> ${rename.to}`, e);
			}
		}
	}

	private async push(client: SyncClient, report: SyncReport): Promise<void> {
		const adapter = this.deps.app.vault.adapter;

		// Counted before anything is sent, so the first sync of a large vault can say
		// how far along it is rather than only that it is moving.
		const pending = this.deps.index
			.paths()
			.filter((path) => {
				const entry = this.deps.index.get(path);
				return entry !== undefined && !entry.folder && entry.dirty === true && !this.isExcluded(path);
			})
			// Notes first, attachments last. The other device receives in this order,
			// so on a vault of a thousand notes and a gigabyte of PDFs every note is
			// readable there within the first minute, while the PDFs are still coming.
			// That minute is where somebody decides whether this works.
			.sort((a, b) => weight(a) - weight(b) || a.localeCompare(b));
		let done = 0;
		let next = 0;
		let lastCheckpoint = Date.now();

		const one = async (path: string): Promise<void> => {
			const entry = this.deps.index.get(path);
			if (!entry) return;
			const started = Date.now();
			try {
				// A directory that an earlier version recorded as a file. Reading it
				// fails every pass and says so, once per folder, forever.
				if (this.isFolder(path)) {
					this.deps.index.remove(path);
					report.skipped++;
					return;
				}
				if (!(await adapter.exists(path))) {
					// Never uploaded, now gone. The server has nothing to forget.
					if (entry.base_rev === 0) {
						this.deps.index.remove(path);
						report.skipped++;
						return;
					}
					await this.pushDeletion(client, path, entry.base_rev, report);
					return;
				}
				const data = await adapter.readBinary(path);
				const read = Date.now();
				const hash = await sha256(data);
				const hashed = Date.now();
				if (hash === entry.plain_hash) {
					// Changed and changed back. Nothing to send.
					this.deps.index.set(path, { ...entry, local_hash: hash, dirty: false });
					report.skipped++;
					return;
				}
				await this.upload(client, path, data, hash, entry.base_rev, report);
				const sent = Date.now();
				this.trace(
					`sent ${path} in ${sent - started}ms ` +
						`(read ${read - started}, hash ${hashed - read}, put ${sent - hashed}, ${data.byteLength} bytes)`,
				);
			} catch (e) {
				report.errors.push(`${path}: ${describe(e)}`);
				this.deps.log(`push ${path}`, e);
			}
		};

		// A few files in flight at once. Each upload spends most of its time waiting
		// on the network, and a vault of small notes sent strictly one after another
		// ran at one file per round trip. The index is checkpointed on a clock rather
		// than per file: a kill mid-batch loses at most two seconds of bookkeeping,
		// and every file it forgets is simply sent again.
		const worker = async (): Promise<void> => {
			while (next < pending.length && !this.deps.stopped()) {
				const path = pending[next++] as string;
				await one(path);
				done++;
				this.deps.onProgress?.(done, pending.length, path);
				if (Date.now() - lastCheckpoint > 2000) {
					lastCheckpoint = Date.now();
					await this.deps.index.save();
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(4, pending.length) }, worker));
		if (pending.length > 0) await this.deps.index.save();
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
			await this.send(client, path, baseRev, data, hash);
			report.uploaded++;
		} catch (e) {
			if (!(e instanceof ConflictError)) throw e;
			await this.reconcile(client, path, data, e.serverRev, baseRev, report, e.serverDevice);
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
			if (e instanceof ApiError && e.status === 404) {
				// Already gone on the server, or never there. Either way the index is
				// the thing that is wrong, and holding the entry would repeat this
				// failure on every pass forever.
				this.deps.index.remove(path);
				report.skipped++;
				return;
			}
			if (!(e instanceof ConflictError)) throw e;
			// Deleted here, edited there. The edit wins: bring the file back.
			const got = await this.fetch(client, path);
			await this.write(path, got.plain);
			this.deps.index.set(path, {
				base_rev: got.rev,
				base_hash: got.cipherHash,
				plain_hash: got.plainHash,
				local_hash: got.plainHash,
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
		serverRev: number,
		baseRev: number,
		report: SyncReport,
		serverDevice = "",
	): Promise<void> {
		const fetched = await this.fetch(client, path, serverRev);
		const server = {
			data: fetched.plain,
			rev: serverRev,
			hash: fetched.cipherHash,
			plainHash: fetched.plainHash,
		};
		const localText = decodeText(localData);
		const serverText = decodeText(server.data);

		if (
			localText === null ||
			serverText === null ||
			localData.byteLength > MERGE_SIZE_LIMIT ||
			server.data.byteLength > MERGE_SIZE_LIMIT
		) {
			await this.keepBothWithoutMerging(path, localData, server, report, baseRev, false, serverDevice);
			return;
		}

		let baseText = "";
		if (baseRev > 0) {
			try {
				baseText = decodeText((await this.fetch(client, path, baseRev)).plain) ?? "";
			} catch (e) {
				// The ancestor is gone, most likely collected. Without it a merge would be
				// guesswork, so both versions are kept instead.
				if (!(e instanceof ApiError)) throw e;
				await this.keepBothWithoutMerging(path, localData, server, report, baseRev, false, serverDevice);
				return;
			}
		}

		const merged = merge3(baseText, localText, serverText, this.deviceName(), "server");

		if (merged.clean) {
			const data = encodeText(merged.text);
			await this.write(path, data);
			await this.send(client, path, serverRev, data, await sha256(data));
			report.merged++;
			return;
		}

		// Overlapping edits. Nothing is merged into the note itself: a note is read by
		// a person, and conflict markers make it unreadable. Both whole versions stay
		// on disk, the server one under the real name and this device's one alongside,
		// and the choice is left to whoever wrote them.
		await this.keepBothWithoutMerging(path, localData, server, report, baseRev, true, serverDevice);
	}

	/**
	 * Keep both versions whole and record that somebody has to choose.
	 *
	 * Used for overlapping edits, for binary content, and for text too large to merge
	 * line by line. In every case the rule is the same: two files on disk, no merged
	 * text in the note, and a decision left to a person.
	 */
	private async keepBothWithoutMerging(
		path: string,
		localData: ArrayBuffer,
		server: { data: ArrayBuffer; rev: number; hash: string; plainHash?: string },
		report: SyncReport,
		baseRev = 0,
		mergeable = false,
		serverDevice = "",
	): Promise<void> {
		const copy = conflictName(path, this.deviceName(), new Date());
		await this.write(copy, localData);
		await this.write(path, server.data);
		this.deps.index.set(path, {
			base_rev: server.rev,
			base_hash: server.hash,
			plain_hash: server.plainHash,
			local_hash: server.plainHash ?? "",
			mtime: Date.now(),
		});
		// The copy is deliberately not tracked. It exists for the person, not for the
		// sync, and uploading it would spread one device's confusion to every other.
		this.deps.index.remove(copy);
		this.deps.index.addConflict({
			path,
			copy,
			device: this.deviceName(),
			server_device: serverDevice,
			at: Date.now(),
			base_rev: baseRev,
			server_rev: server.rev,
			mergeable,
		});
		report.conflicts++;
		this.deps.onConflict(path, copy);
	}

	/** What can still be brought back. */
	async deletedFiles() {
		const client = this.deps.client();
		return client ? client.deleted() : [];
	}

	/**
	 * Bring a deleted file back.
	 *
	 * The content is fetched from the last revision that had any, written to the
	 * vault, and sent up as a new revision on top of the tombstone. Other devices
	 * then see an ordinary edit, which is exactly what this is.
	 */
	async restore(path: string, tombstoneRev: number, contentRev: number): Promise<void> {
		const client = this.deps.client();
		if (!client) throw new Error("not configured");
		const barrier = await this.deps.guard(true);
		if (barrier) throw new Error(barrier);
		if (await this.deps.app.vault.adapter.exists(path)) {
			throw new Error("a file already exists at that path");
		}
		const got = await this.fetch(client, path, contentRev);
		await this.write(path, got.plain);
		await this.send(client, path, tombstoneRev, got.plain, got.plainHash);
		await this.deps.index.save();
	}

	deviceName(): string {
		return this.deps.settings.deviceName || defaultDeviceName();
	}

	/**
	 * Apply a person's decision about a conflict.
	 *
	 * "mine" sends this device's version up as a new revision. "server" simply drops
	 * the copy. "merged" writes the three-way merge with its markers into the note so
	 * the two texts can be reconciled by hand in one place.
	 */
	async resolveConflict(path: string, choice: "mine" | "server" | "merged"): Promise<void> {
		const client = this.deps.client();
		const pending = this.deps.index.conflicts.find((c) => c.path === path);
		if (!client || !pending) return;
		// Writes outside a pass answer to the same barrier as the pass itself.
		const barrier = await this.deps.guard(true);
		if (barrier) throw new Error(barrier);
		const adapter = this.deps.app.vault.adapter;

		if (choice === "server") {
			if (await adapter.exists(pending.copy)) await adapter.remove(pending.copy);
			this.deps.index.clearConflict(path);
			await this.deps.index.save();
			return;
		}

		if (!(await adapter.exists(pending.copy))) {
			// Gone since the question was asked. Nothing to choose between any more.
			this.deps.index.clearConflict(path);
			await this.deps.index.save();
			throw new Error("that version was deleted, so there is nothing left to keep");
		}
		const mine = await adapter.readBinary(pending.copy);
		let data = mine;

		if (choice === "merged") {
			if (!pending.mergeable) throw new Error("this file cannot be merged line by line");
			const server = await adapter.readBinary(path);
			const mineText = decodeText(mine);
			const serverText = decodeText(server);
			if (mineText === null || serverText === null) return; // binary: nothing to merge
			let baseText = "";
			if (pending.base_rev > 0) {
				try {
					baseText = decodeText((await this.fetch(client, path, pending.base_rev)).plain) ?? "";
				} catch {
					baseText = "";
				}
			}
			data = encodeText(
				merge3(baseText, mineText, serverText, pending.device, "server").text,
			);
		}

		await this.write(path, data);
		const entry = this.deps.index.get(path);
		await this.send(client, path, entry?.base_rev ?? pending.server_rev, data, await sha256(data));
		if (await adapter.exists(pending.copy)) await adapter.remove(pending.copy);
		this.deps.index.clearConflict(path);
		await this.deps.index.save();
	}
}

/** Sort key for the first sync: text before everything else, big binaries last. */
function weight(path: string): number {
	const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
	if (ext === "md" || ext === "canvas" || ext === "txt" || ext === "json") return 0;
	if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "gif" || ext === "svg") return 1;
	return 2;
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
	);
}
