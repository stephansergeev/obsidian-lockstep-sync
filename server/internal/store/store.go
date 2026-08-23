// SPDX-License-Identifier: MIT

// Package store keeps vault metadata: files, revisions and the global change log.
//
// The invariants everything else rests on:
//   - seq is the vault's global monotonic counter, incremented in the same
//     transaction as the file write. Clients read deltas by it and nothing else.
//   - deletion is a tombstone (deleted=1, hash=NULL, rev+1), never a DELETE.
//   - every file state is recorded in revisions, so a client can fetch the common
//     ancestor it needs for a 3-way merge.
package store

import (
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

// File is the current state of one file in the vault.
type File struct {
	Path        string `json:"path"`
	Rev         int64  `json:"rev"`
	Seq         int64  `json:"seq"`
	Hash        string `json:"hash,omitempty"` // sha256 of the content; empty when deleted or a folder
	Size        int64  `json:"size"`
	Mtime       int64  `json:"mtime"` // unix ms, edit time as reported by the client
	Deleted     bool   `json:"deleted"`
	Folder      bool   `json:"folder"`
	UpdatedBy   string `json:"updated_by,omitempty"`
	RenamedFrom string `json:"renamed_from,omitempty"`
}

// ConflictError is returned when a client based its write on a stale revision.
type ConflictError struct {
	Path       string
	ServerRev  int64
	ServerHash string
	Deleted    bool
	// Which device wrote the revision the server currently holds. The client uses it
	// to name the other side when it asks a person which version stands.
	UpdatedBy string
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("conflict on %q: server rev %d", e.Path, e.ServerRev)
}

// ErrNotFound means the path was never in the vault at all — not to be confused
// with a tombstone.
var ErrNotFound = errors.New("not found")

type Store struct {
	db *sql.DB
}

const schema = `
CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  rev          INTEGER NOT NULL,
  seq          INTEGER NOT NULL,
  hash         TEXT,
  size         INTEGER NOT NULL,
  mtime        INTEGER NOT NULL,
  deleted      INTEGER NOT NULL DEFAULT 0,
  folder       INTEGER NOT NULL DEFAULT 0,
  updated_by   TEXT,
  renamed_from TEXT
);

CREATE TABLE IF NOT EXISTS revisions (
  path  TEXT NOT NULL,
  rev   INTEGER NOT NULL,
  hash  TEXT,
  mtime INTEGER NOT NULL,
  seq   INTEGER NOT NULL,
  PRIMARY KEY (path, rev)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT
);

CREATE INDEX IF NOT EXISTS idx_files_seq ON files(seq);
CREATE INDEX IF NOT EXISTS idx_revisions_hash ON revisions(hash);
`

// Open opens (or creates) a vault database.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)")
	if err != nil {
		return nil, err
	}
	// A single connection: SQLite serialises writes anyway, and this guarantees the
	// seq-counter transaction never races against itself.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Seq returns the current value of the global counter.
func (s *Store) Seq() (int64, error) {
	var v sql.NullInt64
	err := s.db.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='seq'`).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return v.Int64, nil
}

func nextSeq(tx *sql.Tx) (int64, error) {
	var cur int64
	err := tx.QueryRow(`SELECT CAST(value AS INTEGER) FROM meta WHERE key='seq'`).Scan(&cur)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	cur++
	if _, err := tx.Exec(`INSERT INTO meta(key,value) VALUES('seq',?)
		ON CONFLICT(key) DO UPDATE SET value=excluded.value`, cur); err != nil {
		return 0, err
	}
	return cur, nil
}

func scanFile(row interface{ Scan(...any) error }) (File, error) {
	var f File
	var hash, updatedBy, renamedFrom sql.NullString
	var deleted, folder int
	err := row.Scan(&f.Path, &f.Rev, &f.Seq, &hash, &f.Size, &f.Mtime, &deleted, &folder, &updatedBy, &renamedFrom)
	if err != nil {
		return File{}, err
	}
	f.Hash, f.UpdatedBy, f.RenamedFrom = hash.String, updatedBy.String, renamedFrom.String
	f.Deleted, f.Folder = deleted == 1, folder == 1
	return f, nil
}

const fileCols = `path, rev, seq, hash, size, mtime, deleted, folder, updated_by, renamed_from`

// Get returns the current state of a file. A tombstone is a state too and is
// returned as such; ErrNotFound means the path never existed.
func (s *Store) Get(path string) (File, error) {
	f, err := scanFile(s.db.QueryRow(`SELECT `+fileCols+` FROM files WHERE path=?`, path))
	if errors.Is(err, sql.ErrNoRows) {
		return File{}, ErrNotFound
	}
	return f, err
}

// Changes returns the log delta: entries with seq strictly greater than since,
// ordered by seq.
func (s *Store) Changes(since int64, limit int) (entries []File, nextSeqOut int64, hasMore bool, err error) {
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	rows, err := s.db.Query(`SELECT `+fileCols+` FROM files WHERE seq > ? ORDER BY seq LIMIT ?`, since, limit)
	if err != nil {
		return nil, 0, false, err
	}
	defer rows.Close()
	for rows.Next() {
		f, err := scanFile(rows)
		if err != nil {
			return nil, 0, false, err
		}
		entries = append(entries, f)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, false, err
	}
	if len(entries) == 0 {
		cur, err := s.Seq()
		if err != nil {
			return nil, 0, false, err
		}
		if cur < since {
			cur = since
		}
		return nil, cur, false, nil
	}
	return entries, entries[len(entries)-1].Seq, len(entries) == limit, nil
}

// PutArgs holds the parameters of a content write.
type PutArgs struct {
	Path      string
	BaseRev   int64 // revision the client based its write on; 0 for a new file
	Hash      string
	Size      int64
	Mtime     int64
	Folder    bool
	UpdatedBy string
}

// Put writes a new revision of a file.
//
// Idempotency: if the content matches what the server already holds, no revision is
// created and the current state is returned — retrying after a dropped connection
// is safe.
func (s *Store) Put(a PutArgs) (File, error) {
	// Matching content means there is nothing to decide, even with a stale base_rev:
	// the result on disk is identical. This is what makes a retry safe.
	sameContent := func(cur File, exists bool) (File, bool) {
		if exists && !cur.Deleted && cur.Hash == a.Hash && cur.Folder == a.Folder {
			return cur, true
		}
		return File{}, false
	}
	return s.write(a.Path, a.BaseRev, sameContent, func(tx *sql.Tx, cur File, exists bool, seq int64) (File, bool, error) {
		next := File{
			Path: a.Path, Rev: cur.Rev + 1, Seq: seq, Hash: a.Hash, Size: a.Size,
			Mtime: a.Mtime, Deleted: false, Folder: a.Folder, UpdatedBy: a.UpdatedBy,
		}
		return next, true, nil
	})
}

// Delete writes a tombstone. The blob itself is left alone, so recovery stays possible.
func (s *Store) Delete(path string, baseRev int64, updatedBy string) (File, error) {
	alreadyGone := func(cur File, exists bool) (File, bool) {
		return cur, exists && cur.Deleted // already a tombstone — the retry is safe
	}
	return s.write(path, baseRev, alreadyGone, func(tx *sql.Tx, cur File, exists bool, seq int64) (File, bool, error) {
		if !exists {
			return File{}, false, ErrNotFound
		}
		next := File{
			Path: path, Rev: cur.Rev + 1, Seq: seq, Hash: "", Size: 0,
			Mtime: cur.Mtime, Deleted: true, Folder: cur.Folder, UpdatedBy: updatedBy,
		}
		return next, true, nil
	})
}

// write is the shared wrapper: transaction, idempotent pre-check, base_rev check,
// seq allocation and the revisions row.
//
// The order matters: the pre-check runs BEFORE the base_rev comparison. A client
// killed between a successful write and its local index update will retry with the
// old base — and must get a 200, not a conflict out of nowhere.
func (s *Store) write(
	path string,
	baseRev int64,
	noop func(cur File, exists bool) (File, bool),
	apply func(tx *sql.Tx, cur File, exists bool, seq int64) (File, bool, error),
) (File, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback()

	cur, exists, err := getTx(tx, path)
	if err != nil {
		return File{}, err
	}
	if noop != nil {
		if f, ok := noop(cur, exists); ok {
			return f, nil
		}
	}
	if cur.Rev != baseRev {
		return File{}, &ConflictError{
			Path: path, ServerRev: cur.Rev, ServerHash: cur.Hash,
			Deleted: cur.Deleted, UpdatedBy: cur.UpdatedBy,
		}
	}

	seq, err := nextSeq(tx)
	if err != nil {
		return File{}, err
	}
	next, changed, err := apply(tx, cur, exists, seq)
	if err != nil {
		return File{}, err
	}
	if !changed {
		// Nothing changed — the seq counter must not advance for nothing.
		return next, tx.Rollback()
	}
	if err := upsert(tx, next); err != nil {
		return File{}, err
	}
	return next, tx.Commit()
}

func getTx(tx *sql.Tx, path string) (File, bool, error) {
	f, err := scanFile(tx.QueryRow(`SELECT `+fileCols+` FROM files WHERE path=?`, path))
	if errors.Is(err, sql.ErrNoRows) {
		return File{Path: path}, false, nil
	}
	if err != nil {
		return File{}, false, err
	}
	return f, true, nil
}

func upsert(tx *sql.Tx, f File) error {
	var hash any
	if f.Hash != "" {
		hash = f.Hash
	}
	var renamedFrom any
	if f.RenamedFrom != "" {
		renamedFrom = f.RenamedFrom
	}
	if _, err := tx.Exec(`INSERT INTO files(`+fileCols+`) VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(path) DO UPDATE SET
		  rev=excluded.rev, seq=excluded.seq, hash=excluded.hash, size=excluded.size,
		  mtime=excluded.mtime, deleted=excluded.deleted, folder=excluded.folder,
		  updated_by=excluded.updated_by, renamed_from=excluded.renamed_from`,
		f.Path, f.Rev, f.Seq, hash, f.Size, f.Mtime, b2i(f.Deleted), b2i(f.Folder), f.UpdatedBy, renamedFrom); err != nil {
		return err
	}
	_, err := tx.Exec(`INSERT INTO revisions(path, rev, hash, mtime, seq) VALUES(?,?,?,?,?)
		ON CONFLICT(path, rev) DO NOTHING`, f.Path, f.Rev, hash, f.Mtime, f.Seq)
	return err
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

// Rename moves a file whole, recording where it came from in renamed_from.
//
// This is not a delete+create pair: on another device such a pair looks like a
// deletion, and a deletion is always scarier than a rename.
func (s *Store) Rename(from, to string, baseRev int64, updatedBy string) (File, error) {
	if from == to {
		return File{}, errors.New("rename: from == to")
	}
	tx, err := s.db.Begin()
	if err != nil {
		return File{}, err
	}
	defer tx.Rollback()

	src, exists, err := getTx(tx, from)
	if err != nil {
		return File{}, err
	}
	if !exists || src.Deleted {
		return File{}, ErrNotFound
	}
	if src.Rev != baseRev {
		return File{}, &ConflictError{
			Path: from, ServerRev: src.Rev, ServerHash: src.Hash,
			Deleted: src.Deleted, UpdatedBy: src.UpdatedBy,
		}
	}
	dst, _, err := getTx(tx, to)
	if err != nil {
		return File{}, err
	}
	if !dst.Deleted && dst.Rev > 0 {
		// The destination is taken — overwriting silently would lose a note.
		return File{}, &ConflictError{
			Path: to, ServerRev: dst.Rev, ServerHash: dst.Hash,
			Deleted: dst.Deleted, UpdatedBy: dst.UpdatedBy,
		}
	}

	seqDst, err := nextSeq(tx)
	if err != nil {
		return File{}, err
	}
	newDst := File{
		Path: to, Rev: dst.Rev + 1, Seq: seqDst, Hash: src.Hash, Size: src.Size,
		Mtime: src.Mtime, Folder: src.Folder, UpdatedBy: updatedBy, RenamedFrom: from,
	}
	if err := upsert(tx, newDst); err != nil {
		return File{}, err
	}

	seqSrc, err := nextSeq(tx)
	if err != nil {
		return File{}, err
	}
	tomb := File{
		Path: from, Rev: src.Rev + 1, Seq: seqSrc, Hash: "", Size: 0,
		Mtime: src.Mtime, Deleted: true, Folder: src.Folder, UpdatedBy: updatedBy,
	}
	if err := upsert(tx, tomb); err != nil {
		return File{}, err
	}
	return newDst, tx.Commit()
}

// RevisionHash returns the hash of one revision — the base for a client-side merge.
func (s *Store) RevisionHash(path string, rev int64) (string, error) {
	var hash sql.NullString
	err := s.db.QueryRow(`SELECT hash FROM revisions WHERE path=? AND rev=?`, path, rev).Scan(&hash)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	if !hash.Valid {
		return "", ErrNotFound // tombstone revision: there is no content
	}
	return hash.String, nil
}

// GetMeta reads an opaque value the client keeps on the server, such as the key
// derivation parameters. The server never interprets these.
func (s *Store) GetMeta(key string) (string, error) {
	var v sql.NullString
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key=?`, "client:"+key).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return v.String, nil
}

