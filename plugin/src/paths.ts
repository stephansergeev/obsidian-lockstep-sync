// SPDX-License-Identifier: MIT

/**
 * Пути волта. Единственное место, где решается, как путь выглядит на проводе.
 *
 * NFC обязателен: macOS отдаёт имена файлов в NFD, а Windows и Android — в NFC.
 * Если не нормализовать до отправки, «Ёлка.md» с двух устройств станет двумя
 * разными файлами, визуально неразличимыми. Сервер такие пути отвергает —
 * нормализуем здесь, чтобы до сервера они не доехали.
 */
export function toNFC(path: string): string {
	return path.normalize("NFC");
}

/** Кодирование пути в query-параметр: слэши остаются читаемыми, остальное экранируется. */
export function encodePath(path: string): string {
	return encodeURIComponent(toNFC(path)).replace(/%2F/g, "/");
}

/** Имя для копии, которую кладём рядом, когда перезаписывать нельзя. */
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

/** sha256 в hex — тот же адрес содержимого, что считает сервер. */
export async function sha256(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}
