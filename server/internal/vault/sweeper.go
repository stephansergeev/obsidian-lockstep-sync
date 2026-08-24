// SPDX-License-Identifier: MIT

package vault

import (
	"context"
	"log/slog"
	"strconv"
	"time"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/store"
)

// Sweeper erases deletions that have outlived their retention.
//
// This is the only thing on this server that deletes without being asked, and it is
// deliberate: "deleted" has to mean gone eventually, or the word is a lie and a
// vault becomes a place where nothing can ever be taken back out.
//
// It only touches files that are already deleted and already past the window their
// owner set. History of files that still exist is never collected on a timer, and
// there is no schedule that can reach it.
type Sweeper struct {
	Registry *Registry
	Interval time.Duration
	Log      *slog.Logger
}

const defaultRetentionDays = 30

func (s *Sweeper) Run(ctx context.Context) {
	interval := s.Interval
	if interval <= 0 {
		interval = 6 * time.Hour
	}
	// A pass at start, so a server that is restarted often still keeps its promise.
	s.once()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.once()
		}
	}
}

func (s *Sweeper) once() {
	names, err := s.Registry.List()
	if err != nil {
		s.Log.Error("sweeper: listing vaults", "err", err)
		return
	}
	for _, name := range names {
		files, blobs, err := s.Registry.Get(name)
		if err != nil {
			s.Log.Error("sweeper: opening vault", "vault", name, "err", err)
			continue
		}
		days := retention(files)
		if days <= 0 {
			continue // this vault keeps its deletions
		}
		forgotten, err := files.ForgetDeleted(days)
		if err != nil {
			s.Log.Error("sweeper: forgetting deletions", "vault", name, "err", err)
			continue
		}
		if forgotten == 0 {
			continue
		}
		live, err := files.LiveHashes()
		if err != nil {
			s.Log.Error("sweeper: listing content", "vault", name, "err", err)
			continue
		}
		swept, err := blobs.Sweep(live, false)
		if err != nil {
			s.Log.Error("sweeper: removing content", "vault", name, "err", err)
			continue
		}
		s.Log.Info("erased deletions past their window",
			"vault", name, "days", days, "files", forgotten, "bytes", swept.Bytes)
	}
}

func retention(files *store.Store) int {
	value, err := files.GetMeta("retention_days")
	if err != nil {
		return defaultRetentionDays
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 0 {
		return defaultRetentionDays
	}
	return n
}
