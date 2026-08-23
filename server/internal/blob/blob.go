// SPDX-License-Identifier: MIT

// Package blob — контент-адресуемое хранилище: blobs/<sha256[0:2]>/<sha256>.
//
// Даёт три вещи даром: дедупликацию, идемпотентную загрузку (повтор пишет тот же путь)
// и историю — старая ревизия остаётся лежать, пока на неё ссылается запись в revisions.
package blob

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

var ErrNotFound = errors.New("blob not found")

var hashRe = regexp.MustCompile(`^[0-9a-f]{64}$`)

// ValidHash отсекает попытки подсунуть путь вместо хеша.
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

// Put принимает поток, считает sha256 на лету и кладёт содержимое по хешу.
// Запись всегда идёт через временный файл + rename: оборванная загрузка не может
// оставить в хранилище обрезанный blob.
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
		return hash, size, nil // уже лежит — дедупликация
	}
	if err := os.Rename(tmpName, dst); err != nil {
		return "", 0, err
	}
	return hash, size, nil
}

// Open отдаёт содержимое по хешу. *os.File нужен как ReadSeeker для Range-запросов.
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
