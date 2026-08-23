// SPDX-License-Identifier: MIT

/**
 * Vault encryption.
 *
 * Content is encrypted on the device with AES-256-GCM before it is uploaded. The
 * key never leaves the device and the server holds bytes it cannot read.
 *
 * The key is derived with Argon2id, which is memory-hard: each guess has to allocate
 * and walk tens of megabytes, and that is what stops a graphics card from trying
 * millions of passphrases in parallel. It costs a WebAssembly build inside the
 * plugin, which was worth measuring before accepting. On an iPhone, Argon2id at
 * 64 MiB over three passes takes 172 ms against 227 ms for PBKDF2 at 600,000
 * iterations: cheaper for the person waiting, and orders of magnitude more expensive
 * for anyone attacking the passphrase.
 *
 * PBKDF2 is still read, so a vault set up before this change keeps opening. The
 * parameters live on the server as an opaque record, which is what makes changing
 * the derivation a migration rather than a break.
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

/** OWASP's recommendation for PBKDF2-SHA256, kept for vaults created before the switch. */
export const DEFAULT_ITERATIONS = 600_000;

/**
 * Argon2id settings. 64 MiB over three passes is the point measured on a phone:
 * fast enough that nobody notices, heavy enough that parallel cracking collapses.
 */
export const ARGON2_MEMORY_KIB = 64 * 1024;
export const ARGON2_PASSES = 3;

export interface VaultKeyParams {
	v: 1;
	kdf: "PBKDF2-SHA256" | "Argon2id";
	/** PBKDF2 iterations, or Argon2 passes. */
	iterations: number;
	/** Argon2id only. */
	memory_kib?: number;
	/** Argon2id only. */
	parallelism?: number;
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

	/**
	 * Set up encryption for a vault that has none yet. Argon2id unless told otherwise.
	 *
	 * The override exists so a migration can build a record under the older scheme,
	 * and so the tests can prove such a record still opens.
	 */
	static async create(
		passphrase: string,
		overrides: Partial<Pick<VaultKeyParams, "kdf" | "iterations" | "memory_kib">> = {},
	): Promise<{ cipher: VaultCipher; params: VaultKeyParams }> {
		const salt = crypto.getRandomValues(new Uint8Array(32));
		const kdf = overrides.kdf ?? "Argon2id";
		const params: VaultKeyParams = {
			v: 1,
			kdf,
			iterations:
				overrides.iterations ?? (kdf === "Argon2id" ? ARGON2_PASSES : DEFAULT_ITERATIONS),
			memory_kib: kdf === "Argon2id" ? (overrides.memory_kib ?? ARGON2_MEMORY_KIB) : undefined,
			parallelism: kdf === "Argon2id" ? 1 : undefined,
			salt: toBase64(salt.buffer as ArrayBuffer),
			verifier: "",
		};
		const cipher = await VaultCipher.fromParams(passphrase, salt, params);
		params.verifier = toBase64(
			await cipher.encrypt(new TextEncoder().encode(VERIFY_TEXT).buffer as ArrayBuffer),
		);
		return { cipher, params };
	}

	/** Join a vault that already has parameters, checking the passphrase against them. */
	static async unlock(passphrase: string, params: VaultKeyParams): Promise<VaultCipher> {
		const cipher = await VaultCipher.fromParams(
			passphrase,
			new Uint8Array(fromBase64(params.salt)),
			params,
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

	private static async fromParams(
		passphrase: string,
		salt: Uint8Array,
		params: VaultKeyParams,
	): Promise<VaultCipher> {
		// 64 bytes: the first half encrypts, the second half derives nonces. Splitting
		// them keeps the nonce derivation from being an oracle on the encryption key.
		const bits =
			params.kdf === "Argon2id"
				? await deriveArgon2id(passphrase, salt, params)
				: await derivePbkdf2(passphrase, salt, params.iterations);
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

async function deriveArgon2id(
	passphrase: string,
	salt: Uint8Array,
	params: VaultKeyParams,
): Promise<ArrayBuffer> {
	// Loaded on demand so the WebAssembly is only paid for by vaults that encrypt.
	const { argon2id } = await import("hash-wasm");
	const out = await argon2id({
		password: passphrase,
		salt,
		parallelism: params.parallelism ?? 1,
		memorySize: params.memory_kib ?? ARGON2_MEMORY_KIB,
		iterations: params.iterations,
		hashLength: 64,
		outputType: "binary",
	});
	return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
}

async function derivePbkdf2(
	passphrase: string,
	salt: Uint8Array,
	iterations: number,
): Promise<ArrayBuffer> {
	const material = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(passphrase),
		"PBKDF2",
		false,
		["deriveBits"],
	);
	return crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
		material,
		512,
	);
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
