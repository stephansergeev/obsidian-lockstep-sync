// SPDX-License-Identifier: MIT

import { requestUrl, type RequestUrlResponse } from "obsidian";
import type { PathCipher } from "./crypto";
import { encodePath } from "./paths";

/**
 * Client for the /v1 protocol. Every request goes through Obsidian's
 * requestUrl(): a plain fetch() hits CORS on desktop because the plugin runs on
 * the app://obsidian.md origin.
 */

export interface ChangeEntry {
	seq: number;
	path: string;
	rev: number;
	hash?: string;
	size: number;
	mtime: number;
	deleted: boolean;
	folder: boolean;
	updated_by?: string;
	renamed_from?: string;
}

export interface DeletedFile {
	path: string;
	/** The tombstone. A restore has to be based on this. */
	rev: number;
	deleted_at: number;
	/** The last revision that still has content behind it. */
	content_rev: number;
	hash: string;
}

export interface ChangesPage {
	entries: ChangeEntry[];
	next_seq: number;
	has_more: boolean;
}

export interface WriteResult {
	path: string;
	rev: number;
	seq: number;
	hash: string;
	deleted: boolean;
}

/** The server moved ahead: the client must merge rather than overwrite. */
export class ConflictError extends Error {
	constructor(
		readonly path: string,
		readonly serverRev: number,
		readonly serverHash: string,
		readonly deleted: boolean,
		/** Which device wrote the revision the server holds, as that device named itself. */
		readonly serverDevice: string,
	) {
		super(`conflict on ${path}: server rev ${serverRev}`);
		this.name = "ConflictError";
	}
}

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly kind: string,
		message: string,
	) {
		super(message);
		this.name = "ApiError";
	}
}

export class SyncClient {
	constructor(
		private baseUrl: string,
		private token: string,
		/** How this device calls itself, sent with every write so conflicts can name it. */
		private device = "",
		/**
		 * Translates vault paths to the names the server sees, when the vault hides
		 * them. Every path crosses this class on its way out and on its way back, so
		 * nothing above it has to know whether names are hidden at all.
		 */
		private paths: PathCipher | null = null,
	) {}

	/** The name the server knows this path by. */
	private async remote(path: string): Promise<string> {
		return this.paths ? this.paths.encrypt(path) : path;
	}

	/** The name the vault knows this path by. */
	private async local(path: string): Promise<string> {
		return this.paths ? this.paths.decrypt(path) : path;
	}

	private url(path: string): string {
		return `${this.baseUrl.replace(/\/+$/, "")}/v1${path}`;
	}

	private async call(
		method: string,
		path: string,
		opts: { body?: ArrayBuffer | string; headers?: Record<string, string> } = {},
	): Promise<RequestUrlResponse> {
		const resp = await requestUrl({
			url: this.url(path),
			method,
			body: opts.body,
			headers: {
				Authorization: `Bearer ${this.token}`,
				...(this.device ? { "X-Device": this.device } : {}),
				...(opts.headers ?? {}),
			},
			// Statuses are handled here: 409 is a normal outcome, not a failure.
			throw: false,
		});
		if (resp.status === 409) {
			const j = safeJson(resp);
			throw new ConflictError(
				String(j.path ?? ""),
				Number(j.server_rev ?? 0),
				String(j.server_hash ?? ""),
				Boolean(j.deleted),
				String(j.updated_by ?? ""),
			);
		}
		if (resp.status >= 400) {
			const j = safeJson(resp);
			throw new ApiError(
				resp.status,
				String(j.error ?? "http_error"),
				String(j.message ?? `HTTP ${resp.status}`),
			);
		}
		return resp;
	}

	async health(): Promise<{ ok: boolean }> {
		const resp = await this.call("GET", "/health");
		return resp.json;
	}

	async stats(): Promise<Record<string, number | string>> {
		const resp = await this.call("GET", "/stats");
		return resp.json;
	}

	/** The change delta. The client never walks the vault tree at all. */
	async changes(since: number, limit = 500): Promise<ChangesPage> {
		const resp = await this.call("GET", `/changes?since=${since}&limit=${limit}`);
		const page = resp.json as ChangesPage;
		if (!this.paths) return page;
		const entries: ChangeEntry[] = [];
		for (const entry of page.entries) {
			try {
				entries.push({
					...entry,
					path: await this.local(entry.path),
					...(entry.renamed_from ? { renamed_from: await this.local(entry.renamed_from) } : {}),
				});
			} catch {
				// A name this key cannot open. Written by another vault sharing the
				// server, or from before encryption. Skipping it is right: acting on a
				// path we cannot read would put a file somewhere nobody chose.
				continue;
			}
		}
		return { ...page, entries };
	}

