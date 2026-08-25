// SPDX-License-Identifier: MIT

// Package api is the server's HTTP surface.
//
// The contract lives in /spec. The essentials: a client never walks the vault tree,
// it reads a delta by the global seq and bases every write on a base_rev.
package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/text/unicode/norm"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/auth"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/blob"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/store"
)

// Vaults is the registry of open vaults. One vault = its own SQLite database and
// blob directory, so multi-vault support needs neither a vault_id column nor any
// multi-tenancy.
type Vaults interface {
	Get(name string) (*store.Store, *blob.Store, error)
}

type Server struct {
	Auth      *auth.Store
	Vaults    Vaults
	MaxUpload int64 // 0 means no limit
	Log       *slog.Logger

	mu sync.Mutex
}

func (s *Server) logger() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/health", s.health)
	mux.HandleFunc("GET /v1/stats", s.auth(s.stats))
	mux.HandleFunc("GET /v1/changes", s.auth(s.changes))
	mux.HandleFunc("GET /v1/file", s.auth(s.getFile))
	mux.HandleFunc("HEAD /v1/file", s.auth(s.getFile))
	mux.HandleFunc("PUT /v1/file", s.auth(s.putFile))
	mux.HandleFunc("DELETE /v1/file", s.auth(s.deleteFile))
	mux.HandleFunc("POST /v1/rename", s.auth(s.rename))
	mux.HandleFunc("GET /v1/deleted", s.auth(s.deleted))
	mux.HandleFunc("DELETE /v1/deleted", s.auth(s.purgeDeleted))
	mux.HandleFunc("POST /v1/tokens", s.auth(s.issueToken))
	mux.HandleFunc("POST /v1/join", s.auth(s.createJoin))
	mux.HandleFunc("POST /v1/join/redeem", s.redeemJoin)
	mux.HandleFunc("GET /join/{code}", s.joinPage)
	mux.HandleFunc("GET /v1/retention", s.auth(s.getRetention))
	mux.HandleFunc("PUT /v1/retention", s.auth(s.putRetention))
	mux.HandleFunc("GET /v1/vaultkey", s.auth(s.getVaultKey))
	mux.HandleFunc("PUT /v1/vaultkey", s.auth(s.putVaultKey))
	mux.HandleFunc("PUT /v1/vaultkey/migration", s.auth(s.putMigration))
	mux.HandleFunc("DELETE /v1/vaultkey/migration", s.auth(s.clearMigration))
	return mux
}

type ctx struct {
	tok   auth.Token
	files *store.Store
	blobs *blob.Store
}

func (s *Server) auth(next func(http.ResponseWriter, *http.Request, ctx)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hdr := r.Header.Get("Authorization")
		raw := ""
		if len(hdr) > 7 && strings.EqualFold(hdr[:7], "bearer ") {
			raw = strings.TrimSpace(hdr[7:])
		}
		tok, err := s.Auth.Resolve(raw)
		if err != nil {
			writeErr(w, http.StatusUnauthorized, "unauthorized", "invalid or missing bearer token")
			return
		}
		files, blobs, err := s.Vaults.Get(tok.Vault)
		if err != nil {
			s.logger().Error("open vault", "vault", tok.Vault, "err", err)
			writeErr(w, http.StatusInternalServerError, "vault_unavailable", err.Error())
			return
		}
		next(w, r, ctx{tok: tok, files: files, blobs: blobs})
	}
}

// --- paths ------------------------------------------------------------------

