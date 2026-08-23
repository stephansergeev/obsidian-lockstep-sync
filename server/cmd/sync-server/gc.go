// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"flag"
	"fmt"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/store"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/vault"
)

// collect prunes history and removes content nothing points at.
//
// Not run automatically and not on a timer. Deleting history is the one operation
// here that cannot be undone, so it happens when somebody asks for it, having first
// been able to see what it would do.
func collect(args []string) error {
	fs_ := flag.NewFlagSet("gc", flag.ExitOnError)
	data := dataDir(fs_)
	vaultName := fs_.String("vault", "main", "vault name")
	all := fs_.Bool("all", false, "every vault on this server")
	policy := store.DefaultGCPolicy()
	keepDays := fs_.Int("keep-days", policy.KeepDays, "keep every revision newer than this many days")
	keepRevs := fs_.Int("keep-revisions", policy.KeepRevisions, "keep at least this many revisions of every file")
	tombDays := fs_.Int("tombstone-days", policy.TombstoneDays, "forget deleted files after this many days")
	dryRun := fs_.Bool("dry-run", false, "show what would go, change nothing")
	if err := fs_.Parse(args); err != nil {
		return err
	}
	if *keepRevs < 1 {
		return errors.New("--keep-revisions must be at least 1: the current version is not history")
	}

	reg := vault.NewRegistry(*data)
	defer reg.Close()

	names := []string{*vaultName}
	if *all {
		found, err := reg.List()
		if err != nil {
			return err
		}
		if len(found) == 0 {
			fmt.Println("no vaults on this server")
			return nil
		}
		names = found
	}

	p := store.GCPolicy{
		KeepDays:      *keepDays,
		KeepRevisions: *keepRevs,
		TombstoneDays: *tombDays,
		DryRun:        *dryRun,
	}

	for _, name := range names {
		files, blobs, err := reg.Get(name)
		if err != nil {
			return err
		}
		result, err := files.Collect(p)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		live, err := files.LiveHashes()
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		swept, err := blobs.Sweep(live, *dryRun)
		if err != nil {
			return fmt.Errorf("%s: %w", name, err)
		}
		verb := "removed"
		if *dryRun {
			verb = "would remove"
		}
		fmt.Printf("%s: %s %d revisions, %d forgotten deletions, %d files of content (%d bytes)\n",
			name, verb, result.RevisionsDropped, result.TombstonesFreed, swept.Removed, swept.Bytes)
	}
	return nil
}
