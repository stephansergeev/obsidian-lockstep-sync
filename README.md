# Lockstep Sync

Your Obsidian vault on every device, kept in step through a server you own.

No subscription. Nobody else holding your notes. One binary and a SQLite file on a machine
you control.

## Why this exists

Obsidian Sync works well and costs money, and your vault lives on servers that belong to
someone else. The self-hosted alternatives solve that part and ask a lot in return.
Self-hosted LiveSync needs a CouchDB instance, CORS rules and a reverse proxy. Synch and
Osync need Docker or a Cloudflare account. Remotely Save needs an account with a cloud
storage provider, which is the thing you were trying to avoid.

Lockstep needs one file. Copy it to a server, run it, paste a token into the plugin. That
is the entire setup.

## How it works

There are two pieces. The plugin runs inside Obsidian on each of your devices. The server
is a separate program you run yourself, on a VPS, a home NAS, a Raspberry Pi or your own
laptop. There is no shared server, no account and no registration. Every user runs their
own copy.

```
   desktop                     your server                   phone
┌──────────┐             ┌──────────────┐             ┌──────────┐
│ Obsidian │             │   lockstep   │             │ Obsidian │
│  plugin  │ ──PUT────▶  │  SQLite +    │  ◀────GET── │  plugin  │
│          │ ◀──changes─ │  blobs/      │  ──changes▶ │          │
└──────────┘             └──────────────┘             └──────────┘
```

The split of responsibility is deliberate. The server is an ordered log and a store of
bytes. All the intelligence lives in the plugin. The server does not know what markdown is,
never resolves a conflict and never sees your encryption key. That keeps it small enough to
audit in an afternoon and boring enough to trust.

Changes are found by reading a delta, not by walking the vault. Every write carries the
revision it was based on, so the server can tell a fresh edit from a stale one and answer
with its own version instead of overwriting yours. Deletions are tombstones, so a file that
disappears on one device can still be recovered from another. A rename travels as a rename,
not as a delete followed by a create, because on the far end those two look identical and
one of them is frightening.

Content is addressed by its sha256. Deduplication and full revision history come out of
that for free.

When both sides changed the same file, the plugin fetches the common ancestor and merges
line by line. Edits in different parts of a note merge without asking, because there is
nothing to decide.

Edits to the same lines are not merged behind your back. Both whole versions stay on disk,
the server one under its own name and yours beside it, and the plugin asks which one stands.
You can open either, then choose: keep both edits, which writes the two texts into the note
with markers and discards nothing, keep this device's version, or keep the server's. Keeping
both is offered first, because it is the only choice that cannot lose a word. Nothing is a blocking prompt: on a phone a sync often
finishes as the app is being suspended, so the decisions wait in a list until you open it.

Those markers are Obsidian comments rather than the git ones, and they carry the block
prefix of whatever they sit inside. A line of "=" would turn the line above it into a
heading and a line starting with ">" would open a blockquote, so git markers wreck the
rendering of the very note they describe, and a marker without the surrounding quote prefix
cuts a callout in half.

Binary files and anything over a megabyte are never merged: both versions are kept and the
same question is asked.

An edit always beats a deletion. Delete a note on one device while editing it on another and
it comes back, because a note that reappears is an annoyance and a note that vanishes is not.

## Running the server

Build it, issue a token, start it:

```bash
cd server
go build -o sync-server ./cmd/sync-server

./sync-server token add --data ./data --vault main --name desk-01
./sync-server serve     --data ./data --addr 127.0.0.1:8080
```

The token is printed once. Only its sha256 is kept on disk.

For a first look one machine is enough. The server listens on `127.0.0.1:8080` by default
and the plugin on the same computer points at `http://127.0.0.1:8080`.

For real use between devices, put TLS in front of it. The server listens locally and does
not deal with certificates. A systemd unit with process isolation and a Caddyfile are in
[`ops/`](ops/). Never send a token over plain HTTP outside a network you trust.

If you already have a vault, load it into the server in one command:

```bash
./sync-server import --data ./data --vault main --from ~/Vault
```

