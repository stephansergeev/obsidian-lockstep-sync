// SPDX-License-Identifier: MIT

import { Notice, Plugin, TAbstractFile, normalizePath } from "obsidian";
import { ApiError, SyncClient, type ChangeEntry } from "./api";
import { ConflictModal } from "./conflict-modal";
import {
	VaultCipher,
	WrongPassphrase,
	plaintext,
	type Cipher,
	type VaultKeyParams,
} from "./crypto";
import { t } from "./i18n";
import { LocalIndex } from "./index-store";
import { conflictName, sha256, toNFC } from "./paths";
import { SyncEngine, type SyncReport } from "./sync-engine";
import { DEFAULT_SETTINGS, SyncSettingsTab, type SyncSettings } from "./settings";

/** How long to wait after the last edit before syncing. Obsidian fires on every keystroke. */
const DEBOUNCE_MS = 2500;

export default class LockstepPlugin extends Plugin {
	override settings: SyncSettings = { ...DEFAULT_SETTINGS };
	index!: LocalIndex;
	private engine!: SyncEngine;
	private statusBar: HTMLElement | null = null;
	private lastStatus = t("status.notConnected");
	private debounce: ReturnType<typeof setTimeout> | null = null;
	private cipher: Cipher = plaintext;
	private cipherStatus = "";
	/**
	 * Encryption is switched on but the key is not available.
	 *
	 * Syncing has to stop here rather than fall back to plaintext. Falling back would
	 * publish to the server exactly the notes this setting exists to hide, and it
	 * would do it quietly.
	 */
	private locked = false;
	private interval: number | null = null;

