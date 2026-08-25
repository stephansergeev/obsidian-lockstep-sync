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