One vault is one directory under `data/vaults/`, with its own database and its own blob
store. Several vaults on one server work without a tenant column in the schema. The token
simply says which directory to open.

## Installing the plugin

The easiest route, and the only comfortable one on a phone, is BRAT. Install BRAT from the
community catalogue, add `stephansergeev/obsidian-lockstep-sync` as a beta plugin, and it
will fetch the release and keep it updated.

By hand: take `main.js` and `manifest.json` from any release and drop them into
`<vault>/.obsidian/plugins/lockstep-sync/`.

From source:

```bash
cd plugin
npm install
npm run build
```

Then enable the plugin, paste the server address and the token, and give the device a name.
The name shows up in conflict copies, so you can tell which device an edit came from.

After that it runs on its own. A pass fires a couple of seconds after you stop typing, on a
timer, and when the app goes to the background, which on a phone is the moment before it
gets killed. There is a Sync now command as well.

The interface is in English and switches to Russian on its own when Obsidian itself runs in
Russian.

## Guarantees, not promises

Every sync tool promises it is safe. This one publishes what that means.

The test harness was written before the sync itself. It spins up a real server, drives it
through two devices, and checks a single invariant: no version of your text disappears
quietly. Simultaneous edits from both sides. A deletion racing an edit. A rename racing an
edit. A connection dropped mid-upload. A client killed between writing a file and updating
its index. A rename that only changes letter case. The same filename in two Unicode forms,
which is what happens between macOS and everything else. A hundred megabyte attachment. A
device whose clock is a day fast. Two devices creating the same path from nothing.

```bash
cd server && go test ./...
```

It runs on every commit. It found two real bugs in this server on its first run, before any
of this went near a live vault.

## Where it stands today

Sync runs both ways. Edits, deletions and renames travel in both directions, conflicts merge
line by line, and overlapping edits produce a copy rather than a decision.

Content is encrypted on the device before it is uploaded. File and folder names are not yet:
the server can see the shape of your vault, though not what is in it. Encrypting the paths
as well is the next piece of work.

## Encryption

Turn it on, choose a passphrase, and use the same one on every device. Content is sealed with
AES-256-GCM before it leaves, and the server holds bytes it cannot read. The key is derived
from the passphrase and never goes anywhere.

The derivation parameters are stored on the server as an opaque record, so a second device
joins the vault knowing only the passphrase. They are write-once: changing them without
re-encrypting every file would turn the whole vault into noise, so the server refuses.

Two choices here trade something away and are worth knowing about.

The key is derived with PBKDF2-SHA256 rather than Argon2id. Web Crypto has no Argon2, and
the alternative is shipping a WebAssembly build inside a plugin that has to run on a phone.
PBKDF2 is weaker against dedicated cracking hardware but needs no dependency and no native
code. Because the parameters live in that record, moving to Argon2id later is a migration
rather than a break.

The nonce is derived from the content rather than drawn at random. A random one would make
every upload of an unchanged file produce different bytes, which defeats deduplication,
breaks the idempotent retry the protocol depends on, and wakes every other device for a file
nobody touched. The cost is that the server can tell two files hold identical content,
though not what that content is.

If the passphrase is wrong or missing, syncing stops. It never falls back to plaintext,
because falling back would quietly upload exactly what the setting exists to hide.

Lose the passphrase and the notes are gone. There is nobody to ask.

## Dependencies

The server uses `modernc.org/sqlite`, which is pure Go and needs no cgo, and
`golang.org/x/text` for Unicode normalisation. Nothing else. The binary is static and
cross compiles anywhere.

The plugin depends on the Obsidian typings and esbuild at build time, and on nothing at
runtime.

## Author and licence

Written by Stephan Sergeev. https://github.com/stephansergeev

Original repository: https://github.com/stephansergeev/obsidian-lockstep-sync

MIT, for the whole repository, server and plugin alike. See [LICENSE](LICENSE). Forks and
derivative work are fine. Keep the licence text and the copyright line. Release tags are
signed.
