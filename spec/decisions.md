# Decisions made along the way (delta to spec v0.1)

The spec is not rewritten after the fact. Deviations and their reasons collect here, and
move into v0.2 at the next revision.

## Settled

**Product model.** Free, open source, funded by donations. There will be no subscription and
no hosted service.

The reason is not altruism, it is who actually uses this. The audience for self-hosted sync
is people who deliberately turned down Obsidian Sync at four dollars a month and are willing
to run a server instead. Selling a subscription to people who already rejected one makes no
sense: by choosing this they removed themselves from that market. Monetising access would
contradict the product rather than extend it.

What follows for development: no free and paid tiers, no limits on vaults or devices, no
telemetry, no mandatory account. Everything the product does is available to everyone at
once.

**Licence.** MIT for the whole repository. Hosting the server as a service is not planned,
so there is nothing to protect against somebody else's SaaS, and MIT removes friction both
for the catalogue submission and for contributors. The decision is irreversible for releases
already published, and was taken deliberately before the first one.

**Q11.1, multi-user or one vault per instance?** Neither: **one vault is one directory**
(`data/vaults/<name>/meta.db` plus `blobs/`), and a token says which directory to open. The
schema needs no `vault_id`, there is no multi-tenancy and none of its risks, and several
vaults on one server still work. Isolation is covered by `TestVaultIsolation`.

**A new `renamed_from` column in `files`.** Spec section 4.5 requires that a rename does not
look like a deletion on another device, but without an explicit marker in the log the client
sees exactly a tombstone plus a new file. The column is returned by `/changes`, so a client
can perform a local rename instead of downloading the content again and deleting the old
path.

**Order of checks on write: idempotency BEFORE base_rev.** The first run of the harness
caught this. A client killed between a successful PUT and its local index update retries
with the old base and used to get a 409 out of nowhere. Now matching content hashes are a
no-op returning the current revision regardless of `base_rev`, because the result on disk is
identical and there is nothing to lose. The same applies to a repeated deletion.

**`seq` does not move on a no-op.** Otherwise every retry after a dropped connection would
wake all the other devices for an empty delta.

**Path validation on the server, not only on the client.** An NFD path is rejected with 400.
Client-side normalisation stays, but there will be several client versions over time and
non-ASCII names that have drifted apart cannot be reconciled afterwards. The same check
rejects `..`, absolute paths, empty segments, control characters, and trailing spaces or
dots, the last of those for the sake of Windows.

**An occupied destination on rename gives 409 rather than an overwrite.** Silently
overwriting somebody else's file is exactly the note loss this project exists to prevent.

**Tokens are stored as sha256.** The plaintext value is shown once, at issue.

**Downloading from the server does not delete local files.** A one-way pull must not be able
to erase a vault, so tombstones are skipped during `pullAll`. Deletions are applied only once
the full two-way index is in place.

**A local file that differs is copied aside.** If a local file differs from the server one,
the local version is saved as `Name (device DATE).md` first, and only then is the server
version written. Nothing is overwritten silently anywhere.

## Still open

**Whether to sync `.obsidian/`.** Exclusions currently hold `workspace.json`,
`workspace-mobile.json` and `.trash/`. The question is whether to carry settings and plugins
wholesale, which is convenient but wrong when the plugin sets differ between desktop and
mobile.

**Whether the attachment limit is hard or a warning.** It is hard right now, 512 MB, behind
the `--max-upload` flag.

**Full versions or deltas in history.** Full for now, since blobs deduplicate. The collector
is not written yet. The proposal from the spec: drop revisions older than 30 days and deeper
than 20.

## Untouched so far

Encryption (section 6), WebSocket (section 4.6), resumable downloads on the client, the
vault watcher, the upload queue and the 3-way merge. The server is ready for all of them:
`Range` works, a 409 carries everything a merge needs, and revisions are addressable by
number.
