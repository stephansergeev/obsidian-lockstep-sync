// Encryption has one job beyond secrecy: it must not break the properties the sync
// depends on. Identical content has to encrypt to identical bytes, or deduplication,
// idempotent retries and quiet passes all stop working.
import test from "node:test";
import assert from "node:assert/strict";
import { VaultCipher, WrongPassphrase, isEnvelope, plaintext } from "./_crypto.mjs";

// Real vaults use hundreds of thousands of iterations. Tests use few, on purpose:
// the number is a parameter of the stored record, not a property of the format.
const ITER = 1000;
const bytes = (s) => new TextEncoder().encode(s).buffer;
const text = (b) => new TextDecoder().decode(b);

test("a note survives the round trip", async () => {
	const { cipher } = await VaultCipher.create("correct horse", ITER);
	const sealed = await cipher.encrypt(bytes("Заметка про Ереван"));
	assert.equal(text(await cipher.decrypt(sealed)), "Заметка про Ереван");
});

test("the same content always produces the same bytes", async () => {
	const { cipher } = await VaultCipher.create("correct horse", ITER);
	const a = await cipher.encrypt(bytes("one\ntwo\n"));
	const b = await cipher.encrypt(bytes("one\ntwo\n"));
	assert.deepEqual(new Uint8Array(a), new Uint8Array(b));
	// Without this the server would see a new revision on every upload of an
	// unchanged file, and every other device would wake up for nothing.
});

test("different content produces different bytes", async () => {
	const { cipher } = await VaultCipher.create("correct horse", ITER);
	const a = await cipher.encrypt(bytes("one"));
	const b = await cipher.encrypt(bytes("two"));
	assert.notDeepEqual(new Uint8Array(a), new Uint8Array(b));
});

test("a second device unlocks with the same passphrase", async () => {
	const { cipher, params } = await VaultCipher.create("correct horse", ITER);
	const sealed = await cipher.encrypt(bytes("shared note"));
	const other = await VaultCipher.unlock("correct horse", params);
	assert.equal(text(await other.decrypt(sealed)), "shared note");
});

test("a wrong passphrase is refused instead of producing garbage", async () => {
	const { params } = await VaultCipher.create("correct horse", ITER);
	await assert.rejects(() => VaultCipher.unlock("wrong horse", params), WrongPassphrase);
});

test("tampered bytes are refused", async () => {
	const { cipher } = await VaultCipher.create("correct horse", ITER);
	const sealed = new Uint8Array(await cipher.encrypt(bytes("important")));
	sealed[sealed.length - 3] ^= 0xff;
	await assert.rejects(() => cipher.decrypt(sealed.buffer));
});

test("plaintext written before encryption was turned on still reads", async () => {
	const { cipher } = await VaultCipher.create("correct horse", ITER);
	const old = bytes("written before encryption");
	assert.equal(isEnvelope(old), false);
	assert.equal(text(await cipher.decrypt(old)), "written before encryption");
	// A vault can be encrypted gradually rather than all at once.
});

test("an empty file is handled", async () => {
	const { cipher } = await VaultCipher.create("correct horse", ITER);
	const sealed = await cipher.encrypt(new ArrayBuffer(0));
	assert.equal((await cipher.decrypt(sealed)).byteLength, 0);
});

test("binary content survives untouched", async () => {
	const { cipher } = await VaultCipher.create("correct horse", ITER);
	const raw = new Uint8Array(4096);
	for (let i = 0; i < raw.length; i++) raw[i] = (i * 31) % 256;
	const back = new Uint8Array(await cipher.decrypt(await cipher.encrypt(raw.buffer)));
	assert.deepEqual(back, raw);
});

test("with encryption off the bytes pass through", async () => {
	const data = bytes("plain");
	assert.equal(plaintext.enabled, false);
	assert.equal(await plaintext.encrypt(data), data);
	assert.equal(await plaintext.decrypt(data), data);
});

test("stored parameters carry everything a second device needs", async () => {
	const { params } = await VaultCipher.create("correct horse", ITER);
	assert.equal(params.kdf, "PBKDF2-SHA256");
	assert.equal(params.iterations, ITER);
	assert.ok(params.salt.length > 0);
	assert.ok(params.verifier.length > 0);
	// Round trips through JSON, which is how it reaches the server.
	const copy = JSON.parse(JSON.stringify(params));
	await VaultCipher.unlock("correct horse", copy);
});
