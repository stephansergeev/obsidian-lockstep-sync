// SPDX-License-Identifier: MIT

import { Notice, Plugin, TAbstractFile, TFile, normalizePath } from "obsidian";
import { ApiError, SyncClient, type ChangeEntry } from "./api";
import { ConflictModal } from "./conflict-modal";
import { showConflictNotice } from "./conflict-notice";
import { RestoreModal } from "./restore-modal";
import { AddDeviceModal } from "./onboarding";
import {
	VaultCipher,
	WrongPassphrase,
	plaintext,
	type Cipher,
	type PathCipher,
	type VaultKeyParams,
} from "./crypto";
import { t } from "./i18n";
import { LocalIndex } from "./index-store";
import { conflictName, defaultDeviceName, sha256, toNFC } from "./paths";
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
	private pathCipher: PathCipher | null = null;
	private cipherStatus = "";
	/**
	 * Encryption is switched on but the key is not available.
	 *
	 * Syncing has to stop here rather than fall back to plaintext. Falling back would
	 * publish to the server exactly the notes this setting exists to hide, and it
	 * would do it quietly.
	 */
	private locked = false;
	/** Said once, not on every pass. */
	private announcedEncryptedVault = false;
	/** A server that cannot be reached says so once, not once a minute. */
	private announcedUnreachable = false;
	private focusPassphrase = false;
	/** Which vault on the server this device is bound to, as the server names it. */
	private serverVault = "";
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
			guard: () => this.reasonNotToSync(),
			onConflict: (path) => {
				// Ask right here rather than sending anybody to a settings screen. The
				// same conflict also stays in the list, so ignoring the notice costs
				// nothing.
				const pending = this.index.conflicts.find((c) => c.path === path);
				if (pending) {
					showConflictNotice(pending, (choice) => this.resolveConflict(path, choice));
				} else {
					new Notice(t("notice.conflictQueued", { path }), 12000);
				}
			},
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
		// A link that sets up another device. Registered before anything else, so a
		// device that has just been installed can be configured by opening one.
		this.registerObsidianProtocolHandler("lockstep-setup", (params) => {
			void this.applySetupLink(params);
		});

		this.addCommand({
			id: "add-device",
			name: t("cmd.addDevice"),
			callback: () => this.openAddDevice(),
		});
		this.addCommand({
			id: "restore-deleted",
			name: t("cmd.restore"),
			callback: () => this.openRestore(),
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
			// If this fails because the network is not up yet, the next pass retries.
			void this.applyEncryption().catch(() => {});
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
		// Named for what this device is, so nobody has to correct an assumption about
		// what they own before they can start. Whatever they type instead wins.
		if (!this.settings.deviceName) {
			this.settings.deviceName = defaultDeviceName();
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.engine?.updateSettings(this.settings);
	}

	statusLine(): string {
		return this.lastStatus;
	}

	/**
	 * The vault this device syncs with, by the name the server knows.
	 *
	 * What a vault is called in Obsidian is local to the device and travels nowhere.
	 * The binding is the token, and until this was shown the only way to know which
	 * vault a token opened was to press a button and read a notice.
	 */
	serverVaultName(): string {
		return this.serverVault;
	}

	async refreshServerVault(): Promise<void> {
		const client = this.client(false);
		if (!client) {
			this.serverVault = "";
			return;
		}
		try {
			const stats = await client.stats();
			this.serverVault = String(stats["vault"] ?? "");
		} catch {
			this.serverVault = "";
		}
	}

	encryptionStatus(): string {
		return this.cipherStatus || t("encryption.locked");
	}

	/** True when names are hidden too, not only content. */
	hidesNames(): boolean {
		return this.pathCipher !== null;
	}

	/** True when the vault is open and uploads are actually being encrypted. */
	encryptionReady(): boolean {
		return this.settings.encryption && !this.locked;
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
			this.pathCipher = null;
			this.locked = false;
			this.cipherStatus = t("encryption.off");
			return;
		}
		if (!this.settings.passphrase) {
			this.cipher = plaintext;
			this.pathCipher = null;
			this.locked = true;
			this.cipherStatus = t("encryption.locked");
			return;
		}
		const client = this.client(false);
		if (!client) return;
		try {
			const stored = (await client.getVaultKey()) as VaultKeyParams | null;
			if (stored) {
				const cipher = await VaultCipher.unlock(this.settings.passphrase, stored);
				this.cipher = cipher;
				this.pathCipher = stored.paths === "encrypted" ? await cipher.pathCipher() : null;
				this.locked = false;
				this.announcedEncryptedVault = false;
				this.cipherStatus = t(
					this.pathCipher ? "encryption.readyWithPaths" : "encryption.ready",
				);
				// Whether a vault is actually hidden is the one thing somebody turning
				// this on wants confirmed. A grey caption under a text field is not a
				// confirmation.
				new Notice(`Lockstep: ${this.cipherStatus}`, 8000);
			} else {
				// Names can only be hidden in a vault that starts empty. Everything
				// already on the server is stored under a readable path, and a vault
				// cannot hold both kinds: the client would upload every existing file a
				// second time under its hidden name and leave the first copy behind.
				const stats = await client.stats();
				const occupied = Number(stats["files"] ?? 0) + Number(stats["folders"] ?? 0) > 0;
				const { cipher, params } = await VaultCipher.create(this.settings.passphrase, {
					paths: occupied ? "plain" : "encrypted",
				});
				await client.putVaultKey(params);
				this.cipher = cipher;
				this.pathCipher = params.paths === "encrypted" ? await cipher.pathCipher() : null;
				this.locked = false;
				this.announcedEncryptedVault = false;
				this.cipherStatus = t("encryption.created");
				new Notice(t("encryption.created"), 10000);
				if (occupied) new Notice(t("encryption.namesStayVisible"), 15000);
			}
		} catch (e) {
			// A wrong passphrase must never fall back to writing plaintext: that would
			// quietly publish the notes this setting exists to hide.
			this.cipher = plaintext;
			this.pathCipher = null;
			this.locked = true;
			this.cipherStatus =
				e instanceof WrongPassphrase
					? t("encryption.wrong")
					: t("encryption.failed", { message: e instanceof Error ? e.message : String(e) });
			new Notice(`Lockstep: ${this.cipherStatus}`, 10000);
			throw e;
		}
	}

	async getRetention(): Promise<number> {
		const client = this.client(false);
		return client ? client.getRetention() : 30;
	}

	async setRetention(days: number): Promise<void> {
		const client = this.client();
		if (!client) throw new Error("not configured");
		await client.setRetention(days);
	}

	/** Drop questions that no longer have two answers. */
	async pruneConflicts(): Promise<void> {
		await this.engine.pruneConflicts();
		this.setStatus(this.lastStatus);
	}

	/** Apply a decision about a conflict and refresh what the status bar shows. */
	async resolveConflict(path: string, choice: "mine" | "server" | "merged"): Promise<void> {
		await this.engine.resolveConflict(path, choice);
		this.setStatus(this.lastStatus);
	}

	/**
	 * Configure this device from a link somebody sent it.
	 *
	 * Everything except the passphrase, which is deliberately never in the link.
	 */
	private async applySetupLink(params: Record<string, string>): Promise<void> {
		const url = (params["url"] ?? "").trim();
		const token = (params["token"] ?? "").trim();
		if (!url || !token) {
			new Notice(t("add.linkBroken"), 8000);
			return;
		}
		this.settings.serverUrl = url;
		this.settings.token = token;
		this.announcedUnreachable = false;
		if (params["device"]) this.settings.deviceName = params["device"].trim();
		await this.saveSettings();
		await this.refreshServerVault();

		// An encrypted vault needs a passphrase before anything can happen, so the
		// switch is turned on for them and the cursor is put in the field. Telling
		// somebody to enter it "below" while they are looking at a note is not an
		// instruction, it is a riddle.
		let needsPassphrase = false;
		const client = this.client(false);
		if (client) {
			try {
				needsPassphrase = (await client.getVaultKey()) !== null;
			} catch {
				/* cannot tell yet; the next pass will */
			}
		}
		if (needsPassphrase && !this.settings.encryption) {
			this.settings.encryption = true;
			await this.saveSettings();
		}

		new Notice(
			needsPassphrase
				? t("add.linkAppliedEncrypted", { vault: this.serverVault || "?" })
				: t("add.linkApplied", { vault: this.serverVault || "?" }),
			10000,
		);
		this.openSettings(needsPassphrase);
		if (!needsPassphrase) void this.syncNow(true);
	}

	/**
	 * Open this plugin's own settings, optionally with the passphrase field focused.
	 *
	 * app.setting is not in the public typings, so it is reached through a narrow
	 * shape rather than a blanket cast, and nothing breaks if it is ever missing.
	 */
	private openSettings(focusPassphrase: boolean): void {
		this.focusPassphrase = focusPassphrase;
		const host = this.app as unknown as {
			setting?: { open?: () => void; openTabById?: (id: string) => void };
		};
		try {
			host.setting?.open?.();
			host.setting?.openTabById?.(this.manifest.id);
		} catch {
			/* an older or different host; the notice already said what to do */
		}
	}

	/** Set when the settings screen should put the cursor in the passphrase field. */
	takeFocusRequest(): boolean {
		const wanted = this.focusPassphrase;
		this.focusPassphrase = false;
		return wanted;
	}

	openAddDevice(): void {
		new AddDeviceModal(
			this.app,
			async (name) => {
				const client = this.client();
				if (!client) throw new Error("not configured");
				const issued = await client.issueToken(name);
				const url = encodeURIComponent(this.settings.serverUrl);
				const token = encodeURIComponent(issued.token);
				const device = encodeURIComponent(name);
				return `obsidian://lockstep-setup?url=${url}&token=${token}&device=${device}`;
			},
			this.settings.encryption,
			this.settings.serverUrl,
		).open();
	}

	openRestore(): void {
		new RestoreModal(
			this.app,
			() => this.engine.deletedFiles(),
			async (file) => {
				await this.engine.restore(file.path, file.rev, file.content_rev);
			},
		).open();
	}

	openConflicts(): void {
		void this.engine.pruneConflicts();
		new ConflictModal(
			this.app,
			() => this.index.conflicts,
			(path, choice) => this.resolveConflict(path, choice),
		).open();
	}

	private setStatus(text: string): void {
		this.lastStatus = text;
		const pending = this.index?.conflicts.length ?? 0;
		const parts = [`${t("status.prefix")}: ${text}`];
		// A word rather than a symbol: the state has to be readable at a glance, and
		// an icon makes somebody guess at what it is trying to say.
		if (this.settings.encryption) {
			parts.push(this.locked ? t("status.lockedShort") : t("status.encrypted"));
		}
		if (pending > 0) parts.push(t("conflict.pending", { count: pending }));
		this.statusBar?.setText(parts.join(" · "));
	}

	private client(complain = true): SyncClient | null {
		if (!this.settings.serverUrl || !this.settings.token) {
			if (complain) new Notice(t("notice.noConfig"));
			return null;
		}
		return new SyncClient(
			this.settings.serverUrl,
			this.settings.token,
			this.settings.deviceName,
			this.pathCipher,
		);
	}

	// --- watching the vault ---------------------------------------------------

	private registerVaultEvents(): void {
		// Folders are not sent. Obsidian raises the same events for them as for files,
		// and treating one as a file means trying to read a directory and upload it,
		// which fails once per folder and says so. Parents are created on the way in
		// when a file inside them arrives, so nothing is lost by ignoring them.
		const mark = (file: TAbstractFile) => {
			if (file instanceof TFile) this.markDirty(file.path);
		};
		this.registerEvent(this.app.vault.on("create", mark));
		this.registerEvent(this.app.vault.on("modify", mark));
		this.registerEvent(this.app.vault.on("delete", mark));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFile) this.onRename(file.path, oldPath);
			}),
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

	/**
	 * True when this looks like the server simply not being there.
	 *
	 * Worth separating from other failures: it is the one that repeats on every pass
	 * until something changes in the world, and repeating it every minute buries
	 * everything else the plugin has to say.
	 */
	private isUnreachable(message: string): boolean {
		return /could not connect|failed to fetch|network|ERR_|ENOTFOUND|ECONNREFUSED|timed out/i.test(
			message,
		);
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
		const unreachable = report.errors.filter((e) => this.isUnreachable(e));
		if (unreachable.length > 0) {
			if (!this.announcedUnreachable) {
				this.announcedUnreachable = true;
				new Notice(t("notice.unreachable", { url: this.settings.serverUrl }), 12000);
			}
			return;
		}
		this.announcedUnreachable = false;
		for (const err of report.errors.slice(0, 3)) {
			new Notice(t("notice.error", { what: t("error.sync"), message: err }), 8000);
		}
	}

	/**
	 * Why syncing must not happen, or empty when it may.
	 *
	 * The important case is a vault that is encrypted while this device is not set up
	 * for it. Reading it anyway produces filenames that are ciphertext and content
	 * that is noise, and the device then tries to create files with those names. Far
	 * better to notice, refuse, and say which of the two things is missing.
	 */
	private async reasonNotToSync(): Promise<string> {
		// The passphrase is already here. Unlocking is something to do, not something
		// to ask for again: the first attempt may simply have run before the network
		// was ready, and making somebody press a button to recover from that is
		// making them do the software's retry by hand.
		if (this.settings.encryption && this.settings.passphrase && !this.cipher.enabled) {
			try {
				await this.applyEncryption();
			} catch {
				// A wrong passphrase, and applyEncryption has already said so.
			}
		}
		if (this.locked) return this.cipherStatus;
		if (this.cipher.enabled) return "";

		const client = this.client(false);
		if (!client) return "";
		try {
			if (!(await client.getVaultKey())) return "";
		} catch {
			return ""; // cannot tell, and refusing on a network hiccup helps nobody
		}
		// The vault has a key and this device has none.
		this.locked = true;
		this.cipherStatus = t(
			this.settings.encryption ? "encryption.locked" : "encryption.vaultIsEncrypted",
		);
		this.setStatus(this.cipherStatus);
		if (!this.announcedEncryptedVault) {
			this.announcedEncryptedVault = true;
			new Notice(`Lockstep: ${this.cipherStatus}`, 15000);
		}
		return this.cipherStatus;
	}

	/** True when encryption is on and the vault is not open. Nothing may move. */
	private blocked(quiet: boolean): boolean {
		if (!this.locked) return false;
		this.setStatus(this.cipherStatus);
		if (!quiet) new Notice(`Lockstep: ${this.cipherStatus}`, 8000);
		return true;
	}

	async testConnection(): Promise<void> {
		const client = this.client();
		if (!client) return;
		try {
			await client.health();
			const stats = await client.stats();
			this.serverVault = String(stats["vault"] ?? "");
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
		if (this.isUnreachable(msg)) {
			if (this.announcedUnreachable) return;
			this.announcedUnreachable = true;
			new Notice(t("notice.unreachable", { url: this.settings.serverUrl }), 12000);
			return;
		}
		new Notice(t("notice.error", { what, message: msg }), 8000);
	}
}