// checkPath is the single place that decides what may become a path in a vault.
//
// NFC is mandatory: macOS hands out NFD, and allowing both forms would split
// non-ASCII names into two different files that look identical.
func checkPath(p string) (string, error) {
	if p == "" {
		return "", errors.New("path is empty")
	}
	if len(p) > 1024 {
		return "", errors.New("path is longer than 1024 bytes")
	}
	if !norm.NFC.IsNormalString(p) {
		return "", errors.New("path must be NFC-normalised (normalize on the client before sending)")
	}
	if strings.HasPrefix(p, "/") || strings.Contains(p, `\`) {
		return "", errors.New("path must be vault-relative and use '/' as separator")
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f || unicode.Is(unicode.Cf, r) {
			return "", errors.New("path contains control characters")
		}
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return "", errors.New("path contains empty or relative segments")
		}
		if strings.HasSuffix(seg, " ") || strings.HasSuffix(seg, ".") {
			return "", errors.New("path segment ends with a space or dot")
		}
	}
	return p, nil
}

func pathParam(r *http.Request) (string, error) {
	return checkPath(r.URL.Query().Get("path"))
}

// device is the name a person gave this device in their own settings, sent with
// every write. It is what the other side is called when a conflict asks which
// version stands, so it has to be that name rather than the name on the token,
// which was chosen once by whoever issued it.
func device(r *http.Request, fallback string) string {
	name := strings.TrimSpace(r.Header.Get("X-Device"))
	if name == "" || len(name) > 64 {
		return fallback
	}
	for _, c := range name {
		if c < 0x20 || c == 0x7f {
			return fallback
		}
	}
	return name
}

// --- responses --------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	writeJSON(w, code, map[string]string{"error": kind, "message": msg})
}

// writeConflict hands the client everything it needs for a 3-way merge: the
// server's current revision and its hash.
func writeConflict(w http.ResponseWriter, c *store.ConflictError) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error":       "conflict",
		"path":        c.Path,
		"server_rev":  c.ServerRev,
		"server_hash": c.ServerHash,
		"deleted":     c.Deleted,
		"updated_by":  c.UpdatedBy,
	})
}

func fileResp(f store.File) map[string]any {
	return map[string]any{"rev": f.Rev, "seq": f.Seq, "hash": f.Hash, "path": f.Path, "deleted": f.Deleted}
}

// --- handlers -----------------------------------------------------------------

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "time": time.Now().UTC().Format(time.RFC3339)})
}

func (s *Server) stats(w http.ResponseWriter, r *http.Request, c ctx) {
	st, err := c.files.Stats()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"vault": c.tok.Vault, "files": st.Files, "folders": st.Folders,
		"deleted": st.Deleted, "bytes": st.Bytes, "revisions": st.Revs, "seq": st.Seq,
	})
}

func (s *Server) changes(w http.ResponseWriter, r *http.Request, c ctx) {
	since, err := intParam(r, "since", 0)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "since: "+err.Error())
		return
	}
	limit, err := intParam(r, "limit", 500)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "limit: "+err.Error())
		return
	}
	entries, next, more, err := c.files.Changes(since, int(limit))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if entries == nil {
		entries = []store.File{}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"entries": entries, "next_seq": next, "has_more": more,
	})
}

// Issue a token for another device on the same vault.
//
// Anybody already holding a token for a vault can hand one to a device they own.
// That is no more access than they already have, and it turns adding a phone from a
// terminal session into a tap. Each device gets its own, so losing one means
// revoking one.
func (s *Server) issueToken(w http.ResponseWriter, r *http.Request, c ctx) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 64 {
		writeErr(w, http.StatusBadRequest, "bad_request", "name must be between 1 and 64 characters")
		return
	}
	token, err := s.Auth.Add(name, c.tok.Vault)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.logger().Info("issued a token", "vault", c.tok.Vault, "name", name, "by", c.tok.Name)
	writeJSON(w, http.StatusOK, map[string]any{"token": token, "name": name, "vault": c.tok.Vault})
}

// How long a deleted file stays recoverable before the server erases it.
//
// Unlike the key parameters this is meant to change: somebody deciding they want a
// longer safety net, or a shorter one, is an ordinary thing to want.

const defaultRetentionDays = 30

func retentionOf(files *store.Store) int {
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

func (s *Server) getRetention(w http.ResponseWriter, r *http.Request, c ctx) {
	writeJSON(w, http.StatusOK, map[string]any{"days": retentionOf(c.files)})
}

func (s *Server) putRetention(w http.ResponseWriter, r *http.Request, c ctx) {
	var req struct {
		Days int `json:"days"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.Days < 0 || req.Days > 3650 {
		writeErr(w, http.StatusBadRequest, "bad_request", "days must be between 0 and 3650")
		return
	}
	if err := c.files.PutMeta("retention_days", strconv.Itoa(req.Days)); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"days": req.Days})
}

// What is gone but not lost. The history was always there and reachable by revision
// number; this is what makes it something a person can act on rather than something
// a person could theoretically curl.
func (s *Server) deleted(w http.ResponseWriter, r *http.Request, c ctx) {
	limit, err := intParam(r, "limit", 200)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "limit: "+err.Error())
		return
	}
	list, err := c.files.DeletedFiles(int(limit))
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"entries": list})
}

