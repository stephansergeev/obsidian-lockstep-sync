// SPDX-License-Identifier: MIT

package store

import (
	"math"
	"time"
)

// GCPolicy says what history is worth keeping.
//
// The defaults come from the specification: revisions older than thirty days and
// deeper than twenty are dropped, tombstones older than ninety days go with them.
// Both conditions have to hold, so a file edited fifty times this morning keeps all
// fifty, and a file untouched for a year keeps its last twenty.
type GCPolicy struct {
	KeepDays      int
	KeepRevisions int
	TombstoneDays int
	DryRun        bool
}

func DefaultGCPolicy() GCPolicy {
	return GCPolicy{KeepDays: 30, KeepRevisions: 20, TombstoneDays: 90}
}

type GCResult struct {
	RevisionsDropped int64
	TombstonesFreed  int64
}

// Collect prunes history.
//
// It never touches the current revision of a live file. Losing history is an
// inconvenience; losing what a file is right now is the failure this whole project
// exists to prevent, so the query that finds candidates excludes it explicitly.
func (s *Store) Collect(p GCPolicy) (GCResult, error) {
	var out GCResult
	cutoff := time.Now().AddDate(0, 0, -p.KeepDays).UnixMilli()
	tombCutoff := time.Now().AddDate(0, 0, -p.TombstoneDays).UnixMilli()

	tx, err := s.db.Begin()
	if err != nil {
		return out, err
	}
	defer tx.Rollback()

	// Old and deep revisions of files that still exist. The window is per path, so
	// the most recent KeepRevisions of every file survive whatever their age.
	res, err := tx.Exec(`
		DELETE FROM revisions WHERE (path, rev) IN (
			SELECT r.path, r.rev FROM revisions r
			JOIN files f ON f.path = r.path
			WHERE r.rev <> f.rev
			  AND r.mtime < ?
			  AND r.rev <= f.rev - ?
		)`, cutoff, p.KeepRevisions)
	if err != nil {
		return out, err
	}
	out.RevisionsDropped, _ = res.RowsAffected()

	// Tombstones old enough that nobody is coming back for them, and every revision
	// of the path they marked.
	res, err = tx.Exec(`
		DELETE FROM revisions WHERE path IN (
			SELECT path FROM files WHERE deleted = 1 AND mtime < ?
		)`, tombCutoff)
	if err != nil {
		return out, err
	}
	res, err = tx.Exec(`DELETE FROM files WHERE deleted = 1 AND mtime < ?`, tombCutoff)
	if err != nil {
		return out, err
	}
	out.TombstonesFreed, _ = res.RowsAffected()

	if p.DryRun {
		return out, tx.Rollback()
	}
	return out, tx.Commit()
}

// ForgetDeleted erases files that were deleted more than the given number of days
// ago, along with every revision of them.
//
// This is the one thing here that happens on its own, because "deleted" has to mean
// gone eventually or the word is a lie. Everything else about collection stays
// manual. Zero days means never, and a vault set that way keeps deletions for good.
func (s *Store) ForgetDeleted(days int) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	return s.forgetDeletedBefore(time.Now().AddDate(0, 0, -days).UnixMilli())
}

// ForgetAllDeleted erases every deleted file right now, whatever the retention
// window says, along with every revision of each.
//
// This exists for one moment: a vault that was readable on the server has just been
// re-uploaded encrypted, and the readable copies are the tombstones. Keeping them
// for the retention window would keep the vault readable for the retention window.
func (s *Store) ForgetAllDeleted() (int64, error) {
	return s.forgetDeletedBefore(math.MaxInt64)
}

func (s *Store) forgetDeletedBefore(cutoff int64) (int64, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`
		DELETE FROM revisions WHERE path IN (
			SELECT path FROM files WHERE deleted = 1 AND mtime < ?
		)`, cutoff); err != nil {
		return 0, err
	}
	res, err := tx.Exec(`DELETE FROM files WHERE deleted = 1 AND mtime < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return n, tx.Commit()
}

// LiveHashes is every hash still pointed at by anything.
//
// Content is addressed by hash and shared between paths and revisions, so whether a
// blob is still needed can only be asked of the whole vault at once. Guessing per
// file would delete content that another path still uses.
func (s *Store) LiveHashes() (map[string]bool, error) {
	live := map[string]bool{}
	for _, q := range []string{
		`SELECT hash FROM files WHERE hash IS NOT NULL`,
		`SELECT hash FROM revisions WHERE hash IS NOT NULL`,
	} {
		rows, err := s.db.Query(q)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var h string
			if err := rows.Scan(&h); err != nil {
				rows.Close()
				return nil, err
			}
			live[h] = true
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, err
		}
		rows.Close()
	}
	return live, nil
}
