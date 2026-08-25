# Changelog

## 1.0.4

The settings tab is declared rather than drawn, through the settings API that
arrived in Obsidian 1.13: every setting is indexed for the settings search, and
the framework re-evaluates which rows to show. The screen itself is unchanged.
minAppVersion is 1.13.0, since that API is what renders the tab.

## 1.0.3

The catalogue review's second pass. minAppVersion is 1.8.7, which is where
getLanguage() and Notice.messageEl appeared; the previous value promised more than
the code could keep. Event handlers no longer hand promises to the DOM, unload is
synchronous as the Plugin type expects, JSON from the server is typed at the one
place it is parsed, and the bundler takes Node's own list of built-in modules.

## 1.0.2

Large files on a phone. iOS suspends Obsidian whenever the screen goes dark, and a
40 MB download fetched in one request was lost each time and started over on the
next pass; a phone that was put down mid-download never got past that file. Files
over 4 MB are now fetched in 4 MB slices, each written to disk as it lands, and a
cut-off download resumes at the last whole slice. And a change that fails to apply
no longer stops the cursor: it is kept aside and tried again ahead of later passes,
with a wait that doubles each time, while everything behind it arrives.

## 1.0.1

Listed in the community catalogue on 2026-08-25; this release takes the automated
review's notes. The plugin sources moved to the repository root so the reviewer's
type checker can see Obsidian's types. The locale comes from `getLanguage()`, timers
go through `window`, and the default exclusions follow the vault's configuration
folder instead of assuming `.obsidian`. Release assets now carry GitHub provenance
attestations. The join page installs from the catalogue in one step; BRAT is no
longer part of it.

## 1.0.0

The release submitted to the community catalogue. Nothing new in it: 0.16.2 with the
number it has earned. Two-way sync through a server you run, line-level merge with
every conflict asked rather than decided, encryption of content and names with the
key derived on the device, encryption that can be turned on later, a join page for
new devices, and a first sync that sends notes before attachments. Tested on a vault
of 844 files and 1.19 GB, from a phone that started with no vault at all.

## 0.16.2

Progress on the phone. Obsidian mobile has no status bar, so a first sync there had
started and nothing on screen said how far it was. One notice now shows the
percentage, updated in place, and gives way to Done at the end. A readable vault
linked from the join page starts syncing without opening the settings first.

## 0.16.1

An Unlock & sync button beside the passphrase field for a device joining a vault
that is already encrypted. Leaving the field used to be the trigger, which on a
phone is nothing anybody does on purpose. Enter in the field presses whichever
button stands beside it.

## 0.16.0

Link a new device now makes a page on your own server, not a bare link. The page
puts the steps in order for the device that scans it: Obsidian with a vault open,
the plugin (through BRAT until the catalogue listing is live), then Connect. The
link carries a one-time code that turns into a token only when Connect is pressed,
and expires in fifteen minutes; a photographed screen is worthless by then. The
installer and `sync-server link` print the same page. If pressing a button leaves
the page in front, it points at the app store for that platform.

## 0.15.0

Encryption can be turned on for a vault that is already on the server. Encrypt
everything, in the settings, uploads every file again sealed and under a hidden name,
then erases the readable copies and their history at once. It first takes in anything
the server holds that the device does not, so nothing is erased that was never
re-uploaded; it continues from where it stopped if the app is closed halfway; and the
server accepts writes from no other device until it is done. A device that had the
vault readable joins afterwards by adopting what it already has, without downloading
it again, and keeps both versions of anything edited on both sides in the meantime.

## 0.14.1

Notes go first. A first sync sends text before images and images before everything
else, so the other device has every note readable within its first minute while the
gigabyte of PDFs is still on its way. A device catching up from nothing shows a
percentage of the files the server holds rather than a bare count.

## 0.14.0

The first real vault went through, and fixed three things on its way.

A vault that existed before the plugin was never uploaded: the watcher only reports
what happens after it starts, and that is none of the files anybody actually wants
to sync. Every pass now adopts files the index has never heard of and sends them.