func (s *Server) getFile(w http.ResponseWriter, r *http.Request, c ctx) {
	p, err := pathParam(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_path", err.Error())
		return
	}
	f, err := c.files.Get(p)
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "not_found", "no such path in vault")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}

	hash, rev := f.Hash, f.Rev
	if q := r.URL.Query().Get("rev"); q != "" {
		want, err := strconv.ParseInt(q, 10, 64)
		if err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", "rev: "+err.Error())
			return
		}
		hash, err = c.files.RevisionHash(p, want)
		if err != nil {
			writeErr(w, http.StatusNotFound, "not_found", "no such revision (or it is a tombstone)")
			return
		}
		rev = want
	} else if f.Deleted {
		writeErr(w, http.StatusGone, "deleted", "file is deleted; request an explicit rev to read history")
		return
	} else if f.Folder {
		writeErr(w, http.StatusNoContent, "folder", "path is a folder")
		return
	}

	rc, err := c.blobs.Open(hash)
	if err != nil {
		s.logger().Error("blob missing", "vault", c.tok.Vault, "path", p, "hash", hash)
		writeErr(w, http.StatusInternalServerError, "blob_missing", "content for this revision is gone")
		return
	}
	defer rc.Close()

	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("ETag", `"`+hash+`"`)
	w.Header().Set("X-Rev", strconv.FormatInt(rev, 10))
	w.Header().Set("X-Mtime", strconv.FormatInt(f.Mtime, 10))
	// ServeContent handles Range and If-None-Match itself — resumable downloads for free.
	http.ServeContent(w, r, "", time.Time{}, rc)
}

func (s *Server) putFile(w http.ResponseWriter, r *http.Request, c ctx) {
	if from, busy := encryptingElsewhere(r, c); busy {
		writeEncrypting(w, from)
		return
	}
	p, err := pathParam(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_path", err.Error())
		return
	}
	baseRev, err := headerInt(r, "X-Base-Rev", 0)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "X-Base-Rev: "+err.Error())
		return
	}
	mtime, err := headerInt(r, "X-Mtime", time.Now().UnixMilli())
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "X-Mtime: "+err.Error())
		return
	}
	folder := r.Header.Get("X-Folder") == "1"

	// The body is written to a blob BEFORE the transaction: content is addressed by
	// hash, so a stray blob left by a conflict is harmless and gets collected later.
	var hash string
	var size int64
	if folder {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
	} else {
		hash, size, err = c.blobs.Put(r.Body, s.MaxUpload)
		if err != nil {
			writeErr(w, http.StatusRequestEntityTooLarge, "too_large", err.Error())
			return
		}
	}

	f, err := c.files.Put(store.PutArgs{
		Path: p, BaseRev: baseRev, Hash: hash, Size: size, Mtime: mtime,
		Folder: folder, UpdatedBy: device(r, c.tok.Name),
	})
	var conflict *store.ConflictError
	if errors.As(err, &conflict) {
		writeConflict(w, conflict)
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, fileResp(f))
}

func (s *Server) deleteFile(w http.ResponseWriter, r *http.Request, c ctx) {
	if from, busy := encryptingElsewhere(r, c); busy {
		writeEncrypting(w, from)
		return
	}
	p, err := pathParam(r)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_path", err.Error())
		return
	}
	baseRev, err := headerInt(r, "X-Base-Rev", 0)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", "X-Base-Rev: "+err.Error())
		return
	}
	f, err := c.files.Delete(p, baseRev, device(r, c.tok.Name))
	var conflict *store.ConflictError
	switch {
	case errors.As(err, &conflict):
		writeConflict(w, conflict)
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "no such path in vault")
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	default:
		writeJSON(w, http.StatusOK, fileResp(f))
	}
}

type renameReq struct {
	From    string `json:"from"`
	To      string `json:"to"`
	BaseRev int64  `json:"base_rev"`
}

func (s *Server) rename(w http.ResponseWriter, r *http.Request, c ctx) {
	if from, busy := encryptingElsewhere(r, c); busy {
		writeEncrypting(w, from)
		return
	}
	var req renameReq
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	from, err := checkPath(req.From)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_path", "from: "+err.Error())
		return
	}
	to, err := checkPath(req.To)
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_path", "to: "+err.Error())
		return
	}
	f, err := c.files.Rename(from, to, req.BaseRev, device(r, c.tok.Name))
	var conflict *store.ConflictError
	switch {
	case errors.As(err, &conflict):
		writeConflict(w, conflict)
	case errors.Is(err, store.ErrNotFound):
		writeErr(w, http.StatusNotFound, "not_found", "source path is missing or deleted")
	case err != nil:
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
	default:
		writeJSON(w, http.StatusOK, fileResp(f))
	}
}

// The key derivation parameters live on the server so a second device can join the
// vault knowing only the passphrase. They are opaque to the server, which holds no
// key material and cannot read anything even with them in hand.
//
// They are write-once. Changing them without re-encrypting every file would turn the
// whole vault into unreadable bytes, so the server refuses rather than allowing it.

