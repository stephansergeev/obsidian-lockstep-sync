# Lockstep Sync — technical specification

**Spec version:** 0.1 · **Status:** draft written before the first line of code

## 1. Goal

Two-way synchronisation of an Obsidian vault between desktop (Windows, macOS) and mobile
(iOS, Android) through a server the user owns. No subscriptions, no third-party clouds, no
OAuth.

### How this differs from Remotely Save

| | Remotely Save | This |
|---|---|---|
| Finding changes | the client walks the whole tree | a server-side revision log, one request for the delta |
| Sync trigger | timer or button | WebSocket push, about a second |
| Conflicts | keep newer or keep larger | 3-way merge on markdown |
| File paths | always in the clear | encrypted (v2) |
| Cost | a PRO subscription for half the backends | your own server |

The closest thing in the same class is Self-hosted LiveSync (CouchDB). Study it before
starting: where this is simpler (one binary instead of CouchDB) and where it is genuinely
stronger.

## 2. Principles

1. **The server is the source of truth.** No version vectors, no distributed consensus. One
   server, a monotonic counter, and every client catches up to it.
2. **The vault is sacred.** Any ambiguity is resolved in favour of keeping both versions,
   not in favour of a tidy sync.
3. **Every operation is idempotent.** A mobile client is killed at arbitrary moments;
   repeating any request must not break state.
4. **No state in server memory.** A restart is safe at any moment.

## 3. Data model

### 3.1 Server

Storage: SQLite for metadata, files on disk for content.

Content is addressed by hash, at `blobs/<sha256[0:2]>/<sha256>`. That gives deduplication,
idempotent uploads and history for free: an old revision stays on disk for as long as a row
in `revisions` points at it.

```sql
CREATE TABLE files (
  path        TEXT PRIMARY KEY,   -- vault-relative path
  rev         INTEGER NOT NULL,   -- file revision, +1 per change
  seq         INTEGER NOT NULL,   -- position in the global log
  hash        TEXT,               -- sha256 of the content; NULL when deleted
  size        INTEGER NOT NULL,
  mtime       INTEGER NOT NULL,   -- unix ms, edit time on the client
  deleted     INTEGER NOT NULL DEFAULT 0,
  folder      INTEGER NOT NULL DEFAULT 0,
  updated_by  TEXT                -- device_id that made the change
);

CREATE TABLE revisions (        -- history, for rollback and 3-way merge
  path  TEXT NOT NULL,
  rev   INTEGER NOT NULL,
  hash  TEXT,
  mtime INTEGER NOT NULL,
  seq   INTEGER NOT NULL,
  PRIMARY KEY (path, rev)
);

CREATE TABLE meta (             -- seq counter and the rest
  key TEXT PRIMARY KEY, value TEXT
);

CREATE INDEX idx_files_seq ON files(seq);
```

`seq` is a global monotonic counter for the whole vault, incremented in the same transaction
as the file write. Clients request their delta by it.

Deletion is not a DELETE but a tombstone: `deleted = 1`, `hash = NULL`, `rev + 1`. Tombstones
live for at least 90 days before collection.

### 3.2 Client

A local index in `.obsidian/plugins/lockstep-sync/state.db` (SQLite through sql.js), or JSON
while the vault is small enough:

```
path -> {
  base_rev,      // the revision the client based itself on
  base_hash,     // hash of that same revision, the base for a 3-way merge
  local_hash,    // hash of what is on disk right now
  mtime,
  dirty          // changed locally, not yet sent
}
```

Plus one global value, `last_seq`, marking how far the client has read the log.

**`base_hash` is mandatory.** Without a common ancestor a 3-way merge is impossible and
conflict handling degrades to "keep newer", which is to say to Remotely Save.

## 4. Protocol

Base URL: `https://sync.example.com/v1`
Authentication: `Authorization: Bearer <token>` on every request, WebSocket included. Tokens
are generated on the server (`sync-server token add <name>`) and pasted into the plugin by
hand. On mobile that is the only sane option, since OAuth there is misery.

Paths travel in the `path` query parameter, URL-encoded, in NFC. macOS produces NFD, so the
client normalises before sending. Otherwise non-ASCII names drift apart between devices.

### 4.1 `GET /changes?since=<seq>&limit=500`

The delta since `since`. This is the mechanism, in place of walking the tree.

```json
{
  "entries": [
    {"seq": 1043, "path": "Notes/Yerevan.md", "rev": 7,
     "hash": "9f2b...", "size": 4211, "mtime": 1755600000000,
     "deleted": false, "folder": false, "updated_by": "desk-01"}
  ],
  "next_seq": 1043,
  "has_more": false
}
```

A client ignores entries carrying its own `updated_by` when `rev` matches what it has
locally. That is the echo of its own upload.

### 4.2 `GET /file?path=<path>&rev=<rev>`

Content. Without `rev`, the latest revision. Supports `Range` for resuming. The response
carries `X-Rev` and `ETag: <sha256>`.

### 4.3 `PUT /file?path=<path>`

Headers:
- `X-Base-Rev: <int>` the revision the client based itself on. `0` for a new file.
- `X-Mtime: <unix ms>`
- `Content-Type: application/octet-stream`

Responses:
- `200 {"rev": 8, "seq": 1044, "hash": "..."}` written
- `409 {"error": "conflict", "server_rev": 8, "server_hash": "..."}` the server already holds
  a different revision and the client goes to merge, see section 5
