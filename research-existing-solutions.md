# What already exists (research, 23 August 2026)

Context: [the specification](spec/spec-v0.1.md).
The question this research had to answer: is the niche free, and where is the real
difference.

## In one line

The niche is **not** free. The "how this differs from Remotely Save" table in the spec does
not describe a gap in the market, it describes two products that already exist:
**Self-hosted LiveSync** (2021, mature) and **Synch** (2026, MIT, beta). The second covers
the specification almost point for point, including encrypted paths and a 3-way markdown
merge. So the thing to build is not the same product in Go, it is a deliberate difference.

## Who is here

### Obsidian Sync, the official one
Standard is four dollars a month billed annually, or five monthly: 1 GB, one month of
history, one vault, unlimited devices. Plus is eight dollars a month annually: 10 GB, up to
100 GB for sixteen, twelve months of history, up to ten vaults. End-to-end encrypted, both
mobile platforms, zero configuration. This is the reliability benchmark everything else is
measured against. Against us: a subscription, somebody else's server, closed source.

### Remotely Save
Bring your own storage. The plugin is only a client.
Free forever: S3-compatible (R2, B2, MinIO), WebDAV, Dropbox, OneDrive app folder, Webdis.
PRO: OneDrive full access, Google Drive, Box, pCloud, Yandex Disk, Koofr, Azure Blob. Free
during the beta until 1 January 2027, a subscription afterwards.
**The PRO line also runs through conflict handling:** the free tier keeps whichever is newer,
PRO does a smart merge or a duplicate.
Its weak spot, the one the spec attacks: changes are found by walking the tree on the client,
sync runs on a timer or a button, and there is no background sync.
About 6,600 stars, actively maintained. **2,168,947 downloads.**

### Self-hosted LiveSync (vrtmrz)
The main competitor in this class. Requires Obsidian 1.7.2 or newer, runs everywhere
including mobile.
**Three backends:** CouchDB (recommended), object storage (S3, R2, MinIO), and peer to peer
over WebRTC, which needs no data server but does need a signalling relay.
Real-time replication, chunk-level, automatic merging of simple conflicts, end-to-end
encryption.
In 2026 the P2P mode is being actively developed: room IDs, watching a peer, one-click
replication. The same place lists the known problems: mandatory remote database encryption
in 0.25.6x conflicts with the P2P replicator, and CouchDB users get spurious "P2P not
enabled" notifications.
The downside is exactly what the spec says: getting it running means being a sysadmin for an
afternoon, with Docker, CouchDB, CORS, a reverse proxy and TLS. Plus a warning to back up
before installing, and another not to close Obsidian mid-sync or risk corruption.
**882,799 downloads.**

### Synch (hjinco/synch, synch.run), the 2026 newcomer and the most awkward for us
Open source, MIT, in beta.
**Device-side end-to-end encryption: the service sees neither the text, nor the file paths,
nor the keys.** That is exactly v2 of section 6 of the spec.
**Automatic markdown merging for non-overlapping edits, conflict copies when edits overlap.**
That is exactly section 5 of the spec.
Near-instant sync, encrypted version history, recovery of deleted files. Desktop and mobile.
**Self-hostable** through Docker or systemd, or deployed into Cloudflare. The hosted service
runs on Cloudflare storage, queues and D1.
Hosted plans: free with one vault, 50 MB and one day of history; Starter at one dollar a
month with 1 GB and one month; Plus at five dollars with five vaults, 50 GB total and a year.
**3,351 downloads.**

### Osync (Self-Hosted)
"Self-hosted, end-to-end encrypted vault sync. Run your own server (Docker)."
**499 downloads.** Like Synch, marked in the catalogue as not manually reviewed by the
Obsidian team.

### AnySocket Sync
"Self-Hosted synchronization for your Vault using AnySocket." **1,048 downloads.**

### Non-plugin routes, for completeness
**iCloud** is Apple only and conflicts when both sides edit.
**Syncthing** is peer to peer with no cloud. The official Android app was discontinued, its
last release tied to Syncthing from December 2024, and the maintained successor is
Syncthing-Fork, which changed hands in 2026. On iOS the sandbox means a wrapper: SyncTrain,
free and open source on iOS 17 or newer, or Möbius Sync, free up to 20 MB with a one-off
$4.99 to lift the cap.
**obsidian-git** gives versioning as a bonus but brings merge conflicts on a phone and the
risk that everything in the vault ends up in a remote repository.
**A Google Drive or Dropbox folder** works after a fashion on Android. On iOS, Obsidian only
gets on well with iCloud and local folders.

## What the specification asked for that others already have

| Point from the spec | Who already did it |
|---|---|
| A server-side revision log instead of walking the tree | LiveSync (CouchDB `_changes`), Synch |
| Push instead of a timer | LiveSync (continuous replication), Synch (near instant) |
| 3-way markdown merge, conflict copy on overlap | Synch, word for word; LiveSync at chunk level |
| Encrypted paths | Synch, already shipping |
| Self-hosting in one command | Synch (Docker, systemd, Cloudflare); LiveSync no, it needs CouchDB |
| One static binary, SQLite, no dependencies | **nobody** |
| A public harness for data loss invariants | **nobody sells this** |

## Where the real difference is

**Operational simplicity.** One Go binary and SQLite against CouchDB on one side and Synch's
Cloudflare dependency on the other. "Copy a file to a server, add a systemd unit, done" is an
honest difference from both.

**Guarantees rather than features.** The harness from section 9 as a public artefact: here
are ten scenarios where sync loses text, and here is the CI run proving these do not. Nobody
in this field sells that, and the pain is precisely there.

**No vendor in the loop.** Synch hosted sits on Cloudflare and the official Sync sits on
Obsidian's servers. This one sits on your own machine.

## What the numbers say

Across the whole catalogue of 6,845 plugins the median is **540 downloads**. The top 25%
starts at 4,151 and the top 10% at 15,921. More than half the catalogue, 4,009 plugins, sits
below a thousand.

The instructive comparison is Synch against Remotely Save. Synch is technically the stronger
product and has 3,351 downloads. Remotely Save does less and resolves conflicts worse in its
free tier, and has 2.1 million. **Technical superiority does not convert into installs.** The
gap is years of presence and the position in a catalogue that sorts by popularity, which is a
loop that feeds itself.

A realistic target is therefore not two million but ten thousand, which is the top 10% of the
catalogue.

## To check before writing more code

Stand up Synch self-hosted and live on it for a week. If it covers the job completely, the
difference has to be stated honestly rather than invented afterwards.

Run scenarios 1 to 10 from section 9 of the spec against Synch and LiveSync. If both fail at
least three, the "guarantees" difference is backed by data rather than opinion.

Check how each behaves on mobile after a week of the app being killed in the background.

## Sources

- https://obsidian.md/blog/standard-plan/ official Sync pricing
- https://remotelysave.com/pricing the free and PRO split
- https://github.com/vrtmrz/obsidian-livesync backends and warnings
- https://github.com/vrtmrz/obsidian-livesync/blob/main/docs/p2p_sync_updates_2026.md
- https://github.com/hjinco/synch and https://synch.run/
- https://github.com/obsidianmd/obsidian-releases download statistics
- https://www.stephanmiller.com/sync-obsidian-vault-across-devices/ free routes in 2026
- https://forum.obsidian.md/t/sync-mac-pc-and-ios-using-syncthing-mobius-sync/72022
