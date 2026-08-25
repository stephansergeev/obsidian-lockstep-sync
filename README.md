# Lockstep Sync

Your Obsidian vault on every device, kept in step through a server you own. No
subscription, no third-party cloud, no account. One small binary and your notes.

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

Through [BRAT](https://obsidian.md/plugins?id=obsidian42-brat): add
`stephansergeev/obsidian-lockstep-sync`. Or copy `main.js`, `manifest.json` and
`styles.css` from a release into `<vault>/.obsidian/plugins/lockstep-sync/`.

First device: open the link the installer printed. Every next device: **Add another
device** in the settings, point its camera at the code, done. The code carries the
address and a token minted for that one device, listed in words beside it, and never
the passphrase.

## Encryption

Type a passphrase in the settings and notes are sealed on the device with AES-256-GCM
before they leave; on a vault that starts empty, file and folder names are sealed
too. The key comes from the passphrase through Argon2id and goes nowhere. A wrong
passphrase stops syncing; it never falls back to plaintext.

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
