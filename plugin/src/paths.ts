// SPDX-License-Identifier: MIT

import { Platform } from "obsidian";

/**
 * Vault paths. The single place that decides how a path looks on the wire.
 *
 * NFC is mandatory: macOS hands out filenames in NFD while Windows and Android
 * use NFC. Without normalising before sending, the same visible name arrives as
 * two different files from two devices. The server rejects non-NFC paths, so
 * they are normalised here and never reach it.
 */
export function toNFC(path: string): string {
	return path.normalize("NFC");
}

/** Encode a path for a query parameter: slashes stay readable, the rest is escaped. */
export function encodePath(path: string): string {
	return encodeURIComponent(toNFC(path)).replace(/%2F/g, "/");
}

/** Name for the copy kept alongside when overwriting is not allowed. */
export function conflictName(path: string, label: string, when: Date): string {
	const stamp =
		`${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}` +
		` ${pad(when.getHours())}.${pad(when.getMinutes())}`;
	const dot = path.lastIndexOf(".");
	const slash = path.lastIndexOf("/");
	if (dot > slash && dot !== -1) {
		return `${path.slice(0, dot)} (${label} ${stamp})${path.slice(dot)}`;
	}
	return `${path} (${label} ${stamp})`;
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** sha256 as hex — the same content address the server computes. */
export async function sha256(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * What to call this device before anybody names it.
 *
 * Named after what the device is rather than what it is likely to be. A default of
 * "iphone" is wrong on every Android in the world, and a person setting up sync on
 * one of them should not have to correct the software's assumption about them
 * before they can use it.
 */
export function defaultDeviceName(): string {
	if (Platform.isPhone) return "phone";
	if (Platform.isTablet) return "tablet";
	return "desktop";
}

/**
 * What the device being added is probably called.
 *
 * Somebody adding a device from a desktop is almost always adding a phone, and the
 * other way round. Guessing right most of the time is better than an empty field,
 * and guessing wrong costs one edit.
 */
export function suggestedOtherDevice(): string {
	return Platform.isPhone || Platform.isTablet ? "desktop" : "phone";
}