	override async onload(): Promise<void> {
		await this.loadSettings();

		const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		this.index = new LocalIndex(this.app.vault.adapter, dir);
		await this.index.load();

		this.engine = new SyncEngine({
			app: this.app,
			index: this.index,
			settings: this.settings,
			client: () => this.client(false),
			cipher: () => this.cipher,
			onConflict: (path) => new Notice(t("notice.conflictQueued", { path }), 12000),
			log: (message, error) => console.warn(`[lockstep-sync] ${message}`, error ?? ""),
		});

		this.addSettingTab(new SyncSettingsTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus(t("status.index", { files: this.index.size, seq: this.index.lastSeq }));

		this.addCommand({ id: "sync-now", name: t("cmd.sync"), callback: () => void this.syncNow() });
		this.addCommand({
			id: "test-connection",
			name: t("cmd.test"),
			callback: () => void this.testConnection(),
		});
		this.addCommand({ id: "pull-all", name: t("cmd.pull"), callback: () => void this.pullAll() });
		this.addCommand({
			id: "benchmark-kdf",
			name: t("cmd.benchmark"),
			callback: () => void this.runBenchmark(),
		});
		this.addCommand({
			id: "resolve-conflicts",
			name: t("cmd.conflicts"),
			callback: () => this.openConflicts(),
		});

		// The status bar is the only place a pending decision is visible on mobile,
		// where a notice from a background pass is long gone by the time the app is
		// opened again. Clicking it opens the list.
		this.statusBar?.addEventListener("click", () => this.openConflicts());

		// The vault is only watched once the workspace is ready. Obsidian replays the
		// whole tree as create events while it starts, and treating those as edits
		// would mark every file dirty on every launch.
		this.app.workspace.onLayoutReady(() => {
			void this.applyEncryption();
			this.registerVaultEvents();
			this.restartAutoSync();
			if (this.settings.autoSync) void this.syncNow(true);
		});

		// Mobile kills the app in the background, so the queue is flushed on the way out.
		this.registerDomEvent(window, "blur", () => void this.flush());
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.hidden) void this.flush();
		});
	}

	override async onunload(): Promise<void> {
		if (this.debounce) clearTimeout(this.debounce);
		await this.index.save();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.engine?.updateSettings(this.settings);
	}

	statusLine(): string {
		return this.lastStatus;
	}

	encryptionStatus(): string {
		return this.cipherStatus || t("encryption.locked");
	}

	/**
	 * Bring encryption into the state the settings ask for.
	 *
	 * The key parameters live on the server, so the first device to enable encryption
	 * writes them and every other device reads them and checks the passphrase against
	 * them. That is what makes a second device able to join knowing only the words.
	 */
	async applyEncryption(): Promise<void> {
		if (!this.settings.encryption) {
			this.cipher = plaintext;
			this.locked = false;
			this.cipherStatus = t("encryption.off");
			return;
		}
		if (!this.settings.passphrase) {
			this.cipher = plaintext;
			this.locked = true;
			this.cipherStatus = t("encryption.locked");
			return;
		}
		const client = this.client(false);
		if (!client) return;
		try {
			const stored = (await client.getVaultKey()) as VaultKeyParams | null;
			if (stored) {
				this.cipher = await VaultCipher.unlock(this.settings.passphrase, stored);
				this.locked = false;
				this.cipherStatus = t("encryption.ready");
			} else {
				const { cipher, params } = await VaultCipher.create(this.settings.passphrase);
				await client.putVaultKey(params);
				this.cipher = cipher;
				this.locked = false;
				this.cipherStatus = t("encryption.created");
				new Notice(t("encryption.created"), 10000);
			}
		} catch (e) {
			// A wrong passphrase must never fall back to writing plaintext: that would
			// quietly publish the notes this setting exists to hide.
			this.cipher = plaintext;
			this.locked = true;
			this.cipherStatus =
				e instanceof WrongPassphrase
					? t("encryption.wrong")
					: t("encryption.failed", { message: e instanceof Error ? e.message : String(e) });
			new Notice(`Lockstep: ${this.cipherStatus}`, 10000);
			throw e;
		}
	}

	openConflicts(): void {
		new ConflictModal(
			this.app,
			() => this.index.conflicts,
			async (path, choice) => {
				await this.engine.resolveConflict(path, choice);
				this.setStatus(this.lastStatus);
			},
		).open();
	}

	private setStatus(text: string): void {
		this.lastStatus = text;
		const pending = this.index?.conflicts.length ?? 0;
		const suffix = pending > 0 ? ` · ${t("conflict.pending", { count: pending })}` : "";
		this.statusBar?.setText(`${t("status.prefix")}: ${text}${suffix}`);
	}

	private client(complain = true): SyncClient | null {
		if (!this.settings.serverUrl || !this.settings.token) {
			if (complain) new Notice(t("notice.noConfig"));
			return null;
		}
		return new SyncClient(this.settings.serverUrl, this.settings.token);
	}

	// --- watching the vault ---------------------------------------------------

	private registerVaultEvents(): void {
		const mark = (file: TAbstractFile) => this.markDirty(file.path);
		this.registerEvent(this.app.vault.on("create", mark));
		this.registerEvent(this.app.vault.on("modify", mark));
		this.registerEvent(this.app.vault.on("delete", mark));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => this.onRename(file.path, oldPath)),
		);
	}

	private markDirty(rawPath: string): void {
		const path = toNFC(rawPath);
		if (this.engine.isSuppressed(path) || this.engine.isExcluded(path)) return;
		const known = this.index.get(path);

		// A path the server has never seen, disappearing. There is nothing to report:
		// a conflict copy deleted by hand used to end up here, and the plugin would
		// spend every pass telling the server to delete a file it never had.
		if (!known && !this.app.vault.getAbstractFileByPath(path)) return;

		this.index.set(path, {
			base_rev: known?.base_rev ?? 0,
			base_hash: known?.base_hash ?? "",
			local_hash: known?.local_hash ?? "",
			mtime: Date.now(),
			dirty: true,
		});
		this.scheduleSync();
	}

	private onRename(rawTo: string, rawFrom: string): void {
		const to = toNFC(rawTo);
		const from = toNFC(rawFrom);
		if (this.engine.isSuppressed(to) || this.engine.isSuppressed(from)) return;
		if (this.engine.isExcluded(to) || this.engine.isExcluded(from)) return;

		const known = this.index.get(from);
		if (known && known.base_rev > 0) {
			this.index.queueRename({ from, to, base_rev: known.base_rev });
			this.index.set(to, { ...known, mtime: Date.now(), dirty: known.dirty ?? false });
			this.index.remove(from);
		} else {
			// The server has never seen this file, so there is nothing to move. It goes
			// up as an ordinary new file under its new name.
			this.markDirty(to);
		}
		this.scheduleSync();
	}

	private scheduleSync(): void {
		if (!this.settings.autoSync) return;
		if (this.debounce) clearTimeout(this.debounce);
		this.debounce = setTimeout(() => void this.syncNow(true), DEBOUNCE_MS);
	}

	restartAutoSync(): void {
		if (this.interval !== null) {
			window.clearInterval(this.interval);
			this.interval = null;
		}
		if (!this.settings.autoSync) return;
		const ms = Math.max(15, this.settings.intervalSeconds) * 1000;
		this.interval = window.setInterval(() => void this.syncNow(true), ms);
		this.registerInterval(this.interval);
	}

	/** Force a pass right now, used when the app is about to be suspended. */
	private async flush(): Promise<void> {
		if (!this.settings.autoSync) return;
		if (this.debounce) {
			clearTimeout(this.debounce);
			this.debounce = null;
		}
		await this.syncNow(true);
	}

	// --- the operations -------------------------------------------------------

	async syncNow(quiet = false): Promise<void> {
		if (!this.client(!quiet)) return;
		if (this.blocked(quiet)) return;
		if (this.engine.busy) return;
		const started = Date.now();
		this.setStatus(t("status.syncing"));
		if (!quiet) new Notice(t("notice.syncing"));
		try {
			const report = await this.engine.sync();
			const secs = ((Date.now() - started) / 1000).toFixed(1);
			this.report(report, secs, quiet);
			if (this.engine.takeQueued()) this.scheduleSync();
		} catch (e) {
			this.reportError(t("error.sync"), e);
		}
	}

	private report(report: SyncReport, secs: string, quiet: boolean): void {
		const touched =
			report.downloaded + report.uploaded + report.merged + report.conflicts + report.deleted;
		const line =
			touched === 0
				? t("status.upToDate", { seq: this.index.lastSeq })
				: t("status.syncSummary", {
						secs,
						downloaded: report.downloaded,
						uploaded: report.uploaded,
						merged: report.merged,
						conflicts: report.conflicts,
					});
		this.setStatus(line);
		if (!quiet || report.conflicts > 0) new Notice(t("notice.syncDone", { summary: line }));
		for (const err of report.errors.slice(0, 3)) {
			new Notice(t("notice.error", { what: t("error.sync"), message: err }), 8000);
		}
	}

	/** True when encryption is on and the vault is not open. Nothing may move. */
	private blocked(quiet: boolean): boolean {
		if (!this.locked) return false;
		this.setStatus(this.cipherStatus);
		if (!quiet) new Notice(`Lockstep: ${this.cipherStatus}`, 8000);
		return true;
	}

	/** Measure key derivation here, on this device, instead of guessing. */
	async runBenchmark(): Promise<void> {
		new Notice(t("notice.benchmarking"), 5000);
		const { benchmarkKdf, reportBenchmark } = await import("./kdf-benchmark");
		try {
			reportBenchmark(await benchmarkKdf());
		} catch (e) {
			this.reportError(t("cmd.benchmark"), e);
		}
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
	 * Take the whole vault from the server without sending anything back.
	 *
	 * Kept as a separate operation from the sync: it is what you run on a new device,
	 * and it never deletes a local file. Anything that differs is copied aside first.
	 */
	async pullAll(): Promise<void> {
		const client = this.client();
		if (!client) return;
		if (this.blocked(false)) return;
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
					if (this.engine.isExcluded(path)) {
						skipped++;
						continue;
					}
					const result = await this.applyOneWay(client, entry, path);
					if (result === "downloaded") downloaded++;
					else if (result === "conflict-copy") {
						downloaded++;
						kept++;
					} else skipped++;
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

	private async applyOneWay(
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
			// A one-way download must never be able to erase a vault.
			this.index.remove(path);
			return "skipped";
		}

		if (await adapter.exists(path)) {
			const local = await adapter.readBinary(path);
			const localHash = await sha256(local);
			const known = this.index.get(path);
			if (known?.plain_hash === localHash && known.base_hash === entry.hash) {
				this.index.set(path, { ...known, base_rev: entry.rev, mtime: entry.mtime });
				return "skipped";
			}
			const backup = conflictName(path, this.settings.deviceName || t("conflict.label"), new Date());
			await adapter.writeBinary(backup, local);
			await this.writeFromServer(client, entry, path);
			return "conflict-copy";
		}

		await this.writeFromServer(client, entry, path);
		return "downloaded";
	}

	private async writeFromServer(
		client: SyncClient,
		entry: ChangeEntry,
		path: string,
	): Promise<void> {
		const { data, hash } = await client.getFile(path, entry.rev);
		const actual = await sha256(data);
		if (entry.hash && actual !== entry.hash) {
			throw new Error(
				t("error.corruptDownload", { path, want: entry.hash ?? "", got: actual }),
			);
		}
		const plain = await this.cipher.decrypt(data);
		const plainHash = await sha256(plain);
		const slash = path.lastIndexOf("/");
		if (slash > 0) {
			const dir = path.slice(0, slash);
			if (!(await this.app.vault.adapter.exists(dir))) {
				await this.app.vault.adapter.mkdir(dir);
			}
		}
		await this.app.vault.adapter.writeBinary(path, plain);
		this.index.set(path, {
			base_rev: entry.rev,
			base_hash: hash || actual,
			plain_hash: plainHash,
			local_hash: plainHash,
			mtime: entry.mtime,
		});
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
