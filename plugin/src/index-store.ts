// SPDX-License-Identifier: MIT

import type { DataAdapter } from "obsidian";

/**
 * Локальный индекс: от какой ревизии клиент оттолкнулся по каждому пути.
 *
 * base_hash здесь не для красоты. Без общего предка 3-way merge невозможен,
 * и разрешение конфликтов скатывается до «оставить тот, что новее» — то есть
 * до молчаливой потери одной из версий.
 *
 * M0 хранит индекс в JSON. На волте в тысячи файлов это станет узким местом —
 * в M1 сюда встанет SQLite, интерфейс останется тем же.
 */
export interface IndexEntry {
	base_rev: number;
	base_hash: string;
	local_hash: string;
	mtime: number;
	folder?: boolean;
	dirty?: boolean;
}

interface IndexFile {
	version: 1;
	last_seq: number;
	device_id: string;
	files: Record<string, IndexEntry>;
}

const EMPTY: IndexFile = { version: 1, last_seq: 0, device_id: "", files: {} };

export class LocalIndex {
	private data: IndexFile = { ...EMPTY, files: {} };
	private saving: Promise<void> | null = null;
	private pending = false;

	constructor(
		private adapter: DataAdapter,
		private dir: string,
	) {}

	private get file(): string {
		return `${this.dir}/index.json`;
	}
	private get prev(): string {
		return `${this.dir}/index.prev.json`;
	}

	async load(): Promise<void> {
		for (const candidate of [this.file, this.prev]) {
			try {
				const raw = await this.adapter.read(candidate);
				const parsed = JSON.parse(raw) as IndexFile;
				if (parsed && parsed.version === 1 && parsed.files) {
					this.data = parsed;
					return;
				}
			} catch {
				// Битый или отсутствующий индекс — не повод падать: он восстановим.
				// Худшее последствие — следующий синк перечитает больше, чем нужно.
			}
		}
		this.data = { ...EMPTY, files: {} };
	}

	get lastSeq(): number {
		return this.data.last_seq;
	}
	setLastSeq(seq: number): void {
		if (seq > this.data.last_seq) this.data.last_seq = seq;
	}

	get deviceId(): string {
		return this.data.device_id;
	}
	setDeviceId(id: string): void {
		this.data.device_id = id;
	}

	get(path: string): IndexEntry | undefined {
		return this.data.files[path];
	}
	set(path: string, entry: IndexEntry): void {
		this.data.files[path] = entry;
	}
	remove(path: string): void {
		delete this.data.files[path];
	}
	get size(): number {
		return Object.keys(this.data.files).length;
	}
	paths(): string[] {
		return Object.keys(this.data.files);
	}

	reset(): void {
		const id = this.data.device_id;
		this.data = { ...EMPTY, device_id: id, files: {} };
	}

	/**
	 * Чекпоинт. Вызывается после КАЖДОГО файла, а не в конце пачки: приложение на
	 * мобильном убивают в произвольный момент, и незаписанный индекс означает,
	 * что при следующем запуске клиент считает уже скачанное несуществующим.
	 *
	 * Предыдущая копия сохраняется рядом — оборванная запись не может обнулить индекс.
	 */
	async save(): Promise<void> {
		if (this.saving) {
			this.pending = true;
			return this.saving;
		}
		this.saving = this.writeNow().finally(() => {
			this.saving = null;
			if (this.pending) {
				this.pending = false;
				void this.save();
			}
		});
		return this.saving;
	}

	private async writeNow(): Promise<void> {
		const body = JSON.stringify(this.data);
		try {
			if (await this.adapter.exists(this.file)) {
				const old = await this.adapter.read(this.file);
				await this.adapter.write(this.prev, old);
			}
		} catch {
			// Не смогли сохранить предыдущую копию — пишем всё равно, это лучше,
			// чем оставить индекс отставшим от диска.
		}
		await this.adapter.write(this.file, body);
	}
}
