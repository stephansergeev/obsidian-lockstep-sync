// SPDX-License-Identifier: MIT

// Package vault is the on-disk registry of vaults.
//
// One vault = one directory: meta.db (SQLite) + blobs/. Multi-vault support comes
// without a vault_id column and without multi-tenancy: a token simply says which
// directory to open.
package vault

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/auth"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/blob"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/store"
)

type entry struct {
	files *store.Store
	blobs *blob.Store
}

type Registry struct {
	root string
	mu   sync.Mutex
	open map[string]entry
}

func NewRegistry(root string) *Registry {
	return &Registry{root: root, open: map[string]entry{}}
}

// Get opens a vault lazily and caches the connection.
func (r *Registry) Get(name string) (*store.Store, *blob.Store, error) {
	if !auth.ValidVault(name) {
		return nil, nil, fmt.Errorf("invalid vault name %q", name)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.open[name]; ok {
		return e.files, e.blobs, nil
	}
	dir := filepath.Join(r.root, "vaults", name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, nil, err
	}
	files, err := store.Open(filepath.Join(dir, "meta.db"))
	if err != nil {
		return nil, nil, err
	}
	blobs, err := blob.Open(filepath.Join(dir, "blobs"))
	if err != nil {
		files.Close()
		return nil, nil, err
	}
	r.open[name] = entry{files: files, blobs: blobs}
	return files, blobs, nil
}

func (r *Registry) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, e := range r.open {
		e.files.Close()
	}
	r.open = map[string]entry{}
}

// List enumerates the vaults that already exist on disk.
func (r *Registry) List() ([]string, error) {
	ents, err := os.ReadDir(filepath.Join(r.root, "vaults"))
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []string
	for _, e := range ents {
		if e.IsDir() {
			out = append(out, e.Name())
		}
	}
	return out, nil
}
