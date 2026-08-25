# Lockstep Sync

Two-way sync for your vault between desktop, iPhone, iPad and Android, through a server
you own. Self-hosted, end-to-end encrypted, free and open source. No subscription, no
third-party cloud, no account: one small binary on a machine you already have, and your
notes.

## What you get

- **Sync every device**: macOS, Windows, Linux, iOS and Android, from the same plugin.
  Changes leave moments after you stop typing and arrive in seconds.
- **Your own server**: a single binary with SQLite inside, installed by one script on any
  Linux box or VPS, or run as a container. No CouchDB, no S3, no Cloudflare, no account.
- **End-to-end encryption**: AES-256-GCM on the device, key from your passphrase through
  Argon2id. File and folder names are sealed too. The server holds ciphertext under
  ciphertext names and can read none of it. Encryption can be turned on later.
- **Conflicts are asked, never decided for you**: edits to different lines merge on their
  own; edits to the same lines keep both versions whole and ask, with each side named
  after the device it came from. An edit always beats a deletion.
- **Deleted files come back**: every device can restore what was deleted, for thirty days
  by default, then the server erases it.
- **Large vaults and large files**: attachments of hundreds of megabytes, downloaded in
  slices that survive a phone going to sleep. Notes arrive before attachments, so a new
  device is readable within its first minute.
- **Set up by QR code**: a page on your server walks a new device through installing the
  plugin and connecting, in three taps. Tokens are per device and revocable.
- **Backup by design**: the server keeps revision history you can garbage-collect on your
  own terms, and every device holds ordinary readable files.
- **Verified builds**: releases are built by CI from the signed tag, carry GitHub
  provenance attestations, and reproduce byte-for-byte from the source.

If you have looked at Obsidian Sync, Remotely Save, Self-hosted LiveSync, Syncthing or
Git for this, the difference is below.

## Why this one

Every self-hosted sync asks for something first. LiveSync wants a CouchDB. Synch and
Osync want Docker or a Cloudflare account. Remotely Save wants the cloud storage you
were trying to leave. Lockstep wants one file on one machine you already have.

And it shows its work. A suite of data-loss scenarios runs on every commit, driving
the real plugin against a real server: simultaneous edits, deletions racing edits,
renames racing everything, connections cut mid-file, the app killed mid-write, clocks
set wrong, Unicode in every form. The promise is narrow and testable: **no version of
your text disappears quietly.**

## How it works

```
   desktop                     your server                   phone
┌──────────┐             ┌──────────────┐             ┌──────────┐
│ Obsidian │             │   lockstep   │             │ Obsidian │
│  plugin  │ ──changes─▶ │  SQLite +    │ ◀─changes── │  plugin  │
└──────────┘             │  content     │             └──────────┘
                         └──────────────┘
```

The server is an ordered log and a store of bytes. All the judgement lives in the
plugin. Devices exchange deltas, never directory walks. A deletion is a tombstone. A
rename travels as a rename, not as a delete plus a stranger.

Edits to different parts of a note merge silently. Edits to the same lines keep both
versions whole and ask you, right in the notice, with each side named after the
device it came from. An edit always beats a deletion. Deleted files stay recoverable
from any device for thirty days (yours to change), then the server erases them.

Syncing is automatic: moments after you stop typing, when the app goes to the
background, and every fifteen seconds while it is open.

## Run the server

A machine reachable from the internet, and a domain name pointed at it:

```bash
curl -fsSLO https://github.com/stephansergeev/obsidian-lockstep-sync/releases/latest/download/install.sh
less install.sh    # read what you are about to run as root; q to close
sudo bash install.sh sync.example.com
```

It installs the binary, creates an unprivileged user, arranges TLS around whatever
already runs on the machine, and prints a link that sets up your first device. Run it
again to update; your data is left alone.

Already have a vault? `sync-server import --from ~/Vault`. Want space back?
`sync-server gc --dry-run` shows what old history it would drop; nothing is collected
without being asked. No domain? A private network like Tailscale works: point the
plugin at the private address and skip TLS entirely.

There is a [`docker-compose.yml`](docker-compose.yml) for machines that only run
containers. Read the volume line before starting it: it is a bind mount on purpose,
because a named volume is what `docker compose down -v` destroys.

## Install the plugin

Settings → Community plugins → Browse → **Lockstep Sync** → Install → Enable. Or from the
web: [community.obsidian.md/plugins/lockstep-sync](https://community.obsidian.md/plugins/lockstep-sync).

First device: open the link the installer printed. Every next device: **Link a new
device** in the settings shows a QR code; the page it opens walks through the steps.

## Encryption

Type a passphrase in the settings and notes are sealed on the device with AES-256-GCM
before they leave, file and folder names included. The key comes from the passphrase
through Argon2id and goes nowhere. A wrong passphrase stops syncing; it never falls
back to plaintext.

It can be turned on later, on a vault already on the server. The plugin uploads every
file again, sealed, then erases the readable copies and their history; other devices
join with the same passphrase once it is done. If the app is closed halfway, it
continues on the next start.

Choose the passphrase as if it were permanent, because it is: set once per vault,
never changeable, never recoverable. Losing it does not lose your notes, since
devices hold ordinary readable files. It loses the server copy, its history, and the
ability to set up new devices from it. Four unrelated words beat eight clever
characters, and the plugin says so while you type.

## Trust, verified

Releases are built by CI from the tagged commit and ship `SHA256SUMS`. Tags are
signed. The server sees ciphertext under ciphertext names and answers only to
per-device revocable tokens. Details and the threat model: [SECURITY.md](SECURITY.md).
The protocol and its reasoning: [`spec/`](spec/).

## License

MIT, the whole repository. Written by [Stephan Sergeev](https://github.com/stephansergeev).
