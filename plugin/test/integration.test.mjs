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
