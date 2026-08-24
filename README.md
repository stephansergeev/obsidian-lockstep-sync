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

Deleting does not erase, at first. A deleted file stays on the server and the plugin can
list it and bring it back, on any device. After thirty days the server erases it for good.
That window is a setting of the vault, so every device follows it, and setting it to zero
keeps deleted notes forever.

That sweep is the only thing on the server that deletes without being asked, and it only
ever touches files that were already deleted and have outlived the window. History of files
that still exist is never collected on a timer.

## Running the server

You need a machine reachable from the internet and a domain name pointing at it. Any small
VPS will do, and the domain can be a subdomain of one you already own.

```bash
curl -fsSLO https://github.com/stephansergeev/obsidian-lockstep-sync/releases/latest/download/install.sh
less install.sh          # it is 120 lines, and you are about to run it as root
sudo bash install.sh sync.example.com
```

It installs the binary, creates an unprivileged user for it, writes a systemd unit, arranges
TLS, and prints a token for your first device. Running it again updates the binary and
leaves your data alone.

TLS depends on what the machine already runs. On an empty machine it installs Caddy, which
obtains and renews the certificate on its own. If nginx is already serving something there,
it adds a site and asks certbot for the certificate instead, leaving the existing sites
untouched. If something else holds port 443 it changes nothing and tells you what to point
where: an installer that knocks over somebody's running site to put up its own is not an
installer.

The server itself listens on `127.0.0.1` and never faces the internet. Caddy does.

Give every device its own token, so losing one phone means revoking one token:

```bash
sudo /usr/local/bin/lockstep-sync-server token add --data /var/lib/lockstep --vault main --name iphone
```

Deleted files are erased on their own schedule, as above. The history of files that still
exist is not, and nothing about it is thrown away without being asked. When you want the
space back:

```bash
sudo -u lockstep /usr/local/bin/lockstep-sync-server gc --data /var/lib/lockstep --all --dry-run
```

It keeps the current version of every file whatever else happens, keeps recent history however
deep it goes, and only drops revisions that are both old and buried. Run it without
`--dry-run` when you agree with what it says it would do. It is not on a timer: deleting
history is the one thing here that cannot be undone.

If you already have a vault, load it in one go:

```bash
sudo -u lockstep /usr/local/bin/lockstep-sync-server import --data /var/lib/lockstep --vault main --from ~/Vault
```

**Never expose the server over plain HTTP.** The token travels with every request, and
anyone who catches it can read, write and delete. Content encryption does not help here:
it hides what is in your notes, not the right to destroy them.

### With Docker

For machines that only run containers, such as a NAS. The installer above is shorter and is
the path this project leads with; this one exists so that a compose file is an option rather
than a missing feature.

```bash
curl -fsSLO https://raw.githubusercontent.com/stephansergeev/obsidian-lockstep-sync/main/docker-compose.yml
mkdir -p data && sudo chown 1000:1000 data
docker compose up -d
docker compose exec lockstep /sync-server token add --data /data --vault main --name desk
```

**Read the volume line before you start it.** It is a bind mount to a `data` directory next
to the compose file, not a named volume, and that is deliberate. A named volume is what
`docker compose down -v` destroys, and what would be destroyed here is every note and every
revision of it. Back that directory up like any other data.

The container publishes to `127.0.0.1` only. TLS is still your reverse proxy's job.

### Without a domain

If you would rather not point a name at a machine, put the server and your devices on the
same private network with something like Tailscale or WireGuard and let the plugin use the
private address. The traffic is encrypted by the tunnel, nothing is exposed publicly, and
it still works away from home. It costs an app on every device, which is why it is the
alternative rather than the path above.

### Building from source

```bash
cd server && go build -o sync-server ./cmd/sync-server
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

Above that sits a second harness which drives the real plugin engine against a real server,
with two vaults on disk and only Obsidian stubbed out. An edit reaching the other device, a
deletion removing an untouched file, an edit beating a deletion, a rename arriving as a
rename, a device catching up after being away, non-ASCII paths surviving the trip, and with
encryption on, that the bytes sitting on the server contain none of the words in the note.

```bash
cd server && go test ./...
cd plugin && npm test
```

Both run on every commit. The first harness found two bugs in the server before any of this
went near a vault. The second found two more the day it was written, including one where
deleting a file on the device that created it silently downloaded it back.

## Where it stands today

Sync runs both ways. Edits, deletions and renames travel in both directions, conflicts merge
line by line, and overlapping edits produce a copy rather than a decision.

Content and file names are both encrypted on the device before anything is uploaded. The
server holds bytes it cannot read under names it cannot read either. What it still sees is
the shape: how many files there are and how deep the folders go.

## Encryption

Turn it on, choose a passphrase, and use the same one on every device. Content is sealed with
AES-256-GCM before it leaves, and the key is derived from the passphrase and never goes
anywhere.

Names are sealed too, one path segment at a time, so the tree keeps its shape while
"Job search/Applications.md" becomes three unreadable strings. A vault says a great deal
through its filenames alone, before a single note is opened. Path keys are expanded from the
same passphrase with HKDF but are separate from the content keys, so a leak of one is not a
leak of the other.

Names are encrypted deterministically, for the same reason content is: two devices have to
agree on where a file lives.

Names can only be hidden in a vault that starts empty, and whether they are is fixed the
first time encryption is set up. A vault cannot hold both kinds: turning name hiding on where
files already exist would upload every one of them a second time under its hidden name and
leave the readable copy behind. Set encryption up before putting anything in, and the server
never learns a single name.

The derivation parameters are stored on the server as an opaque record, so a second device
joins the vault knowing only the passphrase. They are write-once: changing them without
re-encrypting every file would turn the whole vault into noise, so the server refuses.

The key is derived with Argon2id at 64 MiB over three passes. Argon2id is memory-hard: every
guess has to allocate and walk tens of megabytes, which is what stops a graphics card from
trying millions of passphrases at once. That costs a WebAssembly build inside the plugin,
which is why it was measured before being accepted. On an iPhone it takes 172 ms, against
227 ms for PBKDF2 at 600,000 iterations. Cheaper for the person waiting, and orders of
magnitude more expensive for anyone attacking the passphrase. PBKDF2 records are still read,
so a vault created before the change keeps opening.

One choice here trades something away and is worth knowing about.

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

The plugin depends on the Obsidian typings and esbuild at build time, and on `hash-wasm` at
runtime for Argon2id. That WebAssembly build is most of the bundle, and it is loaded only
when a vault actually uses encryption.

## Verifying what you downloaded

Every release is built by GitHub Actions from the tagged commit and carries `SHA256SUMS`:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

Release tags are signed. Security reports go through a private advisory, see
[SECURITY.md](SECURITY.md).

## Author and licence

Written by Stephan Sergeev. https://github.com/stephansergeev

Original repository: https://github.com/stephansergeev/obsidian-lockstep-sync

MIT, for the whole repository, server and plugin alike. See [LICENSE](LICENSE). Forks and
derivative work are fine. Keep the licence text and the copyright line. Release tags are
signed.
