// SPDX-License-Identifier: MIT

package api_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/api"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/auth"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/vault"
)

// Every scenario below checks exactly one invariant:
// NO VERSION OF THE TEXT DISAPPEARED QUIETLY.
// The numbering matches the list in spec section 9.

// --- harness ----------------------------------------------------------------

type harness struct {
	t   *testing.T
	srv *httptest.Server
	// two devices means two tokens, as in real life
	deskTok, phoneTok string
}

func newHarness(t *testing.T) *harness {
	t.Helper()
	dir := t.TempDir()
	tokens, err := auth.Open(dir + "/server.db")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tokens.Close() })
	desk, err := tokens.Add("desk-01", "main")
	if err != nil {
		t.Fatal(err)
	}
	phone, err := tokens.Add("phone-01", "main")
	if err != nil {
		t.Fatal(err)
	}
	reg := vault.NewRegistry(dir)
	t.Cleanup(reg.Close)

	s := &api.Server{Auth: tokens, Vaults: reg, MaxUpload: 64 << 20}
	srv := httptest.NewServer(s.Handler())
	t.Cleanup(srv.Close)
	return &harness{t: t, srv: srv, deskTok: desk, phoneTok: phone}
}

type putResult struct {
	Status     int
	Rev        int64  `json:"rev"`
	Seq        int64  `json:"seq"`
	Hash       string `json:"hash"`
	Deleted    bool   `json:"deleted"`
	Error      string `json:"error"`
	ServerRev  int64  `json:"server_rev"`
	ServerHash string `json:"server_hash"`
	UpdatedBy  string `json:"updated_by"`
}

