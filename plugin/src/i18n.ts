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

	"conflict.title": "Files changed on both sides",
	"conflict.none": "Nothing to decide. Every file is in step.",
	"conflict.intro":
		"Both versions are on disk and neither has been changed. Read them and say which one stands.",
	"conflict.detail": "changed on {device} and on {other}, {when}",
	"conflict.openServer": "open the version from {device}",
	"conflict.openMine": "open the version from {device}",
	"conflict.notMergeable":
		"Too large, or not text. Both files are kept, but they cannot be merged line by line.",
	"conflict.keepBoth": "Keep both edits",
	"conflict.keepBoth.tooltip":
		"Nothing is discarded. Both texts go into the note, marked, so you can settle them in one place.",
	"conflict.keepMine": "Keep the version from {device}",
	"conflict.keepMine.tooltip": "Take the version written on this device and drop the other.",
	"conflict.keepServer": "Keep the version from {device}",
	"conflict.keepServer.unknown": "Keep the version from the server",
	"conflict.serverFallback": "the server",
	"conflict.keepServer.tooltip": "Take the version already on the server and drop this device's.",
	"conflict.resolved": "{path} settled",
	"conflict.gone": "{path} is no longer in the vault",
	"conflict.pending": "{count} to decide",
	"cmd.conflicts": "Resolve files changed on both sides",
	"notice.conflictQueued": "Lockstep: {path} was changed on both sides. Both versions are kept.",

	"settings.section.encryption": "Encryption",
	"settings.encryption.name": "Encrypt content",
	"settings.encryption.desc":
		"Notes are encrypted on this device before they are uploaded. The server keeps bytes it cannot read. File and folder names are still visible to it.",
	"settings.passphrase.name": "Passphrase",
	"settings.passphrase.desc":
		"The same passphrase on every device. It never leaves them. Lose it and the notes are gone, there is nobody to ask.",
	"settings.passphrase.button": "Unlock",
	"encryption.off": "Encryption is off. The server can read your notes.",
	"encryption.locked": "Enter the passphrase to unlock this vault.",
	"encryption.ready": "Unlocked. New uploads are encrypted.",
	"encryption.created": "Encryption set up for this vault. Keep the passphrase safe.",
	"encryption.wrong": "Wrong passphrase for this vault.",
	"encryption.failed": "Could not unlock: {message}",

	"settings.autoSync.name": "Sync automatically",
	"settings.autoSync.desc":
		"Sync a few seconds after an edit, on a timer, and when the app goes to the background.",
	"settings.interval.name": "Timer interval",
	"settings.interval.desc": "Seconds between background passes. Minimum 15.",
	"settings.sync.name": "Sync now",
	"settings.sync.desc": "Take what the server has, then send what this device has.",
	"settings.sync.button": "Sync",

	"cmd.sync": "Sync now",

	"notice.syncing": "Lockstep: syncing…",
	"notice.syncDone": "Lockstep: {summary}",

	"status.syncing": "syncing…",
	"status.syncSummary":
		"in {secs}s: {downloaded} down, {uploaded} up, {merged} merged, {conflicts} conflicts",
	"status.upToDate": "up to date, seq {seq}",

	"error.sync": "Sync",

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

	"conflict.title": "Файлы, изменённые с двух сторон",
	"conflict.none": "Решать нечего. Все файлы идут в ногу.",
	"conflict.intro":
		"Обе версии лежат на диске, ни одна не тронута. Посмотри их и скажи, какая остаётся.",
	"conflict.detail": "правили на {device} и на {other}, {when}",
	"conflict.openServer": "открыть версию с {device}",
	"conflict.openMine": "открыть версию с {device}",
	"conflict.notMergeable":
		"Слишком большой файл или не текст. Обе версии сохранены, но построчно свести их нельзя.",
	"conflict.keepBoth": "Сохранить все правки",
	"conflict.keepBoth.tooltip":
		"Ничего не выбрасывается. Оба текста ложатся в заметку с пометками, чтобы свести их в одном месте.",
	"conflict.keepMine": "Оставить версию с {device}",
	"conflict.keepMine.tooltip": "Взять версию, написанную на этом устройстве, другую убрать.",
	"conflict.keepServer": "Оставить версию с {device}",
	"conflict.keepServer.unknown": "Оставить версию с сервера",
	"conflict.serverFallback": "сервера",
	"conflict.keepServer.tooltip": "Взять версию, которая уже на сервере, эту убрать.",
	"conflict.resolved": "{path} решено",
	"conflict.gone": "{path} больше нет в волте",
	"conflict.pending": "решить: {count}",
	"cmd.conflicts": "Разобрать файлы, изменённые с двух сторон",
	"notice.conflictQueued": "Lockstep: {path} правили с двух сторон. Обе версии сохранены.",

	"settings.section.encryption": "Шифрование",
	"settings.encryption.name": "Шифровать содержимое",
	"settings.encryption.desc":
		"Заметки шифруются на этом устройстве до отправки. Сервер хранит байты, которые не может прочитать. Имена файлов и папок ему по-прежнему видны.",
	"settings.passphrase.name": "Пароль",
	"settings.passphrase.desc":
		"Один и тот же пароль на всех устройствах. Он никуда не уходит. Потеряешь его — заметки потеряны, спросить не у кого.",
	"settings.passphrase.button": "Открыть",
	"encryption.off": "Шифрование выключено. Сервер видит твои заметки.",
	"encryption.locked": "Введи пароль, чтобы открыть волт.",
	"encryption.ready": "Открыто. Новые загрузки шифруются.",
	"encryption.created": "Шифрование настроено для этого волта. Сохрани пароль.",
	"encryption.wrong": "Неверный пароль для этого волта.",
	"encryption.failed": "Не удалось открыть: {message}",

	"settings.autoSync.name": "Синхронизировать автоматически",
	"settings.autoSync.desc":
		"Синк через несколько секунд после правки, по таймеру и при сворачивании приложения.",
	"settings.interval.name": "Интервал таймера",
	"settings.interval.desc": "Секунд между фоновыми проходами. Минимум 15.",
	"settings.sync.name": "Синхронизировать сейчас",
	"settings.sync.desc": "Забрать то, что есть на сервере, затем отправить то, что есть здесь.",
	"settings.sync.button": "Синхронизировать",

	"cmd.sync": "Синхронизировать сейчас",

	"notice.syncing": "Lockstep: синхронизирую…",
	"notice.syncDone": "Lockstep: {summary}",

	"status.syncing": "синхронизирую…",
	"status.syncSummary":
		"за {secs}с: скачано {downloaded}, отправлено {uploaded}, слито {merged}, конфликтов {conflicts}",
	"status.upToDate": "всё синхронно, seq {seq}",

	"error.sync": "Синхронизация",

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
