// SPDX-License-Identifier: MIT

import fs from "node:fs/promises";
import path from "node:path";

/**
 * A vault on a real filesystem, exposing the adapter surface the engine uses.
 *
 * Real files rather than an in-memory map on purpose: the bugs worth catching here
 * live in path handling, in Unicode, and in what happens when a write lands half
 * way. A dictionary pretending to be a disk would hide all three.
 */
export class FakeVault {
	constructor(root) {
		this.root = root;
		this.adapter = {
			exists: (p) => this.exists(p),
			read: (p) => this.read(p),
			write: (p, data) => this.write(p, data),
			readBinary: (p) => this.readBinary(p),
			writeBinary: (p, data) => this.writeBinary(p, data),
			mkdir: (p) => this.mkdir(p),
			remove: (p) => this.remove(p),
			rename: (from, to) => this.rename(from, to),
		};
	}

	full(p) {
		return path.join(this.root, p);
	}

	async exists(p) {
		try {
			await fs.stat(this.full(p));
			return true;
		} catch {
			return false;
		}
	}

	async read(p) {
		return fs.readFile(this.full(p), "utf8");
	}

	async write(p, data) {
		await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
		await fs.writeFile(this.full(p), data, "utf8");
	}

	async readBinary(p) {
		const buf = await fs.readFile(this.full(p));
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
	}

	async writeBinary(p, data) {
		await fs.mkdir(path.dirname(this.full(p)), { recursive: true });
		await fs.writeFile(this.full(p), Buffer.from(data));
	}

	async mkdir(p) {
		await fs.mkdir(this.full(p), { recursive: true });
	}

	async remove(p) {
		await fs.rm(this.full(p), { force: true });
	}

	async rename(from, to) {
		await fs.mkdir(path.dirname(this.full(to)), { recursive: true });
		await fs.rename(this.full(from), this.full(to));
	}

	/** Everything in the vault, as a map of path to text. Used for assertions. */
	async snapshot() {
		const out = {};
		const walk = async (dir, prefix) => {
			for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
				const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
				if (entry.name.startsWith(".")) continue;
				if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
				else out[rel] = await fs.readFile(path.join(dir, entry.name), "utf8");
			}
		};
		await walk(this.root, "");
		return out;
	}
}
