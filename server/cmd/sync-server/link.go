// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"flag"
	"fmt"
	"strings"
	"time"
)

// link makes a join link, for a screen that was lost or a device added from the
// server side.
//
// It is the same page the plugin makes for further devices, so there is one way in
// rather than two. The link carries a code, not a token: the token is issued when
// Connect is pressed on the device, and the code is worthless after that or after
// the time runs out.
func link(args []string) error {
	fs := flag.NewFlagSet("link", flag.ExitOnError)
	data := dataDir(fs)
	vaultName := fs.String("vault", "main", "vault name")
	name := fs.String("name", "", "device name (required)")
	base := fs.String("url", "", "public address of this server, e.g. https://sync.example.com (required)")
	minutes := fs.Int("minutes", 60, "how long the link stays valid")
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
	code, err := st.CreateJoin(*vaultName, *name, "cli", time.Duration(*minutes)*time.Minute)
	if err != nil {
		return err
	}
	fmt.Printf("%s/join/%s\n", strings.TrimRight(*base, "/"), code)
	return nil
}
