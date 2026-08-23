// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/text/unicode/norm"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/store"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/vault"
)

// importVault uploads an existing vault from disk into a vault on the server.
//
// It exists for the first run: the client downloads from the server, but the server
// has to learn the content from somewhere first. The operation is idempotent — a
// second run creates no revisions, because matching hashes are a no-op.
func importVault(args []string) error {
	fs_ := flag.NewFlagSet("import", flag.ExitOnError)
	data := dataDir(fs_)
	vaultName := fs_.String("vault", "main", "vault name on the server")
	from := fs_.String("from", "", "vault directory on disk (required)")
	withConfig := fs_.Bool("with-config", false, "include .obsidian/ as well (off by default)")
	dryRun := fs_.Bool("dry-run", false, "only show what would be uploaded")
	device := fs_.String("as", "import", "device name to attribute the changes to")
	if err := fs_.Parse(args); err != nil {
		return err
	}
	if *from == "" {
		return errors.New("--from is required")
	}
	root, err := filepath.Abs(*from)
	if err != nil {
		return err
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return fmt.Errorf("%s is not a directory", root)
	}

	reg := vault.NewRegistry(*data)
	defer reg.Close()
	files, blobs, err := reg.Get(*vaultName)
	if err != nil {
		return err
	}

	var added, unchanged, skipped int
	var bytes int64
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(root, p)
		if err != nil || rel == "." {
			return err
		}
		// On the wire the separator is always '/', whatever the OS thinks.
		rel = norm.NFC.String(filepath.ToSlash(rel))

		if d.IsDir() {
			if skipDir(rel, *withConfig) {
				return filepath.SkipDir
			}
			return nil
		}
		if skipFile(rel, *withConfig) {
			skipped++
			return nil
		}

		info, err := d.Info()
		if err != nil {
			return err
		}
		if *dryRun {
			fmt.Printf("  + %s (%d bytes)\n", rel, info.Size())
			added++
			bytes += info.Size()
			return nil
		}

		f, err := os.Open(p)
		if err != nil {
			return err
		}
		hash, size, err := blobs.Put(f, 0)
		f.Close()
		if err != nil {
			return err
		}

		cur, err := files.Get(rel)
		baseRev := int64(0)
		if err == nil {
			baseRev = cur.Rev
			if cur.Hash == hash && !cur.Deleted {
				unchanged++
				return nil
			}
		} else if !errors.Is(err, store.ErrNotFound) {
			return err
		}

		if _, err := files.Put(store.PutArgs{
			Path: rel, BaseRev: baseRev, Hash: hash, Size: size,
			Mtime: info.ModTime().UnixMilli(), UpdatedBy: *device,
		}); err != nil {
			return fmt.Errorf("%s: %w", rel, err)
		}
		added++
		bytes += size
		return nil
	})
	if err != nil {
		return err
	}

	seq, _ := files.Seq()
	verb := "uploaded"
	if *dryRun {
		verb = "would upload"
	}
	fmt.Printf("%s: %d files (%d bytes), unchanged %d, skipped %d, seq=%d\n",
		verb, added, bytes, unchanged, skipped, seq)
	return nil
}

// skipDir and skipFile keep out what is pointless or harmful to sync: OS metadata,
// caches and Obsidian's own trash.
func skipDir(rel string, withConfig bool) bool {
	base := filepath.Base(rel)
	switch base {
	case ".git", ".trash", "node_modules", ".stfolder":
		return true
	}
	if base == ".obsidian" && !withConfig {
		return true
	}
	return false
}

func skipFile(rel string, withConfig bool) bool {
	base := filepath.Base(rel)
	if base == ".DS_Store" || base == "Thumbs.db" || strings.HasSuffix(base, ".tmp") {
		return true
	}
	if strings.HasPrefix(rel, ".obsidian/") {
		if !withConfig {
			return true
		}
		// Window state is per-device and only gets in the way of syncing.
		return base == "workspace.json" || base == "workspace-mobile.json"
	}
	return false
}
