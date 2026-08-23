// SPDX-License-Identifier: MIT

/**
 * Vault encryption.
 *
 * Content is encrypted on the device with AES-256-GCM before it is uploaded. The
 * key never leaves the device and the server holds bytes it cannot read.
 *
 * Two design choices here are worth stating plainly, because both trade something
 * away.
 *
 * The key is derived with PBKDF2-SHA256 rather than the Argon2id the specification
 * asked for. Web Crypto has no Argon2, and the alternative is shipping a WebAssembly
 * build inside a plugin that has to run on a phone. PBKDF2 with a high iteration
 * count is weaker against dedicated hardware but needs no dependency and no native
 * code. The parameters live on the server as an opaque record, so moving to Argon2id
 * later is a migration rather than a break.
 *
 * The nonce is derived from the plaintext rather than drawn at random. A random
 * nonce would make every upload of an unchanged file produce different bytes, which
 * would defeat deduplication, break the idempotent retry the whole protocol depends
 * on, and wake every other device for a file that did not change. Deriving it means
 * identical plaintext yields identical ciphertext, which costs one thing: the server
 * can tell that two files hold the same content, though not what that content is.
 */

const MAGIC = new Uint8Array([0x4c, 0x53, 0x45, 0x01]); // "LSE" and a format version
const NONCE_BYTES = 12;
const VERIFY_TEXT = "lockstep-verify";

/** OWASP's recommendation for PBKDF2-SHA256 at the time of writing. */
export const DEFAULT_ITERATIONS = 600_000;

export interface VaultKeyParams {
	v: 1;
	kdf: "PBKDF2-SHA256";
	iterations: number;
	/** Base64. */
	salt: string;
	/** Base64 envelope of a known string, used to tell a wrong passphrase from corrupt data. */
	verifier: string;
}

export interface Cipher {
	readonly enabled: boolean;
	encrypt(data: ArrayBuffer): Promise<ArrayBuffer>;
	decrypt(data: ArrayBuffer): Promise<ArrayBuffer>;
}

/** Used when encryption is off: bytes pass through untouched. */
export const plaintext: Cipher = {
	enabled: false,
	async encrypt(data) {
		return data;
	},
	async decrypt(data) {
		return data;
	},
};

export class WrongPassphrase extends Error {
	constructor() {
		super("wrong passphrase");
		this.name = "WrongPassphrase";
	}
}

export class VaultCipher implements Cipher {
	readonly enabled = true;

	private constructor(
		private key: CryptoKey,
		private nonceKey: CryptoKey,
	) {}

	/** Set up encryption for a vault that has none yet. */
	static async create(
		passphrase: string,
		iterations = DEFAULT_ITERATIONS,
	): Promise<{ cipher: VaultCipher; params: VaultKeyParams }> {
		const salt = crypto.getRandomValues(new Uint8Array(32));
		const cipher = await VaultCipher.fromSalt(passphrase, salt, iterations);
		const verifier = await cipher.encrypt(new TextEncoder().encode(VERIFY_TEXT).buffer as ArrayBuffer);
		return {
			cipher,
			params: {
				v: 1,
				kdf: "PBKDF2-SHA256",
				iterations,
				salt: toBase64(salt.buffer as ArrayBuffer),
				verifier: toBase64(verifier),
			},
		};
	}

	/** Join a vault that already has parameters, checking the passphrase against them. */
	static async unlock(passphrase: string, params: VaultKeyParams): Promise<VaultCipher> {
		if (params.kdf !== "PBKDF2-SHA256") {
			throw new Error(`unsupported key derivation: ${params.kdf}`);
		}
		const cipher = await VaultCipher.fromSalt(
			passphrase,
			new Uint8Array(fromBase64(params.salt)),
			params.iterations,
		);
		let opened: ArrayBuffer;
		try {
			opened = await cipher.decrypt(fromBase64(params.verifier));
		} catch {
			throw new WrongPassphrase();
		}
		if (new TextDecoder().decode(opened) !== VERIFY_TEXT) throw new WrongPassphrase();
		return cipher;
	}

	private static async fromSalt(
		passphrase: string,
		salt: Uint8Array,
		iterations: number,
	): Promise<VaultCipher> {
		const material = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(passphrase),
			"PBKDF2",
			false,
			["deriveBits"],
		);
		// 64 bytes: the first half encrypts, the second half derives nonces. Splitting
		// them keeps the nonce derivation from being an oracle on the encryption key.
		const bits = await crypto.subtle.deriveBits(
			{ name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
			material,
			512,
		);
		const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), "AES-GCM", false, [
			"encrypt",
			"decrypt",
		]);
		const nonceKey = await crypto.subtle.importKey(
			"raw",
			bits.slice(32, 64),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		return new VaultCipher(key, nonceKey);
	}

	async encrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
		const nonce = await this.nonceFor(data);
		const sealed = await crypto.subtle.encrypt(
			{ name: "AES-GCM", iv: nonce as unknown as BufferSource },
			this.key,
			data,
		);
		const out = new Uint8Array(MAGIC.length + NONCE_BYTES + sealed.byteLength);
		out.set(MAGIC, 0);
		out.set(nonce, MAGIC.length);
		out.set(new Uint8Array(sealed), MAGIC.length + NONCE_BYTES);
		return out.buffer as ArrayBuffer;
	}

	async decrypt(data: ArrayBuffer): Promise<ArrayBuffer> {
		if (!isEnvelope(data)) {
			// Written before encryption was turned on. Left as it is, so a vault can be
			// encrypted gradually instead of all at once.
			return data;
		}
		const bytes = new Uint8Array(data);
		const nonce = bytes.slice(MAGIC.length, MAGIC.length + NONCE_BYTES);
		const body = bytes.slice(MAGIC.length + NONCE_BYTES);
		return crypto.subtle.decrypt(
			{ name: "AES-GCM", iv: nonce as unknown as BufferSource },
			this.key,
			body,
		);
	}

	private async nonceFor(data: ArrayBuffer): Promise<Uint8Array> {
		const mac = await crypto.subtle.sign("HMAC", this.nonceKey, data);
		return new Uint8Array(mac).slice(0, NONCE_BYTES);
	}
}

/** True when these bytes were written by this plugin's encryption. */
export function isEnvelope(data: ArrayBuffer): boolean {
	if (data.byteLength < MAGIC.length + NONCE_BYTES + 16) return false;
	const head = new Uint8Array(data, 0, MAGIC.length);
	return MAGIC.every((b, i) => head[i] === b);
}

export function toBase64(data: ArrayBuffer): string {
	const bytes = new Uint8Array(data);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export function fromBase64(text: string): ArrayBuffer {
	const binary = atob(text);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out.buffer as ArrayBuffer;
}
