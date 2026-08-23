// SPDX-License-Identifier: MIT

import { Notice, Plugin, normalizePath } from "obsidian";
import { SyncClient, ApiError, type ChangeEntry } from "./api";
import { LocalIndex } from "./index-store";
import { conflictName, sha256, toNFC } from "./paths";
import { DEFAULT_SETTINGS, SyncSettingsTab, type SyncSettings } from "./settings";

/**
 * M0: настройки, проверка соединения и односторонняя загрузка с сервера.
 *
 * Двусторонний синк, наблюдение за волтом и слияние конфликтов приезжают в M1 —
 * до тех пор плагин намеренно не умеет писать на сервер, чтобы недоделанная
 * логика не трогала живой волт.
 */
export default class SelfHostedSyncPlugin extends Plugin {
	override settings: SyncSettings = { ...DEFAULT_SETTINGS };
	index!: LocalIndex;
	private statusBar: HTMLElement | null = null;
	private lastStatus = "не подключено";

	override async onload(): Promise<void> {
		await this.loadSettings();

		const dir = normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
		this.index = new LocalIndex(this.app.vault.adapter, dir);
		await this.index.load();

		this.addSettingTab(new SyncSettingsTab(this.app, this));
		this.statusBar = this.addStatusBarItem();
		this.setStatus(`индекс: ${this.index.size} файлов, seq ${this.index.lastSeq}`);

		this.addCommand({
			id: "test-connection",
			name: "Проверить соединение с сервером",
			callback: () => void this.testConnection(),
		});
		this.addCommand({
			id: "pull-all",
			name: "Скачать всё с сервера",
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
		this.statusBar?.setText(`Sync: ${text}`);
	}

	private client(): SyncClient | null {
		if (!this.settings.serverUrl || !this.settings.token) {
			new Notice("Sync: не заданы адрес сервера или токен");
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
			const line = `волт ${stats["vault"]}, файлов ${stats["files"]}, seq ${stats["seq"]}`;
			this.setStatus(line);
			new Notice(`Sync: соединение есть — ${line}`);
		} catch (e) {
			this.reportError("Проверка соединения", e);
		}
	}

	async resetIndex(): Promise<void> {
		this.index.reset();
		await this.index.save();
		this.setStatus("индекс сброшен");
	}

	/**
	 * Забирает состояние волта с сервера.
	 *
	 * Правило волта: ничего не перезаписываем молча. Если локальный файл отличается
	 * от серверного, локальная версия сначала уезжает в копию рядом — потерять
	 * заметку хуже, чем увидеть лишний файл.
	 */
	async pullAll(): Promise<void> {
		const client = this.client();
		if (!client) return;

		let since = 0;
		let downloaded = 0;
		let kept = 0;
		let skipped = 0;
		const started = Date.now();
		new Notice("Sync: скачиваю с сервера…");

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

					// Чекпоинт после каждого файла: приложение может умереть прямо здесь.
					this.index.setLastSeq(entry.seq);
					await this.index.save();
				}
				since = page.next_seq;
				this.index.setLastSeq(since);
				if (!page.has_more) break;
			}
			await this.index.save();

			const secs = ((Date.now() - started) / 1000).toFixed(1);
			const line = `скачано ${downloaded}, пропущено ${skipped}, копий сохранено ${kept} за ${secs}с`;
			this.setStatus(line);
			new Notice(`Sync: ${line}`);
		} catch (e) {
			await this.index.save();
			this.reportError("Скачивание", e);
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
			// M0 намеренно НЕ удаляет локальные файлы: односторонняя загрузка не должна
			// уметь стирать волт. Удаления приедут в M1 вместе с полноценным индексом.
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
			// Расходится — локальную версию сохраняем рядом, прежде чем писать серверную.
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
			throw new Error(`битая загрузка ${path}: ожидали ${entry.hash}, получили ${actual}`);
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
		return this.settings.deviceName || "local";
	}

	private reportError(what: string, e: unknown): void {
		const msg =
			e instanceof ApiError
				? `${e.status} ${e.kind}: ${e.message}`
				: e instanceof Error
					? e.message
					: String(e);
		console.error(`[lockstep-sync] ${what}:`, e);
		this.setStatus(`ошибка: ${msg}`);
		new Notice(`Sync — ${what}: ${msg}`, 8000);
	}
}
