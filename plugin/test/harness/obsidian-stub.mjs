// SPDX-License-Identifier: MIT

/**
 * The parts of the Obsidian API the sync engine actually touches, implemented for
 * Node so the real engine can be driven headlessly.
 *
 * Only requestUrl is needed at runtime: everything else the engine imports from
 * Obsidian is a type and disappears at compile time.
 */

export async function requestUrl(options) {
	const { url, method = "GET", body, headers = {} } = options;
	const resp = await fetch(url, { method, body, headers });
	const buf = await resp.arrayBuffer();
	const text = new TextDecoder().decode(buf);
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {
		/* not every response is JSON, and that is fine */
	}
	const lower = {};
	resp.headers.forEach((v, k) => {
		lower[k.toLowerCase()] = v;
	});
	return { status: resp.status, headers: lower, arrayBuffer: buf, text, json };
}

export class TFile {}
export class TFolder {}

export class Notice {
	constructor(message) {
		this.message = message;
	}
	hide() {}
}

export function normalizePath(p) {
	return p;
}

// Node is not a phone. Tests that care about the name set it explicitly anyway.
export const Platform = { isPhone: false, isTablet: false, isDesktop: true, isMobile: false };
