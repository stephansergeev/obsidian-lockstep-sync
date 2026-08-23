// SPDX-License-Identifier: MIT

import { requestUrl, type RequestUrlResponse } from "obsidian";
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
	) {}

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
		return resp.json;
	}

	async getFile(path: string, rev?: number): Promise<{ data: ArrayBuffer; rev: number; hash: string }> {
		const q = rev === undefined ? "" : `&rev=${rev}`;
		const resp = await this.call("GET", `/file?path=${encodePath(path)}${q}`);
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
		const resp = await this.call("PUT", `/file?path=${encodePath(path)}`, {
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
		const resp = await this.call("PUT", `/file?path=${encodePath(path)}`, {
			body: new ArrayBuffer(0),
			headers: { "X-Base-Rev": String(baseRev), "X-Folder": "1" },
		});
		return resp.json;
	}

	async deleteFile(path: string, baseRev: number): Promise<WriteResult> {
		const resp = await this.call("DELETE", `/file?path=${encodePath(path)}`, {
			headers: { "X-Base-Rev": String(baseRev) },
		});
		return resp.json;
	}

	async rename(from: string, to: string, baseRev: number): Promise<WriteResult> {
		const resp = await this.call("POST", "/rename", {
			body: JSON.stringify({ from, to, base_rev: baseRev }),
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
