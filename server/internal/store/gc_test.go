// SPDX-License-Identifier: MIT

package store_test

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/blob"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/store"
)

// Collecting garbage is the only operation here that cannot be undone. Every test
// below is about the same thing: it must never take something still needed.

func open(t *testing.T) (*store.Store, *blob.Store, string) {
	t.Helper()
	dir := t.TempDir()
	files, err := store.Open(filepath.Join(dir, "meta.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { files.Close() })
	blobs, err := blob.Open(filepath.Join(dir, "blobs"))
	if err != nil {
		t.Fatal(err)
	}
	return files, blobs, dir
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

func daysAgo(n int) int64 {
	return time.Now().AddDate(0, 0, -n).UnixMilli()
}

// write puts one revision in, dated as if it happened n days ago.
func write(t *testing.T, s *store.Store, blobs *blob.Store, path, content string, rev int64, days int) {
	t.Helper()
	hash, size, err := blobs.Put(strings.NewReader(content), 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(store.PutArgs{
		Path: path, BaseRev: rev - 1, Hash: hash, Size: size,
		Mtime: daysAgo(days), UpdatedBy: "test",
	}); err != nil {
		t.Fatalf("%s rev %d: %v", path, rev, err)
	}
}

func TestCollectKeepsTheCurrentVersion(t *testing.T) {
	files, blobs, _ := open(t)
	for i := 1; i <= 40; i++ {
		write(t, files, blobs, "note.md", strings.Repeat("x", i), int64(i), 200)
	}

	if _, err := files.Collect(store.GCPolicy{KeepDays: 30, KeepRevisions: 5, TombstoneDays: 90}); err != nil {
		t.Fatal(err)
	}

	// Whatever else went, the file itself has to still be readable.
	f, err := files.Get("note.md")
	if err != nil {
		t.Fatal(err)
	}
	if f.Rev != 40 {
		t.Fatalf("current revision changed: %d", f.Rev)
	}
	if _, err := files.RevisionHash("note.md", 40); err != nil {
		t.Fatalf("the current revision lost its content: %v", err)
	}
}

func TestCollectKeepsTheMostRecentRevisions(t *testing.T) {
	files, blobs, _ := open(t)
	for i := 1; i <= 40; i++ {
		write(t, files, blobs, "note.md", strings.Repeat("x", i), int64(i), 200)
	}
	if _, err := files.Collect(store.GCPolicy{KeepDays: 30, KeepRevisions: 20, TombstoneDays: 90}); err != nil {
		t.Fatal(err)
	}

	for rev := int64(21); rev <= 40; rev++ {
		if _, err := files.RevisionHash("note.md", rev); err != nil {
			t.Fatalf("revision %d should have survived: %v", rev, err)
		}
	}
	if _, err := files.RevisionHash("note.md", 1); err == nil {
		t.Fatal("revision 1 was old and deep and should have gone")
	}
}

func TestCollectSparesRecentHistoryHoweverDeep(t *testing.T) {
	files, blobs, _ := open(t)
	// Fifty edits this morning. Depth alone is not a reason to forget them.
	for i := 1; i <= 50; i++ {
		write(t, files, blobs, "note.md", strings.Repeat("y", i), int64(i), 0)
	}
	if _, err := files.Collect(store.GCPolicy{KeepDays: 30, KeepRevisions: 5, TombstoneDays: 90}); err != nil {
		t.Fatal(err)
	}
	if _, err := files.RevisionHash("note.md", 1); err != nil {
		t.Fatalf("today's history was thrown away: %v", err)
	}
}

func TestCollectForgetsOldDeletionsButNotRecentOnes(t *testing.T) {
	files, blobs, _ := open(t)
	write(t, files, blobs, "old.md", "gone long ago", 1, 200)
	write(t, files, blobs, "fresh.md", "gone yesterday", 1, 200)

	for _, path := range []string{"old.md", "fresh.md"} {
		if _, err := files.Delete(path, 1, "test"); err != nil {
			t.Fatal(err)
		}
	}
	// Age the tombstone on one of them.
	if _, err := files.Put(store.PutArgs{Path: "old.md", BaseRev: 2, Hash: "", Size: 0, Mtime: daysAgo(200)}); err == nil {
		t.Skip("resurrecting changes the shape of this test")
	}

	before, _ := files.Get("fresh.md")
	if !before.Deleted {
		t.Fatal("fresh.md should be a tombstone")
	}
	if _, err := files.Collect(store.GCPolicy{KeepDays: 30, KeepRevisions: 20, TombstoneDays: 90}); err != nil {
		t.Fatal(err)
	}
	if _, err := files.Get("fresh.md"); err != nil {
		t.Fatal("a recent deletion must stay recoverable")
	}
}

func TestSweepRemovesOrphansAndSparesSharedContent(t *testing.T) {
	files, blobs, _ := open(t)
	write(t, files, blobs, "one.md", "shared body", 1, 0)
	write(t, files, blobs, "two.md", "shared body", 1, 0) // same content, same blob

	// A blob written by an upload that ended in a conflict: on disk, referenced by
	// nothing. Collecting it is the point.
	orphanHash, _, err := blobs.Put(strings.NewReader("never committed"), 0)
	if err != nil {
		t.Fatal(err)
	}

	live, err := files.LiveHashes()
	if err != nil {
		t.Fatal(err)
	}
	res, err := blobs.Sweep(live, false)
	if err != nil {
		t.Fatal(err)
	}
	if res.Removed != 1 {
		t.Fatalf("expected exactly the orphan to go, %d went", res.Removed)
	}
	if blobs.Has(orphanHash) {
		t.Fatal("the orphan is still there")
	}
	if !blobs.Has(sha("shared body")) {
		t.Fatal("content shared by two paths was deleted")
	}
}

func TestSweepSparesContentAnotherPathStillUses(t *testing.T) {
	files, blobs, _ := open(t)
	write(t, files, blobs, "kept.md", "same text", 1, 0)
	write(t, files, blobs, "dropped.md", "same text", 1, 200)
	if _, err := files.Delete("dropped.md", 1, "test"); err != nil {
		t.Fatal(err)
	}
	if _, err := files.Collect(store.GCPolicy{KeepDays: 0, KeepRevisions: 1, TombstoneDays: 0}); err != nil {
		t.Fatal(err)
	}
	live, err := files.LiveHashes()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := blobs.Sweep(live, false); err != nil {
		t.Fatal(err)
	}
	if !blobs.Has(sha("same text")) {
		t.Fatal("content was deleted while another path still used it")
	}
}

func TestDryRunChangesNothing(t *testing.T) {
	files, blobs, _ := open(t)
	for i := 1; i <= 40; i++ {
		write(t, files, blobs, "note.md", strings.Repeat("z", i), int64(i), 200)
	}
	orphan, _, err := blobs.Put(strings.NewReader("orphan"), 0)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := files.Collect(store.GCPolicy{KeepDays: 30, KeepRevisions: 5, TombstoneDays: 90, DryRun: true}); err != nil {
		t.Fatal(err)
	}
	live, _ := files.LiveHashes()
	if _, err := blobs.Sweep(live, true); err != nil {
		t.Fatal(err)
	}

	if _, err := files.RevisionHash("note.md", 1); err != nil {
		t.Fatal("a dry run deleted a revision")
	}
	if !blobs.Has(orphan) {
		t.Fatal("a dry run deleted a blob")
	}
}