func (s *Server) getVaultKey(w http.ResponseWriter, r *http.Request, c ctx) {
	value, err := c.files.GetMeta("vaultkey")
	if errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusNotFound, "not_set", "this vault has no key parameters yet")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	// While the vault is being re-uploaded encrypted, every reader of the key
	// record learns it in the same request, so no device acts on a half-encrypted
	// vault by reading one thing and not the other.
	if raw, err := c.files.GetMeta("encrypting"); err == nil {
		var record, marker map[string]any
		if json.Unmarshal([]byte(value), &record) == nil && json.Unmarshal([]byte(raw), &marker) == nil {
			// Whether the caller is the device doing it. Decided here, because only
			// the server knows the name it filed the marker under.
			marker["mine"] = marker["device"] == device(r, c.tok.Name)
			record["migration"] = marker
			writeJSON(w, http.StatusOK, record)
			return
		}
	}
	_, _ = io.WriteString(w, value)
}

// The migration marker: which device is turning encryption on for a vault that
// already holds readable files, and since when. It is set before the first
// encrypted upload and removed after the last readable copy is gone, so a device
// that reads the key record in between knows to wait rather than join.
//
// It can be rewritten, unlike the key parameters: an interrupted migration may be
// finished from another device that holds every file, and that device takes it over.

func (s *Server) putMigration(w http.ResponseWriter, r *http.Request, c ctx) {
	if _, err := c.files.GetMeta("vaultkey"); errors.Is(err, store.ErrNotFound) {
		writeErr(w, http.StatusConflict, "no_key", "set the vault key parameters first")
		return
	}
	// The device is taken from the request, not the body: it has to be the same
	// name the write handlers will compare against, and they only see requests.
	marker, err := json.Marshal(map[string]any{
		"device":  device(r, c.tok.Name),
		"started": time.Now().UnixMilli(),
	})
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	if err := c.files.PutMeta("encrypting", string(marker)); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// encryptingElsewhere says whether a write has to wait: the vault is being
// re-uploaded encrypted from another device, and a readable write landing now
// would be erased with the rest of the readable copies, or survive them and leave
// the vault half hidden. Either is worse than a short wait.
func encryptingElsewhere(r *http.Request, c ctx) (string, bool) {
	raw, err := c.files.GetMeta("encrypting")
	if err != nil {
		return "", false
	}
	var m struct {
		Device string `json:"device"`
	}
	if json.Unmarshal([]byte(raw), &m) != nil || m.Device == device(r, c.tok.Name) {
		return "", false
	}
	return m.Device, true
}

func writeEncrypting(w http.ResponseWriter, from string) {
	writeErr(w, http.StatusLocked, "encrypting",
		fmt.Sprintf("encryption is being turned on from %s; writes resume when it is done", from))
}

func (s *Server) clearMigration(w http.ResponseWriter, r *http.Request, c ctx) {
	if err := c.files.DeleteMeta("encrypting"); err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// purgeDeleted erases every deleted file now, content included, instead of at the
// end of the retention window.
//
// The one caller is the encryption migration, for which the deleted files are the
// readable copies of everything. It is a real erasure and it is the client's to
// ask for; the server does it in one place so that no device has to walk the list.
func (s *Server) purgeDeleted(w http.ResponseWriter, r *http.Request, c ctx) {
	s.mu.Lock()
	defer s.mu.Unlock()
	files, err := c.files.ForgetAllDeleted()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	live, err := c.files.LiveHashes()
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	swept, err := c.blobs.Sweep(live, false)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.logger().Info("erased deleted files on request",
		"vault", c.tok.Vault, "files", files, "bytes", swept.Bytes)
	writeJSON(w, http.StatusOK, map[string]any{"files": files, "bytes": swept.Bytes})
}

func (s *Server) putVaultKey(w http.ResponseWriter, r *http.Request, c ctx) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<10))
	if err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if !json.Valid(body) {
		writeErr(w, http.StatusBadRequest, "bad_request", "expected a JSON object")
		return
	}
	switch err := c.files.SetMeta("vaultkey", string(body)); {
	case errors.Is(err, store.ErrMetaExists):
		writeErr(w, http.StatusConflict, "already_set",
			"this vault already has key parameters; changing them would make every file unreadable")
	case err != nil:
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]any{"ok": true})
	}
}

// --- helpers ------------------------------------------------------------------

func intParam(r *http.Request, name string, def int64) (int64, error) {
	q := r.URL.Query().Get(name)
	if q == "" {
		return def, nil
	}
	v, err := strconv.ParseInt(q, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("expected an integer, got %q", q)
	}
	if v < 0 {
		return 0, errors.New("must not be negative")
	}
	return v, nil
}

func headerInt(r *http.Request, name string, def int64) (int64, error) {
	q := r.Header.Get(name)
	if q == "" {
		return def, nil
	}
	v, err := strconv.ParseInt(q, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("expected an integer, got %q", q)
	}
	if v < 0 {
		return 0, errors.New("must not be negative")
	}
	return v, nil
}
