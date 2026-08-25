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
	"settings.serverVault.name": "Syncing with vault",
	"settings.serverVault.desc":
		"The name this vault has on the server, which is set when its first token is issued. It is unrelated to what the vault is called in Obsidian: that name never leaves the device.",
	"settings.serverVault.unknown": "not connected",
	"settings.device.name": "Device name",
	"settings.device.desc":
		"Used in conflict copy names, so you can tell which device an edit came from.",
	"settings.excludes.name": "Exclusions",
	"settings.excludes.desc": "One path or prefix per line. These files never leave this device.",

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

	"settings.retention.name": "Erase deleted files after",
	"settings.retention.desc":
		"Deleting a note does not destroy it. It stays on the server and can be brought back for this many days, then it is erased for good. Set it to 0 to keep deleted notes forever. This is a setting of the vault, so every device follows it.",
	"settings.retention.unit": "days",
	"settings.retention.forever": "Deleted notes are kept forever on this vault.",
	"settings.retention.saved": "Deleted notes are erased after {days} days",
	"restore.title": "Deleted files",
	"restore.loading": "Asking the server what it still has…",
	"restore.none": "Nothing to bring back. Every deletion here has been forgotten or never happened.",
	"restore.intro":
		"Deleting a file never erased it. These are still on the server, with the last version that had anything in it.",
	"restore.detail": "deleted {when}",
	"restore.button": "Bring it back",
	"restore.done": "{path} is back",
	"cmd.restore": "Bring back a deleted file",
	"settings.restore.name": "Deleted files",
	"settings.restore.desc": "Nothing is erased. Look at what is still recoverable and bring any of it back.",
	"settings.restore.button": "Open",

	"settings.encrypt.name": "Encrypt content",
	"settings.encrypt.descNew":
		"To store files encrypted, enter a passphrase and set it: sync starts on its own, encrypted. It cannot be changed or recovered later.",
	"settings.encrypt.descExisting": "Same passphrase as on your other devices.",
	"settings.encrypt.placeholder": "passphrase",
	"settings.encrypt.set": "Set passphrase & sync",
	"settings.encrypt.setTip":
		"Seals this vault with the passphrase as it is right now. Until this is pressed, nothing is created and nothing syncs.",
	"encryption.firstSyncChoice":
		"First sync: {count} files will go to your server as they are. Press Sync now if that is the plan. To encrypt them, set a passphrase first. Encryption can also be turned on later.",
	"encryption.pressSet": "Passphrase typed but not set yet. Press Set passphrase when it is complete.",
	"cmd.resetIndex": "Reset the local sync index",
	"settings.passphrase.weak": "Weak. Short passphrases are easy to crack.",
	"settings.passphrase.medium": "Medium. Four unrelated words would be stronger.",
	"settings.passphrase.strong": "Strong.",

	"encryption.off": "Encryption is off. The server can read your notes.",
	"encryption.locked": "Enter the passphrase to unlock this vault.",
	"encryption.vaultIsEncrypted":
		"This vault is encrypted. Enter its passphrase in the plugin settings. Nothing is downloaded until then, because without the key the files arrive unreadable and under unreadable names.",
	"encryption.ready": "Unlocked. New uploads are encrypted.",
	"encryption.readyWithPaths": "Unlocked. Content and file names are both hidden from the server.",
	"encryption.created": "Encryption set up for this vault. Keep the passphrase safe.",
	"banner.hidden": "Encrypted",
	"banner.hiddenNames": "Encrypted, file names included",
	"banner.locked": "Waiting for the passphrase",
	"banner.open": "Not encrypted",
	"encryption.namesStayVisible":
		"This vault already holds files, so their names stay visible to the server. Content from now on is encrypted. To hide names as well, set encryption up on an empty vault before putting anything in it.",
	"encryption.wrong": "Wrong passphrase for this vault.",
	"encryption.failed": "Could not unlock: {message}",


	"cmd.addDevice": "Add another device",
	"settings.addDevice.name": "Link a new device",
	"settings.addDevice.desc": "A code and a link that set up your phone or laptop in one tap.",
	"settings.addDevice.button": "Link device",
	"settings.initial.name": "Initial sync",
	"settings.initial.desc":
		"One press, once: your {count} files go to the server as they are, not encrypted, and from then on syncing is fully automatic. To encrypt them instead, set a passphrase below and it starts on its own.",
	"settings.initial.button": "Initial sync",
	"progress.plain": "Syncing: {pct}% ({done} of {total})",
	"progress.encrypted": "Encrypted sync: {pct}% ({done} of {total})",
	"progress.done": "Done. All files synced.",
	"progress.doneEncrypted": "Done. All files synced, encrypted.",
	"settings.section.more": "More settings",
	"add.title": "Add another device",
	"add.intro":
		"This makes a link for one device. Open it on that device and Obsidian fills in the settings. Give each device its own, so losing one means revoking one.",
	"add.name": "What to call it",
	"add.nameDesc":
		"Filled in with the likely answer. Shown when two devices change the same file and one of them has to be chosen.",
	"add.create": "Create the link",
	"add.ready":
		"Obsidian has to be installed on the other device already, with a vault open and this plugin in it.",
	"add.scan":
		"Point the other device's camera at this screen. Nothing is sent anywhere: the code holds the same link printed below it.",
	"add.contents": "Everything the code contains",
	"add.contentsUrl": "The address of your server: {url}",
	"add.contentsToken": "A token issued a moment ago for the device called {device}, and for nothing else",
	"add.contentsNothingElse":
		"Nothing further. Not your passphrase, not your notes, and nothing that runs on its own.",
	"add.orLink":
		"Or take the link. Paste it into a browser or a message on the other device and opening it starts Obsidian already configured.",
	"add.copy": "Copy link",
	"add.copyManually": "Could not reach the clipboard. The link is selected, copy it by hand.",
	"add.openHere": "Open on this device",
	"add.openHereTip": "Applies these settings to the vault open right here, which is mostly useful for checking the link works.",
	"add.copied": "Copied",
	"add.passphraseSeparately":
		"The passphrase is not in the link, on purpose. Type it on the other device yourself.",
	"add.linkBroken": "That setup link is missing the address or the token.",
	"add.linkApplied": "Set up for vault {vault}. Syncing now.",
	"add.linkAppliedEncrypted":
		"Set up for vault {vault}, which is encrypted. Enter its passphrase to start syncing.",

	"cmd.sync": "Sync now",

	"notice.syncing": "Lockstep: syncing…",
	"notice.syncDone": "Lockstep: {summary}",

	"status.syncing": "syncing…",
	"status.progress": "{done} in, {path}",
	"status.syncSummary":
		"in {secs}s: {downloaded} down, {uploaded} up, {merged} merged, {conflicts} conflicts",
	"status.upToDate": "up to date, seq {seq}",

	"error.sync": "Sync",

	"cmd.pull": "Download everything from the server",

	"notice.noConfig": "Lockstep: server URL or token is missing",
	"notice.pullStarted": "Lockstep: downloading…",
	"notice.pullDone": "Lockstep: {summary}",
	"notice.indexReset": "Index reset",
	"notice.unreachable":
		"Lockstep: no answer from {url}. Check the address in the settings, and that the server is running. Nothing is lost while it is away: edits wait here and go when it comes back.",
	"notice.error": "Lockstep — {what}: {message}",

	"status.prefix": "Lockstep",
	"status.encrypted": "encrypted",
	"status.lockedShort": "locked",
	"status.notConnected": "not connected",
	"status.index": "index: {files} files, seq {seq}",
	"status.indexReset": "index reset",
	"status.error": "error: {message}",
	"status.pullSummary": "downloaded {downloaded}, skipped {skipped}, copies kept {kept} in {secs}s",

	"error.pull": "Download",
	"error.corruptDownload": "corrupt download of {path}: expected {want}, got {got}",

	"conflict.label": "this device",
};