The first sync ran at one file per round trip, four seconds for a small note, because
uploads went strictly one after another. Four are in flight now, and the index is
checkpointed on a clock instead of after every file, on both the sending and the
receiving side. The remaining 620 files of an 844-file vault went in under two minutes
where the first 224 had taken fourteen.

Unloading the plugin did not stop a running pass: an updated plugin's old copy kept
uploading beside its replacement for two minutes, sending every remaining file twice
and overwriting the journal on its way out. Every loop now stops at the next file once
the plugin is unloaded.

The settings screen is ordered by need: conflicts, the one-time initial sync decision
with a percentage and a done line, encryption as one state line plus a passphrase
field whose button sets it and syncs, and linking a new device. Everything typed once
sits under More settings, most-touched first. Creating a vault key happens only on that
button, never on the field losing focus, so a half-typed passphrase can no longer seal
a vault. The installer prints its setup link on a line of its own, clickable where the
terminal allows, with a QR code beside it and a command to mint a fresh one.

## 0.13.3

Creating the vault key now happens only on the Set button. It used to happen when the
passphrase field lost focus, and losing focus is what a half-typed passphrase does when
somebody pauses to think: the vault would have been sealed forever with a fragment its owner
never knew. Unlocking an existing vault still works on blur, where a fragment costs one
wrong-passphrase notice and nothing more.

Until Set is pressed on a fresh vault, nothing is created and nothing syncs, which also
closes the race where a large existing vault could start uploading in plaintext before its
owner reached the passphrase field.

## 0.13.2

The cipher is taken once per pass. Read live, it could be swapped by a settings blur
while an upload was still running, and the tail of that pass went up in plaintext.
Wiping the passphrase mid-pass now leaks nothing, and there is a test that swaps the
cipher between files to prove it. Restores and conflict resolutions answer to the
same barrier as a pass.

The installer no longer implies its link installs the plugin. It configures one that
is already installed, and now says so, with the install step first.

## 0.13.1

Ghost folders after a rename received on a desktop. The engine moved every file
correctly, then asked Obsidian to remove the emptied folder without the recursive
flag, and the desktop adapter throws EISDIR at exactly that call whatever the folder
contains. A silent catch ate the error, so desktops kept the empty old folder beside
the new one while phones, on a different adapter, cleaned up fine. Caught by the
decision journal on the affected machine and confirmed against a live Obsidian.

The folder is still verified empty first; only the flag changed. The test fake now
throws the way the real desktop adapter does, so the suite fails the way a Mac does
instead of passing on politeness the product never gets.

## 0.13.0

Three settings became none.

Encryption lost its switch. A passphrase is the intent: enter one and notes are sealed from
the server, leave it empty and they are stored as ordinary files. A switch that had to agree
with a field was a step that existed only to be forgotten, and the plugin was already
flipping it on people's behalf when a setup link arrived, which is what gave it away.

Automatic sync lost its switch. Nobody installs a sync plugin to turn syncing off, and the
manual case is fully served by the Sync now command.

Reset local index moved from the settings screen to the command palette. It is a service
lever, not a decision anybody makes about their own vault.

The settings screen is now: connection, passphrase, add a device, deleted files, retention.
Somebody whose sync works opens it for exactly one reason, to add a device.

## 0.12.0

The folder duplication is fixed at its root, which was not where it looked. The device
that renamed the folder was undoing itself: a pass started by pulling, at a moment when the
server still believed the old paths, so it downloaded its own just-moved files straight
back, then fought the arriving tombstones, kept the resurrected copies as local edits and
pushed them to every other device. Renames are now told to the server before anything is
read from it, and a path queued to move away is never touched by a pull.

Every comparison between disk and server now happens in ciphertext, the only currency both
sides hold. Deterministic encryption makes that possible: sealing the same bytes always
yields the same hash the server has. Earlier comparisons leaned on optional index fields
that were lost in enough places to matter, and a wounded record was misread as a local edit.

The engine keeps a decision journal in sync-log.txt beside the plugin, one line per branch
taken, so the next report of something syncing wrongly can carry the answer with it.

