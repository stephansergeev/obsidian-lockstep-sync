# Changelog

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
