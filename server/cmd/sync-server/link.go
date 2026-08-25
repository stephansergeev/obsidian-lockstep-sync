// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"strings"
)

// link mints a token and prints the setup link that carries it, for a screen that
// was lost or a device that was added later from the server side.
//
// The link is the same one the plugin makes for further devices, so there is one
// way in rather than two. Tokens are never stored in the clear, so this cannot show
// an old link; it always issues a new token, which is the safer answer anyway.
func link(args []string) error {
	fs := flag.NewFlagSet("link", flag.ExitOnError)
	data := dataDir(fs)
	vaultName := fs.String("vault", "main", "vault name")
	name := fs.String("name", "", "device name (required)")
	base := fs.String("url", "", "public address of this server, e.g. https://sync.example.com (required)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *name == "" || *base == "" {
		return errors.New("--name and --url are required")
	}
	if !strings.HasPrefix(*base, "https://") && !strings.HasPrefix(*base, "http://") {
		return errors.New("--url must start with https:// (or http:// on a private network)")
	}

	st, err := openAuth(*data)
	if err != nil {
		return err
	}
	defer st.Close()
	tok, err := st.Add(*name, *vaultName)
	if err != nil {
		return err
	}

	q := url.Values{}
	q.Set("url", strings.TrimRight(*base, "/"))
	q.Set("token", tok)
	q.Set("device", *name)
	fmt.Printf("obsidian://lockstep-setup?%s\n", q.Encode())
	return nil
}
