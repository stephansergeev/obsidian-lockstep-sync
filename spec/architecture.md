# Who does what: the server and the plugin

## In one line

**The server is an ordered log and a store of bytes. All the intelligence lives in the plugin.**

The line is drawn there on purpose. The server has to be dumb enough that it cannot corrupt
anything and small enough to be rewritten over a weekend in another language. Everything
that needs to understand text, vaults or platforms belongs on the client, where Obsidian is.

## The server is responsible for

**Order.** A single monotonic `seq` counter per vault. Whoever wrote first is first in the
log. That removes any need for version vectors or distributed consensus.

**Storage.** Metadata in SQLite, content as files named by their sha256.

**The delta.** `GET /changes?since=N` answers what changed since a cursor. A client never
walks the vault tree.

**Detecting a conflict.** A client sends a `base_rev` lower than the current one and the
server answers 409 with its own revision and hash. **Resolving the conflict is not something
the server can or should do.**

**History.** Every revision stays reachable by number. Without that a client has nowhere to
get the common ancestor a 3-way merge needs.

**Authentication and isolation.** A token is a device and a vault. Vaults cannot see each
other.

**Atomic operations.** A rename is one transaction, not a delete followed by a create.

## The server does not know

What markdown is, what a note or a link is, or that Obsidian exists at all. What the client
filesystem looks like. The encryption key: content arrives already encrypted and the server
holds opaque bytes. Which client is right in a conflict. Anything at all between requests,
since it keeps no state in memory, which is why a restart is safe at any moment.

## The plugin is responsible for

**Watching the vault.** Obsidian events, debounced by two or three seconds. Without that a
request would fly on every keystroke.

**The local index.** Per path: `base_rev`, `base_hash`, `local_hash`, `dirty`. Without
`base_hash` a merge degrades into "keep whichever is newer", which means losing a version.

**Deciding what to send and in what order.**

**Merging.** Line-based 3-way merge, conflict copies with markers, and the rule that an edit
beats a deletion.

**Encryption.** The key is derived from a passphrase and never leaves the device.

**Path normalisation** to NFC before sending, because macOS hands out NFD.

**Atomic writes** and index checkpoints after every file, because the app is killed at
arbitrary moments on mobile.

**Exclusions**, such as `workspace.json`, which is per-device and only gets in the way.

**The interface:** settings, status, conflict notifications, recovering deleted files.

## Why a server is needed at all

Three reasons, any one of which would be enough.

Devices are rarely online at the same time. An edit made on a phone in the underground has
to reach a desktop that is switched off. Something has to hold it in the meantime.

A direct connection between a phone and a desktop means punching through NAT, running
relays and maintaining the machinery around them, which is more complex than the rest of the
sync put together.

Somebody has to arbitrate order. Without a single source of truth two devices cannot agree
on whose version is newer without heavy distributed machinery, and that machinery is exactly
what loses data when it goes wrong.

## The author's own server

Worth stating plainly: **the author's server is not part of the product.**

The product is the source code and a binary. Every user runs their own instance, on a VPS, a
home NAS, a Raspberry Pi or their own laptop. The author runs the same instance for the same
reason anybody else does. There is no shared server, no registration and no account.

Which is also why the whole project is MIT. There is no hosting business to protect from
someone else's hosting business.
