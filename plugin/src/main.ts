// SPDX-License-Identifier: MIT

import { Notice, Plugin, normalizePath } from "obsidian";
import { SyncClient, ApiError, type ChangeEntry } from "./api";
import { LocalIndex } from "./index-store";
import { conflictName, sha256, toNFC } from "./paths";
import { DEFAULT_SETTINGS, SyncSettingsTab, type SyncSettings } from "./settings";
import { t } from "./i18n";

/**
 * M0: settings, a connection check and a one-way download from the server.
 *
 * Two-way sync, vault watching and conflict merging arrive in M1. Until then the
 * plugin deliberately cannot write to the server, so unfinished sync logic never
 * touches a live vault.
 */
export default class LockstepPlugin extends Plugin {
	override settings: SyncSettings = { ...DEFAULT_SETTINGS };
	index!: LocalIndex;
	private statusBar: HTMLElement | null = null;
	private lastStatus = t("status.notConnected");

	override async onload(): Promise<void> {
		await this.loadSettings();

		const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		this.index = new LocalIndex(this.app.vault.adapter, dir);
		await this.index.load();

		this.addSettingTab(new SyncSettingsTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus(t("status.index", { files: this.index.size, seq: this.index.lastSeq }));

		this.addCommand({
			id: "test-connection",
			name: t("cmd.test"),
			callback: () => void this.testConnection(),
		});
		this.addCommand({
			id: "pull-all",
			name: t("cmd.pull"),
			callback: () => void this.pullAll(),
		});
	}

	override async onunload(): Promise<void> {
		await this.index.save();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	statusLine(): string {
		return this.lastStatus;
	}

	private setStatus(text: string): void {
		this.lastStatus = text;
		this.statusBar?.setText(`${t("status.prefix")}: ${text}`);
	}

	private client(): SyncClient | null {
		if (!this.settings.serverUrl || !this.settings.token) {
			new Notice(t("notice.noConfig"));
			return null;
		}
		return new SyncClient(this.settings.serverUrl, this.settings.token);
	}

	private isExcluded(path: string): boolean {
		return this.settings.excludes.some((p) => path === p || path.startsWith(p));
	}

	async testConnection(): Promise<void> {
		const client = this.client();
		if (!client) return;
		try {
			await client.health();
			const stats = await client.stats();
			const line = t("status.stats", {
				vault: String(stats["vault"]),
				files: String(stats["files"]),
				seq: String(stats["seq"]),
			});
			this.setStatus(line);
			new Notice(t("notice.connected", { info: line }));
		} catch (e) {
			this.reportError(t("error.testConnection"), e);
		}
	}

	async resetIndex(): Promise<void> {
		this.index.reset();
		await this.index.save();
		this.setStatus(t("status.indexReset"));
	}

	/**
	 * Pulls the vault state from the server.
	 *
	 * The vault rule: nothing is overwritten silently. If a local file differs
	 * from the server's, the local version is copied aside first — losing a note
	 * is worse than seeing one extra file.
	 */
	async pullAll(): Promise<void> {
		const client = this.client();
		if (!client) return;

		let since = 0;
		let downloaded = 0;
		let kept = 0;
		let skipped = 0;
		const started = Date.now();
		new Notice(t("notice.pullStarted"));

		try {
			for (;;) {
				const page = await client.changes(since, 200);
				for (const entry of page.entries) {
					const path = toNFC(entry.path);
					if (this.isExcluded(path)) {
						skipped++;
						continue;
					}
					const result = await this.applyRemote(client, entry, path);
					if (result === "downloaded") downloaded++;
					else if (result === "conflict-copy") {
						downloaded++;
						kept++;
					} else skipped++;

					// Checkpoint after every file: the app can die right here.
					this.index.setLastSeq(entry.seq);
					await this.index.save();
				}
				since = page.next_seq;
				this.index.setLastSeq(since);
				if (!page.has_more) break;
			}
			await this.index.save();

			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const line = t("status.pullSummary", { downloaded, skipped, kept, secs });
			this.setStatus(line);
			new Notice(t("notice.pullDone", { summary: line }));
		} catch (e) {
			await this.index.save();
			this.reportError(t("error.pull"), e);
		}
	}

	private async applyRemote(
		client: SyncClient,
		entry: ChangeEntry,
		path: string,
	): Promise<"downloaded" | "conflict-copy" | "skipped"> {
		const adapter = this.app.vault.adapter;

		if (entry.folder) {
			if (!(await adapter.exists(path))) await adapter.mkdir(path);
			this.index.set(path, {
				base_rev: entry.rev,
				base_hash: "",
				local_hash: "",
				mtime: entry.mtime,
				folder: true,
			});
			return "downloaded";
		}

		if (entry.deleted) {
			// M0 deliberately does NOT delete local files: a one-way download must not
			// be able to erase a vault. Deletions arrive in M1 with the full index.
			this.index.remove(path);
			return "skipped";
		}

		if (await adapter.exists(path)) {
			const local = await adapter.readBinary(path);
			const localHash = await sha256(local);
			if (localHash === entry.hash) {
				this.index.set(path, {
					base_rev: entry.rev,
					base_hash: entry.hash ?? "",
					local_hash: localHash,
					mtime: entry.mtime,
				});
				return "skipped";
			}
			// They differ — keep the local version aside before writing the server's.
			const backup = conflictName(path, this.deviceLabel(), new Date());
			await adapter.writeBinary(backup, local);
			await this.writeFromServer(client, entry, path);
			return "conflict-copy";
		}

		await this.ensureParent(path);
		await this.writeFromServer(client, entry, path);
		return "downloaded";
	}

	private async writeFromServer(client: SyncClient, entry: ChangeEntry, path: string): Promise<void> {
		const { data, hash } = await client.getFile(path, entry.rev);
		const actual = await sha256(data);
		if (entry.hash && actual !== entry.hash) {
			throw new Error(
				t("error.corruptDownload", { path, want: entry.hash ?? "", got: actual }),
			);
		}
		await this.app.vault.adapter.writeBinary(path, data);
		this.index.set(path, {
			base_rev: entry.rev,
			base_hash: hash || actual,
			local_hash: actual,
			mtime: entry.mtime,
		});
	}

	private async ensureParent(path: string): Promise<void> {
		const slash = path.lastIndexOf("/");
		if (slash <= 0) return;
		const dir = path.slice(0, slash);
		if (!(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.adapter.mkdir(dir);
		}
	}

	private deviceLabel(): string {
		return this.settings.deviceName || t("conflict.label");
	}

	private reportError(what: string, e: unknown): void {
		const msg =
			e instanceof ApiError
				? `${e.status} ${e.kind}: ${e.message}`
				: e instanceof Error
					? e.message
					: String(e);
		console.error(`[lockstep-sync] ${what}:`, e);
		this.setStatus(t("status.error", { message: msg }));
		new Notice(t("notice.error", { what, message: msg }), 8000);
	}
}
