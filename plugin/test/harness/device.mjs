// SPDX-License-Identifier: MIT

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyncEngine } from "../_sync-engine.mjs";
import { LocalIndex } from "../_index-store.mjs";
import { SyncClient } from "../_sync-engine.mjs";
import { FakeVault } from "./fake-vault.mjs";

const BINARY = path.resolve("../bin/sync-server");

/** A running server with its own data directory, thrown away afterwards. */
export async function startServer() {
	const data = await fs.mkdtemp(path.join(os.tmpdir(), "lockstep-server-"));
	// Port 0 would be cleaner, but the server prints nothing parseable, so the
	// range is walked until one binds.
	const port = 9000 + Number(process.hrtime.bigint() % 900n);

	const token = async (name) => {
		const out = await run(BINARY, ["token", "add", "--data", data, "--vault", "test", "--name", name]);
		const m = out.match(/(obs_[A-Za-z0-9_-]+)/);
		if (!m) throw new Error(`no token in output: ${out}`);
		return m[1];
	};

	const tokens = { a: await token("device-a"), b: await token("device-b") };

	const proc = spawn(BINARY, ["serve", "--data", data, "--addr", `127.0.0.1:${port}`], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const url = `http://127.0.0.1:${port}`;
	await waitFor(url);

	return {
		url,
		tokens,
		data,
		async stop() {
			proc.kill();
			await fs.rm(data, { recursive: true, force: true });
		},
		/** The change log exactly as the server stores it, names and all. */
		async rawChanges(token) {
			const resp = await fetch(`${url}/v1/changes?since=0&limit=500`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			return resp.json();
		},
		/** What the server actually holds, to prove encryption is real. */
		async rawBytes(token, filePath) {
			const resp = await fetch(`${url}/v1/file?path=${encodeURIComponent(filePath)}`, {
				headers: { Authorization: `Bearer ${token}` },
			});
			return Buffer.from(await resp.arrayBuffer());
		},
	};
}

async function run(cmd, args) {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, args);
		let out = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (out += d));
		p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out))));
	});
}

async function waitFor(url) {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`${url}/v1/health`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("server never came up");
}

/**
 * One device: its own vault on disk, its own index, its own engine.
 *
 * This is the real engine, not a reimplementation of it. Only Obsidian is stubbed.
 */
export async function makeDevice(server, name, token, options = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `lockstep-${name}-`));
	const vault = new FakeVault(root);
	await vault.mkdir(".index");
	const index = new LocalIndex(vault.adapter, ".index");
	await index.load();

	const settings = {
		serverUrl: server.url,
		token,
		deviceName: name,
		excludes: [".index/"],
		autoSync: true,
		intervalSeconds: 60,
		encryption: false,
		passphrase: "",
	};

	const conflicts = [];
	const logs = [];
	let cipher = options.cipher ?? { enabled: false, encrypt: async (d) => d, decrypt: async (d) => d };

	const engine = new SyncEngine({
		app: { vault },
		index,
		settings,
		client: () =>
			new SyncClient(server.url, token, settings.deviceName, options.pathCipher ?? null),
		cipher: () => cipher,
		onConflict: (path, copy) => conflicts.push({ path, copy }),
		log: (message, error) => logs.push(`${message}: ${error ?? ""}`),
	});

	return {
		name,
		vault,
		index,
		engine,
		settings,
		conflicts,
		logs,
		setCipher(c) {
			cipher = c;
		},
		/** Write a file and tell the index about it, the way the watcher would. */
		async edit(filePath, text) {
			await vault.write(filePath, text);
			const known = index.get(filePath);
			index.set(filePath, {
				base_rev: known?.base_rev ?? 0,
				base_hash: known?.base_hash ?? "",
				plain_hash: known?.plain_hash,
				local_hash: known?.local_hash ?? "",
				mtime: Date.now(),
				dirty: true,
			});
		},
		async delete(filePath) {
			await vault.remove(filePath);
			const known = index.get(filePath);
			if (known) index.set(filePath, { ...known, dirty: true });
		},
		async rename(from, to) {
			await vault.rename(from, to);
			const known = index.get(from);
			if (known && known.base_rev > 0) {
				index.queueRename({ from, to, base_rev: known.base_rev });
				index.set(to, { ...known, dirty: known.dirty ?? false });
				index.remove(from);
			}
		},
		async sync() {
			return engine.sync();
		},
		async cleanup() {
			await fs.rm(root, { recursive: true, force: true });
		},
	};
}