const ru: Dict = {
	"settings.serverUrl.name": "Адрес сервера",
	"settings.serverUrl.desc": "Например https://sync.example.com — без /v1 на конце.",
	"settings.token.name": "Токен устройства",
	"settings.token.desc":
		"Выдаётся командой sync-server token add --name <устройство>. Показывается один раз.",
	"settings.serverVault.name": "Синхронизируется с волтом",
	"settings.serverVault.desc":
		"Имя этого волта на сервере, оно задаётся при выдаче первого токена. С именем волта в Obsidian не связано никак: то имя устройство никуда не отправляет.",
	"settings.serverVault.unknown": "нет соединения",
	"settings.device.name": "Имя устройства",
	"settings.device.desc":
		"Подставляется в имена конфликтных копий, чтобы было видно, откуда правка.",
	"settings.excludes.name": "Исключения",
	"settings.excludes.desc": "По строке на путь или префикс. Эти файлы не уезжают с устройства.",

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
	"notice.unreachable":
		"Lockstep: {url} не отвечает. Проверь адрес в настройках и что сервер запущен. Пока его нет, ничего не теряется: правки ждут здесь и уедут, когда он вернётся.",

	"settings.retention.name": "Стирать удалённое через",
	"settings.retention.desc":
		"Удаление заметки её не уничтожает. Она остаётся на сервере и её можно вернуть столько дней, сколько здесь указано, потом стирается насовсем. Ноль — хранить удалённое вечно. Это настройка волта, ей следуют все устройства.",
	"settings.retention.unit": "дней",
	"settings.retention.forever": "Удалённые заметки хранятся в этом волте вечно.",
	"settings.retention.saved": "Удалённое стирается через {days} дней",
	"restore.title": "Удалённые файлы",
	"restore.loading": "Спрашиваю сервер, что у него осталось…",
	"restore.none": "Возвращать нечего. Все удаления здесь либо забыты, либо их не было.",
	"restore.intro":
		"Удаление файла никогда его не стирало. Эти лежат на сервере вместе с последней версией, в которой что-то было.",
	"restore.detail": "удалён {when}",
	"restore.button": "Вернуть",
	"restore.done": "{path} на месте",
	"cmd.restore": "Вернуть удалённый файл",
	"settings.restore.name": "Удалённые файлы",
	"settings.restore.desc": "Ничего не стирается. Посмотри, что ещё можно вернуть, и верни.",
	"settings.restore.button": "Открыть",

	"settings.encrypt.name": "Шифровать содержимое",
	"settings.encrypt.descNew":
		"Чтобы хранить файлы зашифрованными, введи пароль и задай его: синхронизация начнётся сама, зашифрованной. Потом его нельзя ни сменить, ни восстановить.",
	"settings.encrypt.descExisting": "Тот же пароль, что на других твоих устройствах.",
	"settings.encrypt.placeholder": "пароль",
	"settings.encrypt.set": "Задать пароль и синкать",
	"settings.encrypt.setTip":
		"Запечатывает волт паролем ровно в его текущем виде. Пока кнопка не нажата, ничего не создаётся и не синкается.",
	"encryption.firstSyncChoice":
		"Первый синк: {count} файлов уйдут на твой сервер как есть. Нажми Sync now, если так и задумано. Чтобы шифровать, сначала задай пароль. Включить шифрование можно и позже.",
	"encryption.pressSet": "Пароль набран, но ещё не задан. Нажми Задать пароль, когда допишешь.",
	"cmd.resetIndex": "Сбросить локальный индекс синхронизации",
	"settings.passphrase.weak": "Слабый. Короткий пароль легко взломать.",
	"settings.passphrase.medium": "Средний. Четыре несвязанных слова были бы крепче.",
	"settings.passphrase.strong": "Сильный.",

	"encryption.off": "Шифрование выключено. Сервер видит твои заметки.",
	"encryption.locked": "Введи пароль, чтобы открыть волт.",
	"encryption.vaultIsEncrypted":
		"Этот волт зашифрован. Введи его пароль в настройках плагина. До этого ничего не скачивается: без ключа файлы приедут нечитаемыми и под нечитаемыми именами.",
	"encryption.ready": "Открыто. Новые загрузки шифруются.",
	"encryption.readyWithPaths": "Открыто. И содержимое, и имена файлов скрыты от сервера.",
	"encryption.created": "Шифрование настроено для этого волта. Сохрани пароль.",
	"banner.hidden": "Зашифрован",
	"banner.hiddenNames": "Зашифрован, включая имена файлов",
	"banner.locked": "Ждёт пароль",
	"banner.open": "Не зашифрован",
	"encryption.namesStayVisible":
		"В волте уже есть файлы, поэтому их имена останутся видны серверу. Содержимое с этого момента шифруется. Чтобы скрыть и имена, включай шифрование на пустом волте, до того как в него что-то попадёт.",
	"encryption.wrong": "Неверный пароль для этого волта.",
	"encryption.failed": "Не удалось открыть: {message}",


	"cmd.addDevice": "Добавить устройство",
	"settings.addDevice.name": "Подключить новое устройство",
	"settings.addDevice.desc": "Код и ссылка, которые настраивают телефон или ноутбук в одно касание.",
	"settings.addDevice.button": "Подключить",
	"settings.initial.name": "Первый синк",
	"settings.initial.desc":
		"Одно нажатие, один раз: {count} файлов уйдут на сервер как есть, без шифрования, а дальше синхронизация полностью автоматическая. Чтобы зашифровать, задай пароль ниже: она начнётся сама.",
	"settings.initial.button": "Первый синк",
	"progress.plain": "Синхронизация: {pct}% ({done} из {total})",
	"progress.encrypted": "Шифрованная синхронизация: {pct}% ({done} из {total})",
	"progress.done": "Готово. Все файлы синхронизированы.",
	"progress.doneEncrypted": "Готово. Все файлы синхронизированы, зашифрованы.",
	"settings.section.more": "Остальные настройки",
	"add.title": "Добавить устройство",
	"add.intro":
		"Ссылка делается для одного устройства. Открой её там, и Obsidian сам заполнит настройки. Каждому устройству — своя, чтобы потеря одного означала отзыв одного.",
	"add.name": "Как его назвать",
	"add.nameDesc":
		"Заполнено наиболее вероятным вариантом. Показывается, когда два устройства правят один файл и надо выбрать версию.",
	"add.create": "Создать ссылку",
	"add.ready":
		"На другом устройстве уже должен стоять Obsidian, с открытым волтом и этим плагином.",
	"add.scan":
		"Наведи камеру другого устройства на этот экран. Ничего никуда не отправляется: в коде та же ссылка, что напечатана ниже.",
	"add.contents": "Что именно в этом коде",
	"add.contentsUrl": "Адрес твоего сервера: {url}",
	"add.contentsToken": "Токен, выпущенный минуту назад для устройства «{device}» и ни для чего больше",
	"add.contentsNothingElse":
		"Больше ничего. Ни пароля, ни заметок, ни чего-либо, что выполняется само.",
	"add.orLink":
		"Или возьми ссылку. Вставь её в браузер или в сообщение на другом устройстве: при открытии запустится Obsidian уже настроенным.",
	"add.copy": "Скопировать ссылку",
	"add.copyManually": "Не получилось обратиться к буферу обмена. Ссылка выделена, скопируй руками.",
	"add.openHere": "Открыть здесь",
	"add.openHereTip": "Применит эти настройки к волту, открытому прямо здесь. Нужно в основном чтобы проверить, что ссылка работает.",
	"add.copied": "Скопировано",
	"add.passphraseSeparately":
		"Пароля в ссылке нет, и это намеренно. Введи его на другом устройстве сам.",
	"add.linkBroken": "В этой ссылке нет адреса или токена.",
	"add.linkApplied": "Настроено на волт {vault}. Синхронизирую.",
	"add.linkAppliedEncrypted":
		"Настроено на волт {vault}, он зашифрован. Введи пароль, чтобы началась синхронизация.",

	"cmd.sync": "Синхронизировать сейчас",

	"notice.syncing": "Lockstep: синхронизирую…",
	"notice.syncDone": "Lockstep: {summary}",

	"status.syncing": "синхронизирую…",
	"status.progress": "принято {done}, {path}",
	"status.syncSummary":
		"за {secs}с: скачано {downloaded}, отправлено {uploaded}, слито {merged}, конфликтов {conflicts}",
	"status.upToDate": "всё синхронно, seq {seq}",

	"error.sync": "Синхронизация",

	"cmd.pull": "Скачать всё с сервера",

	"notice.noConfig": "Lockstep: не заданы адрес сервера или токен",
	"notice.pullStarted": "Lockstep: скачиваю…",
	"notice.pullDone": "Lockstep: {summary}",
	"notice.indexReset": "Индекс сброшен",
	"notice.error": "Lockstep — {what}: {message}",

	"status.prefix": "Lockstep",
	"status.encrypted": "зашифровано",
	"status.lockedShort": "закрыто",
	"status.notConnected": "не подключено",
	"status.index": "индекс: {files} файлов, seq {seq}",
	"status.indexReset": "индекс сброшен",
	"status.error": "ошибка: {message}",
	"status.pullSummary": "скачано {downloaded}, пропущено {skipped}, копий сохранено {kept} за {secs}с",

	"error.pull": "Скачивание",
	"error.corruptDownload": "битая загрузка {path}: ожидали {want}, получили {got}",

	"conflict.label": "это устройство",
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
