// SPDX-License-Identifier: MIT

// Package api — HTTP-поверхность сервера.
//
// Контракт целиком описан в /spec. Ключевое: клиент никогда не обходит дерево,
// он читает дельту по глобальному seq и отталкивается от base_rev при каждой записи.
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

// Vaults — реестр открытых волтов. Один волт = своя SQLite-база и свой blob-каталог,
// поэтому мультиволт не тащит в схему vault_id и не создаёт мультитенантности.
type Vaults interface {
	Get(name string) (*store.Store, *blob.Store, error)
}

type Server struct {
	Auth      *auth.Store
	Vaults    Vaults
	MaxUpload int64 // 0 — без лимита
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

// --- пути -------------------------------------------------------------------

// checkPath — единственное место, где решается, что вообще может стать путём в волте.
//
// NFC обязателен: macOS отдаёт NFD, и если пустить оба варианта, кириллица и умляуты
// разъедутся между устройствами на два разных файла с одинаковым видом.
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

// --- ответы -----------------------------------------------------------------

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, kind, msg string) {
	writeJSON(w, code, map[string]string{"error": kind, "message": msg})
}

// writeConflict отдаёт клиенту всё, что нужно, чтобы уйти в 3-way merge:
// текущую серверную ревизию и её хеш.
func writeConflict(w http.ResponseWriter, c *store.ConflictError) {
	writeJSON(w, http.StatusConflict, map[string]any{
		"error":       "conflict",
		"path":        c.Path,
		"server_rev":  c.ServerRev,
		"server_hash": c.ServerHash,
		"deleted":     c.Deleted,
	})
}

func fileResp(f store.File) map[string]any {
	return map[string]any{"rev": f.Rev, "seq": f.Seq, "hash": f.Hash, "path": f.Path, "deleted": f.Deleted}
}

// --- ручки ------------------------------------------------------------------

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
	// ServeContent сам разбирает Range и If-None-Match — докачка достаётся даром.
	http.ServeContent(w, r, "", time.Time{}, rc)
}

func (s *Server) putFile(w http.ResponseWriter, r *http.Request, c ctx) {
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

	// Тело пишем в blob ДО транзакции: содержимое адресуется по хешу, поэтому
	// лишний blob при конфликте безвреден и подберётся сборщиком мусора.
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
		Folder: folder, UpdatedBy: c.tok.Name,
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
	f, err := c.files.Delete(p, baseRev, c.tok.Name)
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
	f, err := c.files.Rename(from, to, req.BaseRev, c.tok.Name)
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

// --- мелочи -----------------------------------------------------------------

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
