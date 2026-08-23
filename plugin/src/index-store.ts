// SPDX-License-Identifier: MIT

import type { DataAdapter } from "obsidian";

/**
 * The local index: which revision the client based each path on.
 *
 * base_hash is not decoration. Without a common ancestor a 3-way merge is
 * impossible and conflict resolution degrades to "keep whichever is newer" —
 * which means silently losing one of the two versions.
 *
 * The index is JSON for now. On a vault of thousands of files that becomes the
 * bottleneck; SQLite will replace it behind the same interface.
 */
export interface IndexEntry {
	base_rev: number;
	base_hash: string;
	local_hash: string;
	mtime: number;
	folder?: boolean;
	dirty?: boolean;
}

/** A local rename that has not reached the server yet. */
export interface PendingRename {
	from: string;
	to: string;
	base_rev: number;
}

interface IndexFile {
	version: 1;
	last_seq: number;
	device_id: string;
	files: Record<string, IndexEntry>;
	/**
	 * Renames waiting to be sent, kept on disk rather than in memory. If the app dies
	 * between the rename and the next sync, an in-memory queue would turn the move
	 * into a delete plus a create on every other device.
	 */
	renames: PendingRename[];
}

const EMPTY: IndexFile = { version: 1, last_seq: 0, device_id: "", files: {}, renames: [] };

export class LocalIndex {
	private data: IndexFile = { ...EMPTY, files: {}, renames: [] };
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
					this.data = { ...parsed, renames: parsed.renames ?? [] };
					return;
				}
			} catch {
				// A missing or corrupt index is not fatal: it can be rebuilt. The
				// worst outcome is that the next sync reads more than it needed to.
			}
		}
		this.data = { ...EMPTY, files: {}, renames: [] };
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
		this.data = { ...EMPTY, device_id: id, files: {}, renames: [] };
	}

	get renames(): PendingRename[] {
		return this.data.renames;
	}

	queueRename(rename: PendingRename): void {
		// A file renamed twice before a sync should travel as one move, from where the
		// server still thinks it is to where it actually ended up.
		const earlier = this.data.renames.find((r) => r.to === rename.from);
		if (earlier) {
			earlier.to = rename.to;
			return;
		}
		this.data.renames.push(rename);
	}

	clearRename(rename: PendingRename): void {
		this.data.renames = this.data.renames.filter(
			(r) => !(r.from === rename.from && r.to === rename.to),
		);
	}

	/**
	 * Checkpoint. Called after EVERY file rather than at the end of a batch: the
	 * app is killed at arbitrary moments on mobile, and an unwritten index means
	 * the next run treats already-downloaded files as missing.
	 *
	 * The previous copy is kept alongside, so a torn write cannot blank the index.
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
			// Could not keep the previous copy — write anyway; that beats leaving
			// the index lagging behind what is actually on disk.
		}
		await this.adapter.write(this.file, body);
	}
}