The check interval is fixed at fifteen seconds and the setting is gone. A check that finds
nothing costs one indexed query, and nobody has a reason to want it slower.

## 0.11.1

Renaming a folder in an encrypted vault duplicated it instead of moving it. Deciding whether
a file can be moved rather than downloaded compared the hash of the file on disk against the
hash the server holds. With encryption on those describe different bytes, plaintext against
ciphertext, so they never matched: every rename fell through to downloading a second copy
while the first stayed where it was, and the device that still had the old copy uploaded it
back, putting the duplicate on both devices.

The same confusion recorded the server's hash as the local one after a move, which made the
next deletion of that file look like an edit made here, so it was kept.

The default check interval is fifteen seconds. A check that finds nothing is one small
request, and Obsidian on a phone does not run in the background, so it only happens while
somebody is looking at the screen.

## 0.11.0

Renaming a folder no longer leaves the old one behind. A folder rename reaches another device
as its files moving one at a time; they landed correctly and the folder they came from stayed,
empty, looking exactly like a duplicate of the folder that had been renamed. Folders our own
move or deletion has emptied are now removed, and only those.

A vault starts syncing the moment it is unlocked instead of waiting for the next timer, which
meant a minute of nothing happening on a device that had just been told everything was fine.
The status bar counts files as they land, so a long first sync shows movement.

Test connection is gone. Everything it reported is on the settings screen already.

Nothing about a passphrase is said twice. Pressing unlock on a phone blurs the field first, so
two attempts arrived on one tap and both reported; a wrong passphrase was then announced again
by every pass that followed.

## 0.10.0

Setting a passphrase and entering an existing one are different acts, and only one of them
is permanent. Where a vault has no key yet the field says so before anything is typed: it is
written once, cannot be changed because everything stored is sealed with it, and cannot be
recovered.

What losing it costs is now stated accurately. Nothing on a device is encrypted, so every
device holding the vault keeps its notes. What becomes unreadable is the copy on the server,
along with its history and any device set up from it later.

Passphrase strength is a three-segment bar rather than three sentences. Words count for more
than characters, because four unrelated words are a larger space to search than fourteen
characters somebody had to think hard about. Nothing is refused: a short passphrase is
reported and then accepted, since the decision belongs to whoever owns the notes.

Adding a device suggests what that device probably is, phone from a desktop and desktop from
a phone, and an empty field is taken as agreement rather than reported as a mistake.

An unreachable server says so once, with the address it tried, instead of once a minute. It
also says the thing somebody in that moment needs to hear: edits wait on the device and go
when the server comes back.

A setup link finishes where the last step is. It opens this plugin's settings, and when the
vault turns out to be encrypted the switch is turned on and the passphrase field is focused.

The QR code lists its own contents in words beside it, and SECURITY.md explains why being
asked to scan something unreadable is a habit worth distrusting and what makes this one
different.

## 0.9.0

Adding a second device is a link now. Press **Add another device**, name it, and open the
link that comes out on the other device: Obsidian fills in the address and a token minted
for that device alone. The passphrase is deliberately not in the link, since a link travels
through messengers and the one secret that keeps the server from reading the vault should
not travel with it.

A vault that already has its passphrase unlocks by itself. The first attempt can happen
before the network is up, and pressing a button to recover from that is doing the software's
retry by hand.

Folders are no longer treated as files. Obsidian raises the same events for both, so every
folder was queued for upload and failed, once per folder, on every pass.

## 0.8.6

Two bugs found by joining an encrypted vault from a second device.

A device with no key downloaded the vault anyway, and tried to create files named
after ciphertext. The phone refused, once per file, filling the screen. It now checks
whether the vault has a key before touching anything and says which of the two things
is missing.

Worse, and the reason nothing synced afterwards: a change that failed to apply still
moved the cursor past itself. It was never in a later delta and nothing ever asked
for it again, so every failure lost an edit permanently. The cursor now stops where
the failure was, which turns a lost edit into a retried one.

