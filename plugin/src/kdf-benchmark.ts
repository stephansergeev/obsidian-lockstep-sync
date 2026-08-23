// SPDX-License-Identifier: MIT

import { Notice } from "obsidian";
import { DEFAULT_ITERATIONS } from "./crypto";

/**
 * Measure key derivation on the device actually being used.
 *
 * The choice between PBKDF2 and Argon2id is not a matter of taste. Argon2id is
 * memory-hard, which is what stops a graphics card from trying millions of
 * passphrases in parallel, and that is worth real money to an attacker. What it
 * costs is memory: tens of megabytes per attempt, inside a webview, on a phone that
 * kills background apps for using too much.
 *
 * Nobody should guess at that number. This measures it.
 */

export interface KdfMeasurement {
	label: string;
	ms: number;
	note?: string;
}

const PASSPHRASE = "measurement passphrase, not a real one";

export async function benchmarkKdf(): Promise<KdfMeasurement[]> {
	const results: KdfMeasurement[] = [];
	const salt = crypto.getRandomValues(new Uint8Array(32));

	results.push({
		label: `PBKDF2-SHA256, ${DEFAULT_ITERATIONS.toLocaleString("en")} iterations`,
		ms: await time(() => pbkdf2(PASSPHRASE, salt, DEFAULT_ITERATIONS)),
		note: "what the plugin uses today",
	});

	// Loaded on demand: the WebAssembly build is only needed for the measurement, and
	// on a phone the memory it wants is the whole point of taking one.
	const { argon2id } = await import("hash-wasm");

	for (const [memoryMiB, iterations] of [
		[19, 2],
		[32, 3],
		[64, 3],
	] as const) {
		try {
			results.push({
				label: `Argon2id, ${memoryMiB} MiB, ${iterations} passes`,
				ms: await time(() =>
					argon2id({
						password: PASSPHRASE,
						salt,
						parallelism: 1,
						memorySize: memoryMiB * 1024,
						iterations,
						hashLength: 64,
						outputType: "binary",
					}),
				),
			});
		} catch (e) {
			results.push({
				label: `Argon2id, ${memoryMiB} MiB, ${iterations} passes`,
				ms: -1,
				note: e instanceof Error ? e.message : String(e),
			});
		}
	}

	return results;
}

async function time(run: () => Promise<unknown>): Promise<number> {
	const started = performance.now();
	await run();
	return Math.round(performance.now() - started);
}

async function pbkdf2(passphrase: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
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

/** Print the numbers where a person on a phone can actually read them. */
export function reportBenchmark(results: KdfMeasurement[]): void {
	const lines = results.map((r) =>
		r.ms < 0 ? `${r.label}: failed, ${r.note}` : `${r.label}: ${r.ms} ms${r.note ? ` (${r.note})` : ""}`,
	);
	console.log("[lockstep-sync] key derivation on this device:\n" + lines.join("\n"));
	new Notice(lines.join("\n"), 30000);
}
