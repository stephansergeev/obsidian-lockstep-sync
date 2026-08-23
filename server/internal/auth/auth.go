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
