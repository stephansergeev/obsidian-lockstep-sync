// Two devices, one real server, the real sync engine. Only Obsidian is stubbed.
//
// These are the tests that could not be written before: everything above this file
// checks a piece in isolation, and everything that has actually gone wrong so far
// went wrong between the pieces.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer, makeDevice } from "./harness/device.mjs";
import { VaultCipher } from "./_crypto.mjs";

async function twoDevices(options = {}) {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a, options);
	const b = await makeDevice(server, "iphone", server.tokens.b, options);
	return {
		server,
		a,
		b,
		async cleanup() {
			await a.cleanup();
			await b.cleanup();
			await server.stop();
		},
	};
}

test("an edit on one device reaches the other", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("Notes/Yerevan.md", "the cascade\n");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.read("Notes/Yerevan.md"), "the cascade\n");
});

test("a second round trip carries an edit back", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "one\n");
	await a.sync();
	await b.sync();

	await b.edit("note.md", "one\ntwo\n");
	await b.sync();
	await a.sync();

	assert.equal(await a.vault.read("note.md"), "one\ntwo\n");
});

test("edits to different parts of a note merge without asking", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "one\ntwo\nthree\n");
	await a.sync();
	await b.sync();

	await a.edit("note.md", "ONE\ntwo\nthree\n");
	await b.edit("note.md", "one\ntwo\nTHREE\n");
	await a.sync();
	const report = await b.sync();

	assert.equal(report.conflicts, 0, "a merge that needs no decision must not ask for one");
	assert.equal(await b.vault.read("note.md"), "ONE\ntwo\nTHREE\n");
	await a.sync();
	assert.equal(await a.vault.read("note.md"), "ONE\ntwo\nTHREE\n");
});

test("edits to the same line keep both versions and ask", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();

	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	assert.equal(b.conflicts.length, 1, "the phone should have been asked");
	const pending = b.index.conflicts[0];
	assert.ok(pending, "the conflict has to survive in the index, not just in a notice");
	assert.equal(pending.device, "iphone");
	assert.equal(pending.server_device, "mac", "the other side must be named by its own name");

	const files = await b.vault.snapshot();
	assert.equal(files["note.md"], "from the mac\n", "the note takes the server version");
	assert.equal(files[pending.copy], "from the phone\n", "and this device's version is kept whole");
});

test("keeping both edits writes one note with both texts", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();
	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	await b.engine.resolveConflict("note.md", "merged");
	const merged = await b.vault.read("note.md");
	assert.match(merged, /from the mac/);
	assert.match(merged, /from the phone/);
	assert.equal(b.index.conflicts.length, 0);

	await a.sync();
	assert.equal(await a.vault.read("note.md"), merged, "the decision reaches the other device");
});

test("a deletion on one device removes an untouched file on the other", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("gone.md", "temporary\n");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("gone.md"), true);

	await a.delete("gone.md");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.exists("gone.md"), false);
});

test("an edit beats a deletion, in both directions", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "original\n");
	await a.sync();
	await b.sync();

	// Deleted on the mac, edited on the phone at the same time.
	await a.delete("note.md");
	await b.edit("note.md", "original, edited\n");
	await a.sync();
	await b.sync();
	await b.sync();

	assert.equal(await b.vault.exists("note.md"), true, "the edited file must survive");
	await a.sync();
	assert.equal(await a.vault.read("note.md"), "original, edited\n", "and come back on the other side");
});

test("a rename travels as a rename", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("old name.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("old name.md", "new name.md");
	await a.sync();
	const report = await b.sync();

	assert.equal(await b.vault.read("new name.md"), "body\n");
	assert.equal(await b.vault.exists("old name.md"), false);
	assert.equal(report.renamed, 1, "it must arrive as a move, not as a deletion and a download");
});

test("a device that was away catches up on everything at once", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	for (let i = 0; i < 25; i++) await a.edit(`notes/${i}.md`, `note ${i}\n`);
	await a.sync();

	await b.sync();
	const files = await b.vault.snapshot();
	assert.equal(Object.keys(files).length, 25);
	assert.equal(files["notes/24.md"], "note 24\n");
});

test("syncing twice changes nothing the second time", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "content\n");
	await a.sync();
	await b.sync();

	const second = await b.sync();
	assert.equal(second.downloaded, 0);
	assert.equal(second.uploaded, 0);
	assert.equal(second.conflicts, 0);
	// A quiet pass has to stay quiet, or every device wakes up for nothing forever.
});