	/** Key derivation parameters for this vault, or null when it has none yet. */
	async getVaultKey(): Promise<Record<string, unknown> | null> {
		try {
			const resp = await this.call("GET", "/vaultkey");
			return resp.json;
		} catch (e) {
			if (e instanceof ApiError && e.status === 404) return null;
			throw e;
		}
	}

	/** Write them once. The server refuses to change them. */
	async putVaultKey(params: unknown): Promise<void> {
		await this.call("PUT", "/vaultkey", {
			body: JSON.stringify(params),
			headers: { "Content-Type": "application/json" },
		});
	}

	/** Mint a token for another device on this same vault. */
	async issueToken(name: string): Promise<{ token: string; vault: string }> {
		const resp = await this.call("POST", "/tokens", {
			body: JSON.stringify({ name }),
			headers: { "Content-Type": "application/json" },
		});
		return { token: String(resp.json?.token ?? ""), vault: String(resp.json?.vault ?? "") };
	}

	/** How many days a deleted file stays recoverable. Zero means for good. */
	async getRetention(): Promise<number> {
		const resp = await this.call("GET", "/retention");
		return Number(resp.json?.days ?? 30);
	}

	async setRetention(days: number): Promise<void> {
		await this.call("PUT", "/retention", {
			body: JSON.stringify({ days }),
			headers: { "Content-Type": "application/json" },
		});
	}

	/** Files that are gone but still recoverable, most recently deleted first. */
	async deleted(limit = 200): Promise<DeletedFile[]> {
		const resp = await this.call("GET", `/deleted?limit=${limit}`);
		const entries = (resp.json?.entries ?? []) as DeletedFile[];
		if (!this.paths) return entries;
		const out: DeletedFile[] = [];
		for (const entry of entries) {
			try {
				out.push({ ...entry, path: await this.local(entry.path) });
			} catch {
				// A name this key cannot open belongs to another vault on this server.
				continue;
			}
		}
		return out;
	}

	async getFile(path: string, rev?: number): Promise<{ data: ArrayBuffer; rev: number; hash: string }> {
		const q = rev === undefined ? "" : `&rev=${rev}`;
		const resp = await this.call("GET", `/file?path=${encodePath(await this.remote(path))}${q}`);
		return {
			data: resp.arrayBuffer,
			rev: Number(resp.headers["x-rev"] ?? rev ?? 0),
			hash: String(resp.headers["etag"] ?? "").replace(/"/g, ""),
		};
	}

	async putFile(
		path: string,
		baseRev: number,
		data: ArrayBuffer,
		mtime: number,
	): Promise<WriteResult> {
		const resp = await this.call("PUT", `/file?path=${encodePath(await this.remote(path))}`, {
			body: data,
			headers: {
				"X-Base-Rev": String(baseRev),
				"X-Mtime": String(mtime),
				"Content-Type": "application/octet-stream",
			},
		});
		return resp.json;
	}

	async putFolder(path: string, baseRev: number): Promise<WriteResult> {
		const resp = await this.call("PUT", `/file?path=${encodePath(await this.remote(path))}`, {
			body: new ArrayBuffer(0),
			headers: { "X-Base-Rev": String(baseRev), "X-Folder": "1" },
		});
		return resp.json;
	}

	async deleteFile(path: string, baseRev: number): Promise<WriteResult> {
		const resp = await this.call("DELETE", `/file?path=${encodePath(await this.remote(path))}`, {
			headers: { "X-Base-Rev": String(baseRev) },
		});
		return resp.json;
	}

	async rename(from: string, to: string, baseRev: number): Promise<WriteResult> {
		const resp = await this.call("POST", "/rename", {
			body: JSON.stringify({
				from: await this.remote(from),
				to: await this.remote(to),
				base_rev: baseRev,
			}),
			headers: { "Content-Type": "application/json" },
		});
		return resp.json;
	}
}

function safeJson(resp: RequestUrlResponse): Record<string, unknown> {
	try {
		return resp.json ?? {};
	} catch {
		return {};
	}
}