// SetMeta stores a client value once. It refuses to change an existing one:
// key derivation parameters cannot be swapped without re-encrypting the vault,
// and a silent change would turn every note into unreadable bytes.
func (s *Store) SetMeta(key, value string) error {
	res, err := s.db.Exec(`INSERT INTO meta(key,value) VALUES(?,?)
		ON CONFLICT(key) DO NOTHING`, "client:"+key, value)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrMetaExists
	}
	return nil
}

// ErrMetaExists means a client value is already set and will not be overwritten.
var ErrMetaExists = errors.New("already set")

// Stats is the vault summary behind /stats, and for the operator's eyes.
type Stats struct {
	Files   int64 `json:"files"`
	Deleted int64 `json:"deleted"`
	Folders int64 `json:"folders"`
	Bytes   int64 `json:"bytes"`
	Revs    int64 `json:"revisions"`
	Seq     int64 `json:"seq"`
}

func (s *Store) Stats() (Stats, error) {
	var st Stats
	err := s.db.QueryRow(`SELECT
		COALESCE(SUM(CASE WHEN deleted=0 AND folder=0 THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN deleted=1 THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN deleted=0 AND folder=1 THEN 1 ELSE 0 END),0),
		COALESCE(SUM(CASE WHEN deleted=0 THEN size ELSE 0 END),0)
		FROM files`).Scan(&st.Files, &st.Deleted, &st.Folders, &st.Bytes)
	if err != nil {
		return st, err
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM revisions`).Scan(&st.Revs); err != nil {
		return st, err
	}
	st.Seq, err = s.Seq()
	return st, err
}