test("non-ASCII paths survive a round trip between devices", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const paths = ["Заметки/Ереван.md", "ノート/東京.md", "Notas/café.md"];
	for (const p of paths) await a.edit(p, `content of ${p}\n`);
	await a.sync();
	await b.sync();

	for (const p of paths) assert.equal(await b.vault.read(p), `content of ${p}\n`);
});

test("with encryption on, the server holds bytes it cannot read", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const a = await makeDevice(server, "mac", server.tokens.a, { cipher });
	const b = await makeDevice(server, "iphone", server.tokens.b, { cipher });
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("secret.md", "the passphrase to everything is hunter2\n");
	await a.sync();

	const raw = await server.rawBytes(server.tokens.a, "secret.md");
	assert.equal(raw.includes("hunter2"), false, "the plaintext must not be on the server");
	assert.equal(raw.includes("passphrase"), false);

	await b.sync();
	assert.equal(
		await b.vault.read("secret.md"),
		"the passphrase to everything is hunter2\n",
		"and the other device must still read it",
	);
});

test("encrypted content still deduplicates and stays quiet", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const a = await makeDevice(server, "mac", server.tokens.a, { cipher });
	t.after(async () => {
		await a.cleanup();
		await server.stop();
	});

	await a.edit("note.md", "same content\n");
	await a.sync();
	await a.edit("note.md", "same content\n"); // saved again, unchanged
	const second = await a.sync();

	assert.equal(second.uploaded, 0, "an unchanged file must not become a new revision");
});

test("a binary file changed on both sides keeps both and does not try to merge", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	const bytes = (fill) => {
		const u = new Uint8Array(64);
		u.fill(fill);
		u[0] = 0; // a NUL byte is what marks this as not text
		return Buffer.from(u).toString("binary");
	};

	await a.vault.writeBinary("image.bin", new Uint8Array([0, 1, 2, 3]).buffer);
	await a.edit("image.bin", bytes(1));
	await a.sync();
	await b.sync();

	await a.edit("image.bin", bytes(2));
	await b.edit("image.bin", bytes(3));
	await a.sync();
	await b.sync();

	const pending = b.index.conflicts[0];
	assert.ok(pending, "a binary conflict still has to be reported");
	assert.equal(pending.mergeable, false, "and it must not offer a line-by-line merge");
	assert.equal(await b.vault.exists(pending.copy), true, "both versions stay on disk");
});

test("choosing this device's version sends it to the other one", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();
	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	await b.engine.resolveConflict("note.md", "mine");
	assert.equal(await b.vault.read("note.md"), "from the phone\n");
	assert.equal(b.index.conflicts.length, 0);

	await a.sync();
	assert.equal(await a.vault.read("note.md"), "from the phone\n");
});

test("choosing the other device's version drops the copy and keeps the note", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "shared\n");
	await a.sync();
	await b.sync();
	await a.edit("note.md", "from the mac\n");
	await b.edit("note.md", "from the phone\n");
	await a.sync();
	await b.sync();

	const copy = b.index.conflicts[0].copy;
	await b.engine.resolveConflict("note.md", "server");
	assert.equal(await b.vault.read("note.md"), "from the mac\n");
	assert.equal(await b.vault.exists(copy), false, "the rejected copy is cleaned up");
	assert.equal(b.index.conflicts.length, 0);
});

test("a rename on one device and an edit on the other lose nothing", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("old.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("old.md", "new.md");
	await b.edit("old.md", "body, edited\n");
	await a.sync();
	await b.sync();
	await b.sync();
	await a.sync();

	const everywhere = { ...(await a.vault.snapshot()), ...(await b.vault.snapshot()) };
	const texts = Object.values(everywhere);
	assert.ok(
		texts.some((t) => t.includes("body, edited")),
		"the edit made against the old name must exist somewhere",
	);
});

test("two devices creating the same path from nothing keep both texts", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("same.md", "written on the mac\n");
	await b.edit("same.md", "written on the phone\n");
	await a.sync();
	await b.sync();

	const files = await b.vault.snapshot();
	const all = Object.values(files).join("\n");
	assert.match(all, /written on the mac/);
	assert.match(all, /written on the phone/, "neither first draft may be thrown away");
});

test("excluded paths never leave the device", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	a.settings.excludes.push("private/");
	await a.edit("private/secret.md", "not for the server\n");
	await a.edit("shared.md", "this one travels\n");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.exists("shared.md"), true);
	assert.equal(await b.vault.exists("private/secret.md"), false);
});

