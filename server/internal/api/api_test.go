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

// Каждый сценарий ниже проверяет ровно один инвариант:
// НИ ОДНА ВЕРСИЯ ТЕКСТА НЕ ИСЧЕЗЛА МОЛЧА.
// Нумерация совпадает со списком в spec §9.

// --- харнесс ----------------------------------------------------------------

type harness struct {
	t   *testing.T
	srv *httptest.Server
	// два устройства = два токена, как в жизни
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

// put имитирует запись файла клиентом: base_rev — то, от чего клиент оттолкнулся.
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

// get читает содержимое; rev < 0 означает «последнюю».
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

// --- сценарии ---------------------------------------------------------------

// 1. Правка одного файла с двух сторон одновременно.
// Инвариант: серверная версия не затирается, клиент получает всё для 3-way merge.
func TestScenario01_ConcurrentEdit(t *testing.T) {
	h := newHarness(t)
	base := h.put(h.deskTok, "Заметки/Ереван.md", 0, "общий предок")
	if base.Status != 200 || base.Rev != 1 {
		t.Fatalf("base put: %+v", base)
	}

	desk := h.put(h.deskTok, "Заметки/Ереван.md", 1, "правка с десктопа")
	if desk.Status != 200 || desk.Rev != 2 {
		t.Fatalf("desk put: %+v", desk)
	}

	phone := h.put(h.phoneTok, "Заметки/Ереван.md", 1, "правка с телефона")
	if phone.Status != http.StatusConflict {
		t.Fatalf("телефон должен был получить 409, получил %+v", phone)
	}
	if phone.ServerRev != 2 || phone.ServerHash != sha("правка с десктопа") {
		t.Fatalf("409 обязан нести серверную ревизию и хеш: %+v", phone)
	}

	// Клиент обязан суметь достать и общего предка, и серверную версию.
	if code, body := h.get(h.phoneTok, "Заметки/Ереван.md", 1); code != 200 || body != "общий предок" {
		t.Fatalf("предок недоступен: %d %q", code, body)
	}
	if code, body := h.get(h.phoneTok, "Заметки/Ереван.md", -1); code != 200 || body != "правка с десктопа" {
		t.Fatalf("серверная версия недоступна: %d %q", code, body)
	}

	// Слияние уходит на сервер уже от актуальной базы.
	merged := h.put(h.phoneTok, "Заметки/Ереван.md", 2, "правка с десктопа + правка с телефона")
	if merged.Status != 200 || merged.Rev != 3 {
		t.Fatalf("merge put: %+v", merged)
	}
}

// 2. Удаление на A против правки на B. Правка обязана победить, файл — воскреснуть.
func TestScenario02_DeleteVsEdit(t *testing.T) {
	h := newHarness(t)
	h.put(h.deskTok, "note.md", 0, "текст")

	if d := h.del(h.deskTok, "note.md", 1); d.Status != 200 || d.Rev != 2 || !d.Deleted {
		t.Fatalf("delete: %+v", d)
	}
	// Содержимое удалённого файла остаётся доступным по номеру ревизии.
	if code, body := h.get(h.phoneTok, "note.md", 1); code != 200 || body != "текст" {
		t.Fatalf("удалённый файл потерял историю: %d %q", code, body)
	}
	if code, _ := h.get(h.phoneTok, "note.md", -1); code != http.StatusGone {
		t.Fatalf("удалённый файл должен отдавать 410, отдал %d", code)
	}

	// Телефон правил файл, не зная об удалении.
	stale := h.put(h.phoneTok, "note.md", 1, "текст + правка")
	if stale.Status != http.StatusConflict || !stale.Deleted {
		t.Fatalf("ожидался 409 с признаком удаления: %+v", stale)
	}
	// Правка побеждает удаление.
	revived := h.put(h.phoneTok, "note.md", 2, "текст + правка")
	if revived.Status != 200 || revived.Rev != 3 {
		t.Fatalf("файл не воскрес: %+v", revived)
	}
	if code, body := h.get(h.deskTok, "note.md", -1); code != 200 || body != "текст + правка" {
		t.Fatalf("после воскрешения: %d %q", code, body)
	}
}

// 3. Переименование на A против правки на B.
// Инвариант: на другом устройстве это НЕ выглядит удалением — есть renamed_from.
func TestScenario03_RenameVsEdit(t *testing.T) {
	h := newHarness(t)
	h.put(h.deskTok, "старое имя.md", 0, "тело")

	r := h.rename(h.deskTok, "старое имя.md", "новое имя.md", 1)
	if r.Status != 200 {
		t.Fatalf("rename: %+v", r)
	}
	if code, body := h.get(h.phoneTok, "новое имя.md", -1); code != 200 || body != "тело" {
		t.Fatalf("содержимое не переехало: %d %q", code, body)
	}

	ch := h.changes(h.phoneTok, 0)
	var sawRename bool
	for _, e := range ch.Entries {
		if e.Path == "новое имя.md" && e.RenamedFrom == "старое имя.md" {
			sawRename = true
		}
	}
	if !sawRename {
		t.Fatalf("в логе нет признака переименования: %+v", ch.Entries)
	}

	// Правка по старому пути от устаревшей базы обязана упереться в конфликт.
	if stale := h.put(h.phoneTok, "старое имя.md", 1, "правка вслепую"); stale.Status != http.StatusConflict {
		t.Fatalf("ожидался 409 по старому пути: %+v", stale)
	}
	// Переезд на занятый путь тоже конфликт, а не тихая перезапись.
	h.put(h.deskTok, "занято.md", 0, "чужой текст")
	if r2 := h.rename(h.deskTok, "новое имя.md", "занято.md", 1); r2.Status != http.StatusConflict {
		t.Fatalf("переезд на занятый путь должен конфликтовать: %+v", r2)
	}
	if code, body := h.get(h.deskTok, "занято.md", -1); code != 200 || body != "чужой текст" {
		t.Fatalf("чужой текст затёрт переименованием: %d %q", code, body)
	}
}

// 4/5. Обрыв на середине и убийство клиента между записью и обновлением индекса.
// Инвариант: повтор любого запроса идемпотентен и не плодит ревизии.
func TestScenario04_05_RetryIsIdempotent(t *testing.T) {
	h := newHarness(t)
	first := h.put(h.deskTok, "note.md", 0, "содержимое")
	repeat := h.put(h.deskTok, "note.md", 0, "содержимое") // клиент не успел записать индекс
	if repeat.Status != 200 || repeat.Rev != first.Rev || repeat.Seq != first.Seq {
		t.Fatalf("повтор создал новую ревизию: first=%+v repeat=%+v", first, repeat)
	}
	// И seq не должен уезжать вхолостую — иначе другие клиенты будут дёргаться на пустоту.
	if ch := h.changes(h.phoneTok, 0); len(ch.Entries) != 1 {
		t.Fatalf("в логе должна быть одна запись, а не %d", len(ch.Entries))
	}
	// Повторное удаление — тоже no-op.
	d1 := h.del(h.deskTok, "note.md", 1)
	d2 := h.del(h.deskTok, "note.md", 1)
	if d2.Status != 200 || d2.Rev != d1.Rev {
		t.Fatalf("повторное удаление не идемпотентно: %+v / %+v", d1, d2)
	}
}

// 6. Переименование, отличающееся только регистром.
func TestScenario06_CaseOnlyRename(t *testing.T) {
	h := newHarness(t)
	h.put(h.deskTok, "note.md", 0, "тело")
	if r := h.rename(h.deskTok, "note.md", "Note.md", 1); r.Status != 200 {
		t.Fatalf("rename по регистру: %+v", r)
	}
	if code, body := h.get(h.phoneTok, "Note.md", -1); code != 200 || body != "тело" {
		t.Fatalf("Note.md: %d %q", code, body)
	}
	if code, _ := h.get(h.phoneTok, "note.md", -1); code != http.StatusGone {
		t.Fatalf("старый путь должен стать tombstone, получили %d", code)
	}
}

// 7. Юникод в пути: NFC против NFD.
// Инвариант: сервер не даёт развести один и тот же на вид путь на два файла.
func TestScenario07_UnicodeNFD(t *testing.T) {
	h := newHarness(t)
	// «и» + U+0306 (комбинирующая бревис) визуально даёт «й», но это NFD-форма:
	// именно так macOS отдаёт русские имена файлов.
	const nfd = "Заметки/И\u0306ога.md"
	res := h.put(h.deskTok, nfd, 0, "тело")
	if res.Status != http.StatusBadRequest {
		t.Fatalf("NFD-путь должен отвергаться, получили %+v", res)
	}
	// Нормализованный вариант принимается.
	if ok := h.put(h.deskTok, "Заметки/Йога.md", 0, "тело"); ok.Status != 200 {
		t.Fatalf("NFC-путь отвергнут: %+v", ok)
	}
}

// 8. Большой файл: запись стримом и докачка по Range.
func TestScenario08_LargeFileAndRange(t *testing.T) {
	if testing.Short() {
		t.Skip("-short")
	}
	h := newHarness(t)
	big := strings.Repeat("яхта", 2<<20) // ~16 МБ в utf-8
	if res := h.put(h.deskTok, "attach/big.bin", 0, big); res.Status != 200 || res.Hash != sha(big) {
		t.Fatalf("большой файл: %+v", res)
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
		t.Fatalf("докачка не поддержана: %d", resp.StatusCode)
	}
	data, _ := io.ReadAll(resp.Body)
	if len(data) != 100 || !strings.HasPrefix(big, string(data)) {
		t.Fatalf("Range отдал не тот кусок: %d байт", len(data))
	}
}

// 9. Часы клиента ушли вперёд.
// Инвариант: порядок определяется seq/rev, а не mtime — иначе «файл из будущего»
// навсегда выигрывал бы все сравнения.
func TestScenario09_ClockSkew(t *testing.T) {
	h := newHarness(t)
	h.put(h.phoneTok, "note.md", 0, "из будущего", map[string]string{"X-Mtime": "4102444800000"}) // 2100 год
	res := h.put(h.deskTok, "note.md", 1, "из настоящего", map[string]string{"X-Mtime": "1755600000000"})
	if res.Status != 200 || res.Rev != 2 {
		t.Fatalf("нормальная правка проиграла кривым часам: %+v", res)
	}
	if code, body := h.get(h.phoneTok, "note.md", -1); code != 200 || body != "из настоящего" {
		t.Fatalf("актуальной стала не последняя ревизия: %d %q", code, body)
	}
}

// 10. Два клиента создают файл с одним путём с нуля.
func TestScenario10_ConcurrentCreate(t *testing.T) {
	h := newHarness(t)
	a := h.put(h.deskTok, "новый.md", 0, "вариант A")
	b := h.put(h.phoneTok, "новый.md", 0, "вариант B")
	if a.Status != 200 {
		t.Fatalf("первый создатель: %+v", a)
	}
	if b.Status != http.StatusConflict || b.ServerHash != sha("вариант A") {
		t.Fatalf("второй должен получить 409 с чужим хешем: %+v", b)
	}
	if code, body := h.get(h.deskTok, "новый.md", -1); code != 200 || body != "вариант A" {
		t.Fatalf("вариант A потерян: %d %q", code, body)
	}
}

// --- протокол ---------------------------------------------------------------

func TestChangesCursor(t *testing.T) {
	h := newHarness(t)
	h.put(h.deskTok, "a.md", 0, "1")
	h.put(h.deskTok, "b.md", 0, "2")

	ch := h.changes(h.phoneTok, 0)
	if len(ch.Entries) != 2 || ch.NextSeq != 2 || ch.HasMore {
		t.Fatalf("первая дельта: %+v", ch)
	}
	// Пустая дельта не должна откатывать курсор назад.
	if empty := h.changes(h.phoneTok, ch.NextSeq); len(empty.Entries) != 0 || empty.NextSeq != 2 {
		t.Fatalf("пустая дельта: %+v", empty)
	}
	h.put(h.deskTok, "a.md", 1, "1+")
	tail := h.changes(h.phoneTok, ch.NextSeq)
	if len(tail.Entries) != 1 || tail.Entries[0].Path != "a.md" || tail.Entries[0].Rev != 2 {
		t.Fatalf("хвост дельты: %+v", tail.Entries)
	}
	if tail.Entries[0].UpdatedBy != "desk-01" {
		t.Fatalf("в логе нет автора изменения: %+v", tail.Entries[0])
	}
}

func TestAuthRequired(t *testing.T) {
	h := newHarness(t)
	for _, tok := range []string{"", "obs_нет-такого"} {
		resp, _ := h.do(tok, http.MethodGet, "/v1/changes?since=0", nil, nil)
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("токен %q дал %d", tok, resp.StatusCode)
		}
	}
	resp, _ := h.do("", http.MethodGet, "/v1/health", nil, nil)
	if resp.StatusCode != 200 {
		t.Fatalf("health не должен требовать токена: %d", resp.StatusCode)
	}
}

func TestPathTraversalRejected(t *testing.T) {
	h := newHarness(t)
	for _, p := range []string{"../побег.md", "/абсолютный.md", "a//b.md", "a/./b.md", `c:\win.md`, "", "trailing .", "trailing "} {
		if res := h.put(h.deskTok, p, 0, "x"); res.Status != http.StatusBadRequest {
			t.Fatalf("путь %q пропущен со статусом %d", p, res.Status)
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

	h.put(work, "секрет.md", 0, "рабочее")
	if code, _ := h.get(personal, "секрет.md", -1); code != http.StatusNotFound {
		t.Fatalf("волты не изолированы: %d", code)
	}
}
