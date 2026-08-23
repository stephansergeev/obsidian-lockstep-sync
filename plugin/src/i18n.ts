// SPDX-License-Identifier: MIT

/**
 * Tiny translation layer.
 *
 * English is the default and the only complete locale — every other language
 * falls back to it key by key, so a missing translation degrades to English
 * instead of showing a raw key. Obsidian ships no i18n API for plugins, so the
 * dictionary lives here.
 */

type Dict = Record<string, string>;

const en: Dict = {
	"settings.serverUrl.name": "Server URL",
	"settings.serverUrl.desc": "For example https://sync.example.com — without the trailing /v1.",
	"settings.token.name": "Device token",
	"settings.token.desc":
		"Issued by sync-server token add --name <device>. Shown once, on the server.",
	"settings.device.name": "Device name",
	"settings.device.desc":
		"Used in conflict copy names, so you can tell which device an edit came from.",
	"settings.excludes.name": "Exclusions",
	"settings.excludes.desc": "One path or prefix per line. These files never leave this device.",
	"settings.section.maintenance": "Check and maintenance",
	"settings.test.name": "Test connection",
	"settings.test.desc": "Calls /health and /stats — tells you at once if the token and vault are right.",
	"settings.test.button": "Test",
	"settings.pull.name": "Download everything from the server",
	"settings.pull.desc":
		"One-way for now: local files are never deleted, and anything that differs is kept as a copy alongside. Nothing is overwritten silently.",
	"settings.pull.button": "Download",
	"settings.reset.name": "Reset local index",
	"settings.reset.desc": "The index is rebuilt on the next download. Vault files are left alone.",
	"settings.reset.button": "Reset",

	"cmd.test": "Test connection to the server",
	"cmd.pull": "Download everything from the server",

	"notice.noConfig": "Lockstep: server URL or token is missing",
	"notice.connected": "Lockstep: connected — {info}",
	"notice.pullStarted": "Lockstep: downloading…",
	"notice.pullDone": "Lockstep: {summary}",
	"notice.indexReset": "Index reset",
	"notice.error": "Lockstep — {what}: {message}",

	"status.prefix": "Lockstep",
	"status.notConnected": "not connected",
	"status.index": "index: {files} files, seq {seq}",
	"status.indexReset": "index reset",
	"status.error": "error: {message}",
	"status.stats": "vault {vault}, {files} files, seq {seq}",
	"status.pullSummary": "downloaded {downloaded}, skipped {skipped}, copies kept {kept} in {secs}s",

	"error.testConnection": "Connection test",
	"error.pull": "Download",
	"error.corruptDownload": "corrupt download of {path}: expected {want}, got {got}",

	"conflict.label": "local",
};

const ru: Dict = {
	"settings.serverUrl.name": "Адрес сервера",
	"settings.serverUrl.desc": "Например https://sync.example.com — без /v1 на конце.",
	"settings.token.name": "Токен устройства",
	"settings.token.desc":
		"Выдаётся командой sync-server token add --name <устройство>. Показывается один раз.",
	"settings.device.name": "Имя устройства",
	"settings.device.desc":
		"Подставляется в имена конфликтных копий, чтобы было видно, откуда правка.",
	"settings.excludes.name": "Исключения",
	"settings.excludes.desc": "По строке на путь или префикс. Эти файлы не уезжают с устройства.",
	"settings.section.maintenance": "Проверка и обслуживание",
	"settings.test.name": "Проверить соединение",
	"settings.test.desc": "Дёргает /health и /stats — сразу видно, тот ли токен и тот ли волт.",
	"settings.test.button": "Проверить",
	"settings.pull.name": "Скачать всё с сервера",
	"settings.pull.desc":
		"Пока односторонняя операция: локальные файлы не удаляются, а расхождения сохраняются копией рядом. Ничего не перезаписывается молча.",
	"settings.pull.button": "Скачать",
	"settings.reset.name": "Сбросить локальный индекс",
	"settings.reset.desc": "Индекс перестроится при следующем скачивании. Файлы волта не трогаются.",
	"settings.reset.button": "Сбросить",

	"cmd.test": "Проверить соединение с сервером",
	"cmd.pull": "Скачать всё с сервера",

	"notice.noConfig": "Lockstep: не заданы адрес сервера или токен",
	"notice.connected": "Lockstep: соединение есть — {info}",
	"notice.pullStarted": "Lockstep: скачиваю…",
	"notice.pullDone": "Lockstep: {summary}",
	"notice.indexReset": "Индекс сброшен",
	"notice.error": "Lockstep — {what}: {message}",

	"status.prefix": "Lockstep",
	"status.notConnected": "не подключено",
	"status.index": "индекс: {files} файлов, seq {seq}",
	"status.indexReset": "индекс сброшен",
	"status.error": "ошибка: {message}",
	"status.stats": "волт {vault}, файлов {files}, seq {seq}",
	"status.pullSummary": "скачано {downloaded}, пропущено {skipped}, копий сохранено {kept} за {secs}с",

	"error.testConnection": "Проверка соединения",
	"error.pull": "Скачивание",
	"error.corruptDownload": "битая загрузка {path}: ожидали {want}, получили {got}",

	"conflict.label": "локальная",
};

const locales: Record<string, Dict> = { ru };

/**
 * Obsidian's UI language. getLanguage() is the supported API, but it is not
 * present in every version this plugin claims to support, so the older
 * localStorage key stays as a fallback.
 */
function currentLocale(): string {
	try {
		const api = (globalThis as { getLanguage?: () => string }).getLanguage;
		if (typeof api === "function") return api();
	} catch {
		/* fall through to the storage probe below */
	}
	try {
		return window.localStorage.getItem("language") ?? "en";
	} catch {
		return "en";
	}
}

export function t(key: keyof typeof en, vars?: Record<string, string | number>): string {
	const lang = currentLocale().toLowerCase().split("-")[0] ?? "en";
	const template = locales[lang]?.[key] ?? en[key] ?? key;
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		name in vars ? String(vars[name]) : whole,
	);
}