test("a lost index is rebuilt without losing anything", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "content\n");
	await a.sync();
	await b.sync();

	// The index is a cache. Losing it should cost time, not text.
	b.index.reset();
	await b.index.save();
	const report = await b.sync();

	assert.equal(await b.vault.read("note.md"), "content\n");
	assert.equal(report.conflicts, 0, "identical content must not look like a conflict");
});

test("a rename that only changes case arrives intact", async (t) => {
	const { a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("note.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("note.md", "Note.md");
	await a.sync();
	await b.sync();

	assert.equal(await b.vault.read("Note.md"), "body\n");
});

test("notes written before encryption was turned on still read afterwards", async (t) => {
	const server = await startServer();
	const a = await makeDevice(server, "mac", server.tokens.a);
	t.after(async () => {
		await a.cleanup();
		await server.stop();
	});

	await a.edit("early.md", "written in the clear\n");
	await a.sync();

	const { cipher } = await VaultCipher.create("later passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	a.setCipher(cipher);
	a.index.reset();
	await a.sync();

	assert.equal(await a.vault.read("early.md"), "written in the clear\n");
	// A vault can be encrypted gradually instead of in one frightening step.
});

test("a server that goes away and comes back loses nothing", async (t) => {
	const { server, a, b, cleanup } = await twoDevices();
	t.after(cleanup);

	await a.edit("before.md", "written before the outage\n");
	await a.sync();
	await b.sync();

	// The client keeps working against a server that is simply not answering.
	await a.edit("during.md", "written while it was down\n");
	const url = a.settings.serverUrl;
	a.settings.serverUrl = "http://127.0.0.1:9";
	await a.sync().catch(() => {});
	assert.equal(await a.vault.read("during.md"), "written while it was down\n");

	a.settings.serverUrl = url;
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.read("during.md"), "written while it was down\n");
	void server;
});

test("with paths hidden, the server never learns a file name", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const pathCipher = await cipher.pathCipher();
	const opts = { cipher, pathCipher };
	const a = await makeDevice(server, "mac", server.tokens.a, opts);
	const b = await makeDevice(server, "iphone", server.tokens.b, opts);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	// A vault says a great deal through its names alone, before anything is opened.
	await a.edit("Job search/Applications.md", "sent to three places\n");
	await a.edit("Job search/Curriculum.md", "the current version\n");
	await a.sync();

	const log = await server.rawChanges(server.tokens.a);
	const asText = JSON.stringify(log);

	// Only words long enough that finding one by chance is not a coin toss. A short
	// string like "CV" turns up in base64 by luck, and an assertion that passes by
	// luck is worse than no assertion: it fails on somebody else's machine, months
	// later, and looks like a real bug.
	for (const word of ["search", "Applications", "Curriculum", "three places", "current version"]) {
		assert.equal(asText.includes(word), false, `the server can see ${JSON.stringify(word)}`);
	}

	// Stronger than looking for words: no path the server stored may be a path the
	// vault would recognise.
	const stored = log.entries.map((e) => e.path);
	assert.equal(stored.length, 2);
	for (const p of stored) {
		assert.equal(p.includes("Job search"), false);
		assert.equal(p.endsWith(".md"), false, "even the kind of file is a leak");
		assert.equal(p.split("/").length, 2, "though the shape of the tree is not hidden");
	}

	await b.sync();
	assert.equal(await b.vault.read("Job search/Applications.md"), "sent to three places\n");
	assert.equal(await b.vault.read("Job search/Curriculum.md"), "the current version\n");
});

test("hidden paths survive renames and deletions between devices", async (t) => {
	const server = await startServer();
	const { cipher } = await VaultCipher.create("shared passphrase", {
		iterations: 1,
		memory_kib: 64,
	});
	const opts = { cipher, pathCipher: await cipher.pathCipher() };
	const a = await makeDevice(server, "mac", server.tokens.a, opts);
	const b = await makeDevice(server, "iphone", server.tokens.b, opts);
	t.after(async () => {
		await a.cleanup();
		await b.cleanup();
		await server.stop();
	});

	await a.edit("notes/first.md", "body\n");
	await a.sync();
	await b.sync();

	await a.rename("notes/first.md", "notes/second.md");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.read("notes/second.md"), "body\n");
	assert.equal(await b.vault.exists("notes/first.md"), false);

	await a.delete("notes/second.md");
	await a.sync();
	await b.sync();
	assert.equal(await b.vault.exists("notes/second.md"), false);
});