- `200` with the same `rev` when the content hash matches what the server holds. A no-op: no
  new revision.

### 4.4 `DELETE /file?path=<path>`, same rules and the same `X-Base-Rev`.

### 4.5 `POST /rename`, `{"from": "...", "to": "...", "base_rev": N}`

A separate operation on purpose. A delete plus create pair loses the file history and looks
like a deletion on the other device, and a deletion is always scarier than a rename.

### 4.6 `WS /events`

The server sends `{"seq": 1044}` on any change. The client then calls `/changes`. The event
carries no data, it is only a bell saying it is time to sync. Ping and pong every 30 seconds,
reconnect with exponential backoff. **WebSocket is an optimisation, not the mechanism.**
Everything has to work on plain polling, or a vault drifts apart after a phone goes to sleep.

### 4.7 `GET /health`, `GET /stats`: vault size, file count, current seq.

## 5. Conflicts

A conflict is a client sending a PUT whose `base_rev` is lower than the server's current one.

On the client:

1. Download the server version (`rev = server_rev`) and the base (`rev = base_rev`). The base
   is almost always already in the local blob cache.
2. Both texts and a file of 1 MB or less: a line-based 3-way merge (diff3).
   - non-overlapping edits merge silently and the result is sent with
     `base_rev = server_rev`
   - overlapping lines merge with markers and the file is placed alongside as
     `Note (conflict 2026-08-22 14:30 iPhone).md`, leaving the server version in place
3. Binary content or more than 1 MB: a duplicate with a suffix. Nothing is overwritten.
4. Deletion against an edit: **the edit always wins.** The file comes back. Losing a note is
   worse than seeing one resurrected.

Every conflict goes into the plugin log and raises a notification. Silent merging is only for
non-overlapping edits.

## 6. Encryption

**v1:** content in AES-256-GCM, key derived from a passphrase with Argon2id, salt stored on
the server in `meta`. A random nonce per write. Paths and folder structure stay in the clear.

**v2:** paths through AES-SIV, which is deterministic, so the same path yields the same
ciphertext. Primary keys and deduplication keep working while the server no longer sees any
names. Each path segment is encrypted separately, or the hierarchy breaks.

The key never reaches the server. Forget the passphrase and the data is gone, which the
interface says plainly when the feature is enabled.

## 7. The client on mobile

A section of its own, because this is where naive implementations break.

1. **Atomic writes.** Write to a temporary file, then rename. Writing straight into a vault
   file leaves a truncated file when the process is killed, and that is already a lost note.
2. **The app is killed in the background.** Long operations run in checkpoints: sync state is
   written to the index after every file, not at the end of a batch.
3. **Sync on blur.** Force a queue flush when the app is being suspended.
4. **Debounce** `vault.on('modify')` by two or three seconds. Obsidian fires an event on
   every keystroke.
5. **HTTP through `requestUrl()`** from the Obsidian API, or CORS blocks it on desktop.
6. **Memory limits.** Stream large attachments rather than calling `readBinary()` on the lot.
7. **NFC normalisation** of paths before anything is sent, see section 4.

## 8. Stack

**Server:** Go, a single static binary. `net/http` and `modernc.org/sqlite`, no cgo, so it
cross compiles anywhere. A systemd unit and Caddy for TLS. No Docker unless you want it.

**Plugin:** TypeScript on the official `obsidian-sample-plugin`, bundled with esbuild.

```
/server        Go: cmd/sync-server, internal/{store,api,auth}
/plugin        TS: src/{sync,crypto,ui}, manifest.json
/spec          this file, versioned alongside the code
/testkit       the harness from section 9
```

## 9. Test harness, written BEFORE the sync

Two virtual vaults in memory plus a fake server, with the scenarios running in CI:

1. The same file edited from both sides at once
2. Deletion on A against an edit on B
3. A rename on A against an edit on B
4. A connection dropped mid-upload, then retried
5. A client killed between writing a file and updating its index
6. A rename that only changes letter case (`note.md` to `Note.md`)
7. Unicode in a path: NFC against NFD
8. A 100 MB file
9. A client clock a day fast
10. Two clients creating the same path from nothing

Every scenario checks a single invariant: **no version of the text disappeared quietly.**

## 10. Stages

- **Foundation, no sync yet.** Server: schema, `/changes`, `/file` GET and PUT, tokens.
  Plugin: settings and a manual button to download everything. The harness, scenarios 1 to 3.
- **Working two-way sync.** Local index, debounce, upload queue, conflicts per section 5,
  encryption v1. From here it is cautiously usable.
- **The point of the whole thing.** WebSocket push, rename, resumable transfers, revision
  history in the interface, recovering deleted files.
- **Product.** Path encryption, several vaults, a web view for history, a one-command server
  installer, and the catalogue submission.

## 11. Open questions

- [ ] Multi-user or one vault per instance? Affects the schema, decide before writing code.
- [ ] Full versions or deltas? Proposal: full, collected past 30 days and deeper than 20
      revisions.
- [ ] Sync `.obsidian/` or not? Optional, with `workspace.json` excluded by default.
- [ ] Attachment size limit: hard, or a warning?
- [ ] Licence: MIT or AGPL? AGPL stops anyone standing this up as a paid SaaS.