Reading a vault with a key after reading it without now starts the delta over, since
everything read the first way was read wrongly.

## 0.8.0

Deleted notes are now erased for good after thirty days, and the window is a setting in the
plugin. "Deleted" has to mean gone eventually or the word is a lie, and until now a deletion
was recoverable forever whether anybody wanted that or not. Set it to zero to keep deletions
for good instead.

The sweep is the only thing on the server that deletes without being asked. It only touches
files that were already deleted and have outlived their window. The history of files that
still exist is never collected on a timer and still requires somebody to run gc.

## 0.7.0

Deleted files can be brought back. Every revision has been kept since the first version and
a deletion has always been a tombstone rather than an erasure, but none of it was reachable
without a terminal, which is a promise nobody could act on. The plugin now lists what is
gone and restores any of it on any device. Files whose content the collector has already
taken are left off the list: offering a restore that cannot happen is worse than offering
none.

A garbage collector, run by hand and never on a timer. A revision goes only if it is both
older than thirty days and buried under twenty newer ones, so a file edited fifty times this
morning keeps all fifty. Content is swept against the whole vault at once, because a blob is
shared between paths, and that also collects the orphans every conflict has been leaving
behind since the beginning.

## 0.6.0

File and folder names are encrypted along with content. A vault says a great deal through
its names alone, and until now the server could read every one of them. Each path segment is
sealed separately so the tree keeps its shape, deterministically so two devices agree on
where a file lives, with keys expanded from the same passphrase by HKDF but kept separate
from the content keys.

Whether a vault hides names is fixed when encryption is first set up. The two cannot be
mixed in one vault, and switching would leave every path unreadable to the client that
wrote it.

Docker as a second route, for machines that only run containers. There is no VOLUME line in
the Dockerfile and the compose file uses a bind mount, because a named volume is what
`docker compose down -v` destroys and what would be destroyed here is every note.

## 0.5.7

Release artefacts are built by GitHub Actions from the tagged commit rather than on a
laptop, and every release now carries `SHA256SUMS`. For a project that encrypts other
people's notes, "trust the author's machine" is not an answer.

Added `SECURITY.md`, which states plainly what the design assumes: the server is not trusted
with content, the token is the access boundary, transport is the deployment's job, and
losing the passphrase loses the notes. Added `CONTRIBUTING.md` and an issue template that
asks first whether anything disappeared.

## 0.5.6

The installer no longer assumes it is the only thing on the machine. It looks at what
answers on port 443 and adapts: Caddy on an empty machine, an nginx site where nginx already
serves something, and nothing at all where something else holds the port.

## 0.5.5

One command to stand up a server, and Linux binaries in the release so nobody needs a Go
toolchain.

## 0.5.4

A rename that only changes capitalisation now reaches other devices. On macOS, iOS and
Windows the filesystem does not treat case as part of a name, so the check for a taken
destination was answering yes about the source file.

## 0.5.3

Found by a new harness that drives the real engine against a real server with two vaults:
deleting a file on the device that created it undid itself, because a pass pulls before it
pushes and the file came back down before the deletion was ever sent. Conflicts also named
the other device by its token rather than by the name its owner chose.

## 0.5.1

Conflicts name both sides by device. "Keep the server's" told nobody anything.

## 0.5.0

Argon2id, decided by measurement: on an iPhone it takes 172 ms against 227 ms for PBKDF2 at
600,000 iterations. Cheaper for the person waiting and far more expensive to attack.

The conflict question now carries its answers, rather than sending anybody to a settings
screen.

## 0.4.0

Encryption. Content is sealed with AES-256-GCM before upload, the key never leaves the
device, and a wrong passphrase stops the sync rather than falling back to plaintext.

## 0.3.0

Conflicts became a question instead of a merge behind your back. Both whole versions stay on
disk and the plugin asks which one stands.

## 0.2.0

Two-way sync: a vault watcher, an upload queue, three-way merging, and renames that travel
as renames.

## 0.1.0

The server, the protocol and the test harness. The plugin could read a vault from the server
and nothing more.
