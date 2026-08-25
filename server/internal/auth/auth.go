// SPDX-License-Identifier: MIT

// Package auth handles bearer tokens. One token = one device = one vault.
//
// Tokens are generated on the server and pasted into the plugin by hand: on mobile
// that is the only sane option, since OAuth there is misery.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"regexp"
	"time"

	_ "modernc.org/sqlite"
)

var ErrUnauthorized = errors.New("unauthorized")

var vaultRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

// ValidVault limits a vault name to what is safe to put in a filesystem path.
func ValidVault(v string) bool { return vaultRe.MatchString(v) && v != "." && v != ".." }

type Token struct {
	Name      string
	Vault     string
	CreatedAt time.Time
	LastSeen  time.Time
}

type Store struct{ db *sql.DB }

const schema = `
CREATE TABLE IF NOT EXISTS tokens (
  hash       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  vault      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tokens_vault ON tokens(vault);
CREATE TABLE IF NOT EXISTS join_codes (
  hash       TEXT PRIMARY KEY,
  vault      TEXT NOT NULL,
  device     TEXT NOT NULL,
  issued_by  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER NOT NULL DEFAULT 0
);
`

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func hashToken(tok string) string {
	sum := sha256.Sum256([]byte(tok))
	return hex.EncodeToString(sum[:])
}

// Add issues a new token. The plaintext value is returned exactly once — only its
// sha256 is ever stored on disk.
func (s *Store) Add(name, vault string) (string, error) {
	if !ValidVault(vault) {
		return "", fmt.Errorf("invalid vault name %q", vault)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	tok := "obs_" + base64.RawURLEncoding.EncodeToString(raw)
	_, err := s.db.Exec(`INSERT INTO tokens(hash,name,vault,created_at) VALUES(?,?,?,?)`,
		hashToken(tok), name, vault, time.Now().Unix())
	if err != nil {
		return "", err
	}
	return tok, nil
}

// Resolve validates a token and returns the vault it is bound to.
func (s *Store) Resolve(tok string) (Token, error) {
	if tok == "" {
		return Token{}, ErrUnauthorized
	}
	h := hashToken(tok)
	var t Token
	var created, seen int64
	var gotHash string
	err := s.db.QueryRow(`SELECT hash,name,vault,created_at,last_seen FROM tokens WHERE hash=?`, h).
		Scan(&gotHash, &t.Name, &t.Vault, &created, &seen)
	if errors.Is(err, sql.ErrNoRows) {
		return Token{}, ErrUnauthorized
	}
	if err != nil {
		return Token{}, err
	}
	// The comparison is constant-time even though the indexed lookup already
	// happened: keeping the habit is the only protection left if the schema changes.
	if subtle.ConstantTimeCompare([]byte(gotHash), []byte(h)) != 1 {
		return Token{}, ErrUnauthorized
	}
	t.CreatedAt = time.Unix(created, 0)
	t.LastSeen = time.Unix(seen, 0)
	_, _ = s.db.Exec(`UPDATE tokens SET last_seen=? WHERE hash=?`, time.Now().Unix(), h)
	return t, nil
}

func (s *Store) List() ([]Token, error) {
	rows, err := s.db.Query(`SELECT name,vault,created_at,last_seen FROM tokens ORDER BY created_at`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Token
	for rows.Next() {
		var t Token
		var created, seen int64
		if err := rows.Scan(&t.Name, &t.Vault, &created, &seen); err != nil {
			return nil, err
		}
		t.CreatedAt, t.LastSeen = time.Unix(created, 0), time.Unix(seen, 0)
		out = append(out, t)
	}
	return out, rows.Err()
}

// Revoke removes a token by device name.
func (s *Store) Revoke(name string) (int64, error) {
	res, err := s.db.Exec(`DELETE FROM tokens WHERE name=?`, name)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// A join code stands in for a token on the way to a new device.
//
// The setup link used to carry the token itself, so a photographed screen or a
// forwarded message was the vault. A code is short-lived and single-use, and turns
// into a token only when the other device presses Connect; the link a camera saw
// five minutes ago is by then just a picture.
type Join struct {
	Vault     string
	Device    string
	IssuedBy  string
	ExpiresAt time.Time
}

// ErrJoinInvalid covers missing, expired and already used codes alike: telling the
// three apart helps nobody who is holding the wrong link.
var ErrJoinInvalid = errors.New("join code is invalid, expired or already used")

// CreateJoin mints a code for one device. Expired codes are swept on the way, so the
// table never grows past what was issued recently.
func (s *Store) CreateJoin(vault, device, issuedBy string, ttl time.Duration) (string, error) {
	if !ValidVault(vault) {
		return "", fmt.Errorf("invalid vault name %q", vault)
	}
	raw := make([]byte, 16)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	code := base64.RawURLEncoding.EncodeToString(raw)
	now := time.Now()
	_, _ = s.db.Exec(`DELETE FROM join_codes WHERE expires_at < ? OR used_at > 0`, now.Add(-24*time.Hour).Unix())
	_, err := s.db.Exec(`INSERT INTO join_codes(hash,vault,device,issued_by,created_at,expires_at)
		VALUES(?,?,?,?,?,?)`, hashToken(code), vault, device, issuedBy, now.Unix(), now.Add(ttl).Unix())
	if err != nil {
		return "", err
	}
	return code, nil
}

// PeekJoin says what a code is for without spending it: the page that shows the
// steps needs the device name, and showing the page is not yet joining.
func (s *Store) PeekJoin(code string) (Join, error) {
	var j Join
	var expires, used int64
	err := s.db.QueryRow(`SELECT vault,device,issued_by,expires_at,used_at FROM join_codes WHERE hash=?`,
		hashToken(code)).Scan(&j.Vault, &j.Device, &j.IssuedBy, &expires, &used)
	if errors.Is(err, sql.ErrNoRows) {
		return Join{}, ErrJoinInvalid
	}
	if err != nil {
		return Join{}, err
	}
	j.ExpiresAt = time.Unix(expires, 0)
	if used > 0 || time.Now().After(j.ExpiresAt) {
		return Join{}, ErrJoinInvalid
	}
	return j, nil
}

// RedeemJoin spends a code and returns the token it stood for. The spend is one
// statement guarded by the unused-and-unexpired condition, so two devices racing
// for the same code cannot both win.
func (s *Store) RedeemJoin(code string) (string, Join, error) {
	j, err := s.PeekJoin(code)
	if err != nil {
		return "", Join{}, err
	}
	res, err := s.db.Exec(`UPDATE join_codes SET used_at=? WHERE hash=? AND used_at=0 AND expires_at>=?`,
		time.Now().Unix(), hashToken(code), time.Now().Unix())
	if err != nil {
		return "", Join{}, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return "", Join{}, ErrJoinInvalid
	}
	tok, err := s.Add(j.Device, j.Vault)
	if err != nil {
		return "", Join{}, err
	}
	return tok, j, nil
}
