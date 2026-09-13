// SPDX-License-Identifier: MIT

package auth

import (
	"errors"
	"testing"
	"time"
)

func TestJoinCodeIsSingleUseAndExpires(t *testing.T) {
	st, err := Open(t.TempDir() + "/server.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	code, err := st.CreateJoin("main", "phone", "desk", 15*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if j, err := st.PeekJoin(code); err != nil || j.Device != "phone" || j.Vault != "main" {
		t.Fatalf("peek: %v %+v", err, j)
	}
	tok, j, err := st.RedeemJoin(code)
	if err != nil || j.Device != "phone" {
		t.Fatalf("redeem: %v", err)
	}
	if got, err := st.Resolve(tok); err != nil || got.Vault != "main" || got.Name != "phone" {
		t.Fatalf("the redeemed token should open the vault: %v %+v", err, got)
	}
	if _, _, err := st.RedeemJoin(code); !errors.Is(err, ErrJoinInvalid) {
		t.Fatalf("a code must not be redeemable twice, got %v", err)
	}
	if _, err := st.PeekJoin(code); !errors.Is(err, ErrJoinInvalid) {
		t.Fatalf("a spent code must not show a page, got %v", err)
	}

	stale, _ := st.CreateJoin("main", "tablet", "desk", -time.Second)
	if _, err := st.PeekJoin(stale); !errors.Is(err, ErrJoinInvalid) {
		t.Fatalf("an expired code must be refused, got %v", err)
	}
	if _, err := st.PeekJoin("not-a-code"); !errors.Is(err, ErrJoinInvalid) {
		t.Fatalf("an unknown code must be refused, got %v", err)
	}
}

func TestListAndRevokeFilterByVault(t *testing.T) {
	st, err := Open(t.TempDir() + "/server.db")
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	for _, v := range []struct{ name, vault string }{
		{"laptop", "main"}, {"phone", "main"}, {"laptop", "second"},
	} {
		if _, err := st.Add(v.name, v.vault); err != nil {
			t.Fatal(err)
		}
	}

	all, _ := st.List("")
	if len(all) != 3 {
		t.Fatalf("list all: want 3, got %d", len(all))
	}
	if only, _ := st.List("second"); len(only) != 1 || only[0].Name != "laptop" {
		t.Fatalf("list --vault second: want [laptop], got %+v", only)
	}

	// Revoking one vault's device leaves the same name in the other vault.
	if n, _ := st.Revoke("laptop", "second"); n != 1 {
		t.Fatalf("revoke laptop@second: want 1, got %d", n)
	}
	if only, _ := st.List("main"); len(only) != 2 {
		t.Fatalf("main should still have laptop and phone, got %+v", only)
	}
	// Revoking by name alone clears it from every vault.
	st.Add("laptop", "second")
	if n, _ := st.Revoke("laptop", ""); n != 2 {
		t.Fatalf("revoke laptop everywhere: want 2, got %d", n)
	}
}
