# Changelog

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