func (h *harness) do(tok, method, url string, body io.Reader, hdr map[string]string) (*http.Response, []byte) {
	h.t.Helper()
	req, err := http.NewRequest(method, h.srv.URL+url, body)
	if err != nil {
		h.t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp, data
}

// put mimics a client writing a file: base_rev is what the client based it on.
func (h *harness) put(tok, path string, baseRev int64, content string, extra ...map[string]string) putResult {
	h.t.Helper()
	hdr := map[string]string{"X-Base-Rev": strconv.FormatInt(baseRev, 10), "X-Mtime": "1755600000000"}
	for _, e := range extra {
		for k, v := range e {
			hdr[k] = v
		}
	}
	resp, data := h.do(tok, http.MethodPut, "/v1/file?path="+esc(path), strings.NewReader(content), hdr)
	var out putResult
	_ = json.Unmarshal(data, &out)
	out.Status = resp.StatusCode
	return out
}

func (h *harness) del(tok, path string, baseRev int64) putResult {
	h.t.Helper()
	resp, data := h.do(tok, http.MethodDelete, "/v1/file?path="+esc(path),
		nil, map[string]string{"X-Base-Rev": strconv.FormatInt(baseRev, 10)})
	var out putResult
	_ = json.Unmarshal(data, &out)
	out.Status = resp.StatusCode
	return out
}

func (h *harness) rename(tok, from, to string, baseRev int64) putResult {
	h.t.Helper()
	body, _ := json.Marshal(map[string]any{"from": from, "to": to, "base_rev": baseRev})
	resp, data := h.do(tok, http.MethodPost, "/v1/rename", bytes.NewReader(body), nil)
	var out putResult
	_ = json.Unmarshal(data, &out)
	out.Status = resp.StatusCode
	return out
}

// get reads content; rev < 0 means the latest revision.
func (h *harness) get(tok, path string, rev int64) (int, string) {
	h.t.Helper()
	u := "/v1/file?path=" + esc(path)
	if rev >= 0 {
		u += "&rev=" + strconv.FormatInt(rev, 10)
	}
	resp, data := h.do(tok, http.MethodGet, u, nil, nil)
	return resp.StatusCode, string(data)
}

type changesResp struct {
	Entries []struct {
		Path        string `json:"path"`
		Rev         int64  `json:"rev"`
		Seq         int64  `json:"seq"`
		Hash        string `json:"hash"`
		Deleted     bool   `json:"deleted"`
		UpdatedBy   string `json:"updated_by"`
		RenamedFrom string `json:"renamed_from"`
	} `json:"entries"`
	NextSeq int64 `json:"next_seq"`
	HasMore bool  `json:"has_more"`
}

func (h *harness) changes(tok string, since int64) changesResp {
	h.t.Helper()
	_, data := h.do(tok, http.MethodGet, "/v1/changes?since="+strconv.FormatInt(since, 10), nil, nil)
	var out changesResp
	if err := json.Unmarshal(data, &out); err != nil {
		h.t.Fatalf("changes: %v (%s)", err, data)
	}
	return out
}

func esc(p string) string { return strings.ReplaceAll(urlEscape(p), "+", "%20") }

func urlEscape(p string) string {
	var b strings.Builder
	for _, c := range []byte(p) {
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '/' {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

func sha(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])
}

// --- scenarios --------------------------------------------------------------

// 1. The same file edited from both sides at once.
// Invariant: the server version is not clobbered and the client gets everything it
// needs for a 3-way merge.
func TestScenario01_ConcurrentEdit(t *testing.T) {
	h := newHarness(t)
	base := h.put(h.deskTok, "Notes/Yerevan.md", 0, "common ancestor")
	if base.Status != 200 || base.Rev != 1 {
		t.Fatalf("base put: %+v", base)
	}

	desk := h.put(h.deskTok, "Notes/Yerevan.md", 1, "edit from the desktop")
	if desk.Status != 200 || desk.Rev != 2 {
		t.Fatalf("desk put: %+v", desk)
	}

	phone := h.put(h.phoneTok, "Notes/Yerevan.md", 1, "edit from the phone")
	if phone.Status != http.StatusConflict {
		t.Fatalf("the phone should have got a 409, got %+v", phone)
	}
	if phone.ServerRev != 2 || phone.ServerHash != sha("edit from the desktop") {
		t.Fatalf("a 409 must carry the server revision and hash: %+v", phone)
	}
	// The client names the other side when it asks a person which version stands,
	// so the conflict has to say which device wrote what is on the server.
	if phone.UpdatedBy != "desk-01" {
		t.Fatalf("a 409 must name the device that wrote the server revision: %+v", phone)
	}

	// The client must be able to fetch both the common ancestor and the server version.
	if code, body := h.get(h.phoneTok, "Notes/Yerevan.md", 1); code != 200 || body != "common ancestor" {
		t.Fatalf("ancestor unreachable: %d %q", code, body)
	}
	if code, body := h.get(h.phoneTok, "Notes/Yerevan.md", -1); code != 200 || body != "edit from the desktop" {
		t.Fatalf("server version unreachable: %d %q", code, body)
	}

	// The merge goes back to the server based on the current revision.
	merged := h.put(h.phoneTok, "Notes/Yerevan.md", 2, "edit from the desktop + edit from the phone")
	if merged.Status != 200 || merged.Rev != 3 {
		t.Fatalf("merge put: %+v", merged)
	}
}

// 2. Deletion on A against an edit on B. The edit must win and the file must come back.
func TestScenario02_DeleteVsEdit(t *testing.T) {
	h := newHarness(t)
	h.put(h.deskTok, "note.md", 0, "text")

	if d := h.del(h.deskTok, "note.md", 1); d.Status != 200 || d.Rev != 2 || !d.Deleted {
		t.Fatalf("delete: %+v", d)
	}
	// The content of a deleted file stays reachable by revision number.
	if code, body := h.get(h.phoneTok, "note.md", 1); code != 200 || body != "text" {
		t.Fatalf("a deleted file lost its history: %d %q", code, body)
	}
	if code, _ := h.get(h.phoneTok, "note.md", -1); code != http.StatusGone {
		t.Fatalf("a deleted file should answer 410, answered %d", code)
	}

	// The phone edited the file without knowing about the deletion.
	stale := h.put(h.phoneTok, "note.md", 1, "text + edit")
	if stale.Status != http.StatusConflict || !stale.Deleted {
		t.Fatalf("expected a 409 flagged as deleted: %+v", stale)
	}
	// The edit beats the deletion.
	revived := h.put(h.phoneTok, "note.md", 2, "text + edit")
	if revived.Status != 200 || revived.Rev != 3 {
		t.Fatalf("the file did not come back: %+v", revived)
	}
	if code, body := h.get(h.deskTok, "note.md", -1); code != 200 || body != "text + edit" {
		t.Fatalf("after resurrection: %d %q", code, body)
	}
}

// 3. A rename on A against an edit on B.
// Invariant: on the other device this does NOT look like a deletion, because
// renamed_from is there.
func TestScenario03_RenameVsEdit(t *testing.T) {
	h := newHarness(t)
	h.put(h.deskTok, "old name.md", 0, "body")

	r := h.rename(h.deskTok, "old name.md", "new name.md", 1)
	if r.Status != 200 {
		t.Fatalf("rename: %+v", r)
	}
	if code, body := h.get(h.phoneTok, "new name.md", -1); code != 200 || body != "body" {
		t.Fatalf("the content did not move: %d %q", code, body)
	}

	ch := h.changes(h.phoneTok, 0)
	var sawRename bool
	for _, e := range ch.Entries {
		if e.Path == "new name.md" && e.RenamedFrom == "old name.md" {
			sawRename = true
		}
	}
	if !sawRename {
		t.Fatalf("the log carries no rename marker: %+v", ch.Entries)
	}

	// An edit on the old path from a stale base must hit a conflict.
	if stale := h.put(h.phoneTok, "old name.md", 1, "blind edit"); stale.Status != http.StatusConflict {
		t.Fatalf("expected a 409 on the old path: %+v", stale)
	}
	// Moving onto an occupied path is a conflict too, not a quiet overwrite.
	h.put(h.deskTok, "taken.md", 0, "someone else's text")
	if r2 := h.rename(h.deskTok, "new name.md", "taken.md", 1); r2.Status != http.StatusConflict {
		t.Fatalf("moving onto an occupied path must conflict: %+v", r2)
	}
	if code, body := h.get(h.deskTok, "taken.md", -1); code != 200 || body != "someone else's text" {
		t.Fatalf("someone else's text was clobbered by a rename: %d %q", code, body)
	}
}

// 4/5. A connection dropped mid-transfer, and a client killed between writing a file
// and updating its index.
// Invariant: retrying any request is idempotent and creates no extra revisions.
func TestScenario04_05_RetryIsIdempotent(t *testing.T) {
	h := newHarness(t)
	first := h.put(h.deskTok, "note.md", 0, "content")
	repeat := h.put(h.deskTok, "note.md", 0, "content") // the client never wrote its index
	if repeat.Status != 200 || repeat.Rev != first.Rev || repeat.Seq != first.Seq {
		t.Fatalf("the retry created a new revision: first=%+v repeat=%+v", first, repeat)
	}
	// And seq must not advance for nothing, or other clients wake up for an empty delta.
	if ch := h.changes(h.phoneTok, 0); len(ch.Entries) != 1 {
		t.Fatalf("the log should hold one entry, not %d", len(ch.Entries))
	}
	// A repeated deletion is a no-op too.
	d1 := h.del(h.deskTok, "note.md", 1)
	d2 := h.del(h.deskTok, "note.md", 1)
	if d2.Status != 200 || d2.Rev != d1.Rev {
		t.Fatalf("repeated deletion is not idempotent: %+v / %+v", d1, d2)
	}
}

// 6. A rename that only changes letter case.
func TestScenario06_CaseOnlyRename(t *testing.T) {
	h := newHarness(t)
	h.put(h.deskTok, "note.md", 0, "body")
	if r := h.rename(h.deskTok, "note.md", "Note.md", 1); r.Status != 200 {
		t.Fatalf("case-only rename: %+v", r)
	}
	if code, body := h.get(h.phoneTok, "Note.md", -1); code != 200 || body != "body" {
		t.Fatalf("Note.md: %d %q", code, body)
	}
	if code, _ := h.get(h.phoneTok, "note.md", -1); code != http.StatusGone {
		t.Fatalf("the old path should become a tombstone, got %d", code)
	}
}

// 7. Unicode in a path: NFC against NFD.
// Invariant: the server refuses to split one visually identical path into two files.
func TestScenario07_UnicodeNFD(t *testing.T) {
	h := newHarness(t)
	// "cafe" plus U+0301 (combining acute) looks exactly like "café" but is the NFD
	// form. This is how macOS hands out non-ASCII filenames, and it is why the same
	// visible name can arrive as two different paths from two devices.
	const nfd = "Notes/cafe\u0301.md"
	res := h.put(h.deskTok, nfd, 0, "body")
	if res.Status != http.StatusBadRequest {
		t.Fatalf("an NFD path must be rejected, got %+v", res)
	}
	// The normalised form is accepted.
	if ok := h.put(h.deskTok, "Notes/caf\u00e9.md", 0, "body"); ok.Status != 200 {
		t.Fatalf("an NFC path was rejected: %+v", ok)
	}
	// Non-Latin scripts have to survive the round trip untouched. A vault is just as
	// likely to be written in Cyrillic, Japanese or Greek as in English.
	for _, path := range []string{"\u0417\u0430\u043c\u0435\u0442\u043a\u0438/\u0415\u0440\u0435\u0432\u0430\u043d.md", "\u30ce\u30fc\u30c8/\u6771\u4eac.md", "\u03a3\u03b7\u03bc\u03b5\u03b9\u03ce\u03c3\u03b5\u03b9\u03c2/\u0391\u03b8\u03ae\u03bd\u03b1.md"} {
		if res := h.put(h.deskTok, path, 0, "body"); res.Status != 200 {
			t.Fatalf("path %q was rejected: %+v", path, res)
		}
		if code, body := h.get(h.phoneTok, path, -1); code != 200 || body != "body" {
			t.Fatalf("path %q did not survive the round trip: %d %q", path, code, body)
		}
	}
}

// 8. A large file: streamed upload and a resumable Range download.
func TestScenario08_LargeFileAndRange(t *testing.T) {
	if testing.Short() {
		t.Skip("-short")
	}
	h := newHarness(t)
	big := strings.Repeat("boat", 2<<20) // about 8 MB
	if res := h.put(h.deskTok, "attach/big.bin", 0, big); res.Status != 200 || res.Hash != sha(big) {
		t.Fatalf("large file: %+v", res)
	}
	req, _ := http.NewRequest(http.MethodGet, h.srv.URL+"/v1/file?path=attach/big.bin", nil)
	req.Header.Set("Authorization", "Bearer "+h.phoneTok)
	req.Header.Set("Range", "bytes=0-99")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		t.Fatalf("range requests are not supported: %d", resp.StatusCode)
	}
	data, _ := io.ReadAll(resp.Body)
	if len(data) != 100 || !strings.HasPrefix(big, string(data)) {
		t.Fatalf("Range returned the wrong slice: %d bytes", len(data))
	}
}

// 9. The client clock runs ahead.
// Invariant: ordering comes from seq and rev, not mtime. Otherwise a file "from the
// future" would win every comparison forever.
func TestScenario09_ClockSkew(t *testing.T) {
	h := newHarness(t)
	h.put(h.phoneTok, "note.md", 0, "from the future", map[string]string{"X-Mtime": "4102444800000"}) // year 2100
	res := h.put(h.deskTok, "note.md", 1, "from the present", map[string]string{"X-Mtime": "1755600000000"})
	if res.Status != 200 || res.Rev != 2 {
		t.Fatalf("a normal edit lost to a skewed clock: %+v", res)
	}
	if code, body := h.get(h.phoneTok, "note.md", -1); code != 200 || body != "from the present" {
		t.Fatalf("the current version is not the latest revision: %d %q", code, body)
	}
}

// 10. Two clients create the same path from nothing.
func TestScenario10_ConcurrentCreate(t *testing.T) {
	h := newHarness(t)
	a := h.put(h.deskTok, "new.md", 0, "version A")
	b := h.put(h.phoneTok, "new.md", 0, "version B")
	if a.Status != 200 {
		t.Fatalf("first writer: %+v", a)
	}
	if b.Status != http.StatusConflict || b.ServerHash != sha("version A") {
		t.Fatalf("the second must get a 409 carrying the other hash: %+v", b)
	}
	if code, body := h.get(h.deskTok, "new.md", -1); code != 200 || body != "version A" {
		t.Fatalf("version A was lost: %d %q", code, body)
	}
}

// --- protocol ---------------------------------------------------------------

func TestChangesCursor(t *testing.T) {
	h := newHarness(t)
	h.put(h.deskTok, "a.md", 0, "1")
	h.put(h.deskTok, "b.md", 0, "2")

	ch := h.changes(h.phoneTok, 0)
	if len(ch.Entries) != 2 || ch.NextSeq != 2 || ch.HasMore {
		t.Fatalf("first delta: %+v", ch)
	}
	// An empty delta must not move the cursor backwards.
	if empty := h.changes(h.phoneTok, ch.NextSeq); len(empty.Entries) != 0 || empty.NextSeq != 2 {
		t.Fatalf("empty delta: %+v", empty)
	}
	h.put(h.deskTok, "a.md", 1, "1+")
	tail := h.changes(h.phoneTok, ch.NextSeq)
	if len(tail.Entries) != 1 || tail.Entries[0].Path != "a.md" || tail.Entries[0].Rev != 2 {
		t.Fatalf("delta tail: %+v", tail.Entries)
	}
	if tail.Entries[0].UpdatedBy != "desk-01" {
		t.Fatalf("the log carries no author: %+v", tail.Entries[0])
	}
}

func TestAuthRequired(t *testing.T) {
	h := newHarness(t)
	for _, tok := range []string{"", "obs_no-such-token"} {
		resp, _ := h.do(tok, http.MethodGet, "/v1/changes?since=0", nil, nil)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("token %q returned %d", tok, resp.StatusCode)
		}
	}
	resp, _ := h.do("", http.MethodGet, "/v1/health", nil, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("health must not require a token: %d", resp.StatusCode)
	}
}

func TestPathTraversalRejected(t *testing.T) {
	h := newHarness(t)
	for _, p := range []string{"../escape.md", "/absolute.md", "a//b.md", "a/./b.md", `c:\win.md`, "", "trailing .", "trailing "} {
		if res := h.put(h.deskTok, p, 0, "x"); res.Status != http.StatusBadRequest {
			t.Fatalf("path %q was let through with status %d", p, res.Status)
		}
	}
}

func TestVaultIsolation(t *testing.T) {
	dir := t.TempDir()
	tokens, err := auth.Open(dir + "/server.db")
	if err != nil {
		t.Fatal(err)
	}
	defer tokens.Close()
	work, _ := tokens.Add("work", "work-vault")
	personal, _ := tokens.Add("personal", "personal-vault")
	reg := vault.NewRegistry(dir)
	defer reg.Close()
	srv := httptest.NewServer((&api.Server{Auth: tokens, Vaults: reg}).Handler())
	defer srv.Close()
	h := &harness{t: t, srv: srv, deskTok: work, phoneTok: personal}

	h.put(work, "secret.md", 0, "work stuff")
	if code, _ := h.get(personal, "secret.md", -1); code != http.StatusNotFound {
		t.Fatalf("vaults are not isolated: %d", code)
	}
}
