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

// importVault заливает существующий волт с диска в волт на сервере.
//
// Нужен для первого заезда: клиент качает с сервера, но сервер сначала должен
// откуда-то узнать содержимое. Операция идемпотентна — повторный запуск не
// плодит ревизии, потому что совпадение хеша на сервере это no-op.
func importVault(args []string) error {
	fs_ := flag.NewFlagSet("import", flag.ExitOnError)
	data := dataDir(fs_)
	vaultName := fs_.String("vault", "main", "имя волта на сервере")
	from := fs_.String("from", "", "каталог волта на диске (обязательно)")
	withConfig := fs_.Bool("with-config", false, "заливать и .obsidian/ (по умолчанию нет)")
	dryRun := fs_.Bool("dry-run", false, "только показать, что было бы залито")
	device := fs_.String("as", "import", "чьим именем подписать изменения")
	if err := fs_.Parse(args); err != nil {
		return err
	}
	if *from == "" {
		return errors.New("--from обязателен")
	}
	root, err := filepath.Abs(*from)
	if err != nil {
		return err
	}
	if st, err := os.Stat(root); err != nil || !st.IsDir() {
		return fmt.Errorf("%s не каталог", root)
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
		// На проводе разделитель всегда '/', даже если ОС думает иначе.
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
			fmt.Printf("  + %s (%d байт)\n", rel, info.Size())
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
	verb := "залито"
	if *dryRun {
		verb = "было бы залито"
	}
	fmt.Printf("%s: %d файлов (%d байт), без изменений %d, пропущено %d, seq=%d\n",
		verb, added, bytes, unchanged, skipped, seq)
	return nil
}

// skipDir и skipFile держат в стороне то, что синхронизировать бессмысленно
// или вредно: служебные каталоги ОС, кеши и корзину Obsidian.
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
		// Состояние окон у каждого устройства своё, синку оно только мешает.
		return base == "workspace.json" || base == "workspace-mobile.json"
	}
	return false
}
