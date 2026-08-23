// SPDX-License-Identifier: MIT

// Package store хранит метаданные волта: файлы, ревизии и глобальный лог изменений.
//
// Инварианты, на которых держится всё остальное:
//   - seq — глобальный монотонный счётчик волта, инкрементится в той же транзакции,
//     что и запись файла. Клиенты читают дельту только по нему.
//   - удаление — не DELETE, а tombstone (deleted=1, hash=NULL, rev+1).
//   - каждое состояние файла попадает в revisions, чтобы клиент мог достать общего
//     предка для 3-way merge.
package store

import (
	"database/sql"
	"errors"
	"fmt"

	_ "modernc.org/sqlite"
)

// File — текущее состояние файла в волте.
type File struct {
	Path        string `json:"path"`
	Rev         int64  `json:"rev"`
	Seq         int64  `json:"seq"`
	Hash        string `json:"hash,omitempty"` // sha256 содержимого; пусто если удалён или папка
	Size        int64  `json:"size"`
	Mtime       int64  `json:"mtime"` // unix ms, время правки на клиенте
	Deleted     bool   `json:"deleted"`
	Folder      bool   `json:"folder"`
	UpdatedBy   string `json:"updated_by,omitempty"`
	RenamedFrom string `json:"renamed_from,omitempty"`
}

// ConflictError возвращается, когда клиент отталкивается от устаревшей ревизии.
type ConflictError struct {
	Path       string
	ServerRev  int64
	ServerHash string
	Deleted    bool
}

func (e *ConflictError) Error() string {
	return fmt.Sprintf("conflict on %q: server rev %d", e.Path, e.ServerRev)
}

// ErrNotFound — файла нет в волте вовсе (не путать с tombstone).
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

// Open открывает (или создаёт) базу волта.
func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)&_pragma=synchronous(FULL)")
	if err != nil {
		return nil, err
	}
	// Одно соединение: запись в SQLite всё равно сериализуется, а так мы гарантируем,
	// что транзакция seq-счётчика никогда не гоняется сама с собой.
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Seq возвращает текущее значение глобального счётчика.
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

// Get возвращает текущее состояние файла. Tombstone — тоже состояние и возвращается,
// ErrNotFound только если пути не было никогда.
func (s *Store) Get(path string) (File, error) {
	f, err := scanFile(s.db.QueryRow(`SELECT `+fileCols+` FROM files WHERE path=?`, path))
	if errors.Is(err, sql.ErrNoRows) {
		return File{}, ErrNotFound
	}
	return f, err
}

// Changes отдаёт дельту лога: записи со seq строго больше since, в порядке seq.
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

// PutArgs — параметры записи содержимого.
type PutArgs struct {
	Path      string
	BaseRev   int64 // ревизия, от которой отталкивается клиент; 0 — файл новый
	Hash      string
	Size      int64
	Mtime     int64
	Folder    bool
	UpdatedBy string
}

// Put записывает новую ревизию файла.
//
// Идемпотентность: если содержимое совпало с текущим серверным, ревизия не плодится
// и возвращается текущее состояние — повтор запроса после обрыва связи безопасен.
func (s *Store) Put(a PutArgs) (File, error) {
	// Совпало содержимое — значит нечего решать, даже если base_rev устарел: результат
	// на диске тот же самый. Именно это делает повтор после обрыва безопасным.
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

// Delete ставит tombstone. Содержимое blob'а не трогается — восстановление остаётся возможным.
func (s *Store) Delete(path string, baseRev int64, updatedBy string) (File, error) {
	alreadyGone := func(cur File, exists bool) (File, bool) {
		return cur, exists && cur.Deleted // уже tombstone — повтор безопасен
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

// write — общая обвязка: транзакция, идемпотентный пре-чек, проверка base_rev,
// выдача seq, запись в revisions.
//
// Порядок важен: пре-чек идёт ДО сверки base_rev. Клиента убивают между успешной
// записью и обновлением локального индекса, он повторяет запрос со старой базой —
// и должен получить 200, а не конфликт на пустом месте.
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
		return File{}, &ConflictError{Path: path, ServerRev: cur.Rev, ServerHash: cur.Hash, Deleted: cur.Deleted}
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
		// Ничего не поменялось — счётчик seq не должен уезжать вхолостую.
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

// Rename переносит файл целиком, сохраняя историю пути в renamed_from.
//
// Это не пара delete+create: на другом устройстве такая пара выглядит как удаление,
// а удаление всегда страшнее переименования.
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
		return File{}, &ConflictError{Path: from, ServerRev: src.Rev, ServerHash: src.Hash, Deleted: src.Deleted}
	}
	dst, _, err := getTx(tx, to)
	if err != nil {
		return File{}, err
	}
	if !dst.Deleted && dst.Rev > 0 {
		// Занятый путь назначения — молча перезаписывать нельзя, это потеря заметки.
		return File{}, &ConflictError{Path: to, ServerRev: dst.Rev, ServerHash: dst.Hash, Deleted: dst.Deleted}
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

// RevisionHash отдаёт хеш конкретной ревизии — база для 3-way merge на клиенте.
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
		return "", ErrNotFound // ревизия-tombstone: содержимого нет
	}
	return hash.String, nil
}

// Stats — сводка по волту для /stats и для глаз оператора.
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
