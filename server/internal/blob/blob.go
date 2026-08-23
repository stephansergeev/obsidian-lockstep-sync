// SPDX-License-Identifier: MIT

// Package blob is content-addressed storage: blobs/<sha256[0:2]>/<sha256>.
//
// It buys three things for free: deduplication, idempotent uploads (a retry writes
// the same path) and history — an old revision stays on disk for as long as a row
// in revisions still points at it.
package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
)

var ErrNotFound = errors.New("blob not found")

var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidHash rejects attempts to pass a path where a hash is expected.
func ValidHash(h string) bool { return hashRe.MatchString(h) }

type Store struct {
	root string
}

func Open(root string) (*Store, error) {
	if err := os.MkdirAll(filepath.Join(root, "tmp"), 0o700); err != nil {
		return nil, err
	}
	return &Store{root: root}, nil
}

func (s *Store) path(hash string) string {
	return filepath.Join(s.root, hash[:2], hash)
}

// Put takes a stream, hashes it as it goes and stores the content under that hash.
// Writes always go through a temporary file plus rename: an interrupted upload
// cannot leave a truncated blob behind.
func (s *Store) Put(r io.Reader, limit int64) (hash string, size int64, err error) {
	tmp, err := os.CreateTemp(filepath.Join(s.root, "tmp"), "up-*")
	if err != nil {
		return "", 0, err
	}
	tmpName := tmp.Name()
	defer func() {
		tmp.Close()
		os.Remove(tmpName)
	}()

	h := sha256.New()
	src := io.Reader(r)
	if limit > 0 {
		src = io.LimitReader(r, limit+1)
	}
	size, err = io.Copy(io.MultiWriter(tmp, h), src)
	if err != nil {
		return "", 0, err
	}
	if limit > 0 && size > limit {
		return "", 0, fmt.Errorf("payload exceeds limit of %d bytes", limit)
	}
	if err := tmp.Sync(); err != nil {
		return "", 0, err
	}
	if err := tmp.Close(); err != nil {
		return "", 0, err
	}

	hash = hex.EncodeToString(h.Sum(nil))
	dst := s.path(hash)
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return "", 0, err
	}
	if _, err := os.Stat(dst); err == nil {
		return hash, size, nil // already stored — deduplication
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return "", 0, err
	}
	return hash, size, nil
}

// Open returns content by hash. *os.File is needed as a ReadSeeker for Range requests.
func (s *Store) Open(hash string) (*os.File, error) {
	if !ValidHash(hash) {
		return nil, ErrNotFound
	}
	f, err := os.Open(s.path(hash))
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrNotFound
	}
	return f, err
}

func (s *Store) Has(hash string) bool {
	if !ValidHash(hash) {
		return false
	}
	_, err := os.Stat(s.path(hash))
	return err == nil
}

// SweepResult reports what a sweep found or removed.
type SweepResult struct {
	Removed int64
	Bytes   int64
}

// Sweep deletes blobs nothing points at any more.
//
// The set of live hashes has to come from the metadata in one piece: content is
// shared between paths and revisions, so a blob is only garbage when the entire
// vault has stopped referring to it. Anything the store did not name is removed,
// which also collects the blobs left behind by uploads that ended in a conflict.
func (s *Store) Sweep(live map[string]bool, dryRun bool) (SweepResult, error) {
	var out SweepResult
	err := filepath.WalkDir(s.root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			// The staging directory holds partial uploads in flight, not content.
			if d.Name() == "tmp" && filepath.Dir(path) == s.root {
				return filepath.SkipDir
			}
			return nil
		}
		name := d.Name()
		if !ValidHash(name) || live[name] {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out.Removed++
		out.Bytes += info.Size()
		if dryRun {
			return nil
		}
		return os.Remove(path)
	})
	return out, err
}
