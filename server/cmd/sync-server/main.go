// SPDX-License-Identifier: MIT

// Command sync-server is the whole server in one static binary.
//
//	sync-server serve            --data ./data --addr :8080
//	sync-server token add        --vault main --name iphone
//	sync-server token list
//	sync-server token revoke     --name iphone
//	sync-server stats            --vault main
//	sync-server import           --from ~/Vault --vault main
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/api"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/auth"
	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/vault"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func usage() error {
	fmt.Fprint(os.Stderr, `sync-server - self-hosted Obsidian vault sync

  serve   [--data DIR] [--addr HOST:PORT] [--max-upload BYTES]
  token   add --vault NAME --name DEVICE | list | revoke --name DEVICE
  stats   --vault NAME
  import  --from DIR [--vault NAME] [--with-config] [--dry-run]

Data directory defaults to ./data (override with LOCKSTEP_DATA).
`)
	return errors.New("no command given")
}

func dataDir(fs *flag.FlagSet) *string {
	def := os.Getenv("LOCKSTEP_DATA")
	if def == "" {
		def = "./data"
	}
	return fs.String("data", def, "server data directory")
}

func run(args []string) error {
	if len(args) == 0 {
		return usage()
	}
	switch args[0] {
	case "serve":
		return serve(args[1:])
	case "token":
		return token(args[1:])
	case "stats":
		return stats(args[1:])
	case "import":
		return importVault(args[1:])
	case "-h", "--help", "help":
		return usage()
	default:
		return fmt.Errorf("unknown command %q", args[0])
	}
}

func openAuth(dir string) (*auth.Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return auth.Open(filepath.Join(dir, "server.db"))
}

func serve(args []string) error {
	fs := flag.NewFlagSet("serve", flag.ExitOnError)
	data := dataDir(fs)
	addr := fs.String("addr", "127.0.0.1:8080", "listen address (TLS is terminated in front of this)")
	maxUpload := fs.Int64("max-upload", 512<<20, "per-file size limit in bytes; 0 means no limit")
	if err := fs.Parse(args); err != nil {
		return err
	}

	tokens, err := openAuth(*data)
	if err != nil {
		return err
	}
	defer tokens.Close()

	reg := vault.NewRegistry(*data)
	defer reg.Close()

	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	srv := &api.Server{Auth: tokens, Vaults: reg, MaxUpload: *maxUpload, Log: log}

	httpSrv := &http.Server{
		Addr:              *addr,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       90 * time.Second,
		// WriteTimeout is deliberately unset: large attachments take a long time, and
		// a cut-off mid-transfer is exactly the failure this project exists to fix.
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	errc := make(chan error, 1)
	go func() {
		log.Info("listening", "addr", *addr, "data", *data)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errc <- err
		}
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
		log.Info("shutting down")
		shutCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		return httpSrv.Shutdown(shutCtx)
	}
}

func token(args []string) error {
	if len(args) == 0 {
		return errors.New("token: expected add | list | revoke")
	}
	switch args[0] {
	case "add":
		fs := flag.NewFlagSet("token add", flag.ExitOnError)
		data := dataDir(fs)
		vaultName := fs.String("vault", "main", "vault name")
		name := fs.String("name", "", "device name (required)")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if *name == "" {
			return errors.New("--name is required")
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
		fmt.Printf("Token for %q (vault %q):\n\n  %s\n\nShown once: only its sha256 is stored on disk.\n", *name, *vaultName, tok)
		return nil

	case "list":
		fs := flag.NewFlagSet("token list", flag.ExitOnError)
		data := dataDir(fs)
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		st, err := openAuth(*data)
		if err != nil {
			return err
		}
		defer st.Close()
		toks, err := st.List()
		if err != nil {
			return err
		}
		if len(toks) == 0 {
			fmt.Println("no tokens")
			return nil
		}
		fmt.Printf("%-20s %-16s %-20s %s\n", "DEVICE", "VAULT", "CREATED", "LAST SEEN")
		for _, t := range toks {
			seen := "never"
			if t.LastSeen.Unix() > 0 {
				seen = t.LastSeen.Format(time.RFC3339)
			}
			fmt.Printf("%-20s %-16s %-20s %s\n", t.Name, t.Vault, t.CreatedAt.Format(time.RFC3339), seen)
		}
		return nil

	case "revoke":
		fs := flag.NewFlagSet("token revoke", flag.ExitOnError)
		data := dataDir(fs)
		name := fs.String("name", "", "device name")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		st, err := openAuth(*data)
		if err != nil {
			return err
		}
		defer st.Close()
		n, err := st.Revoke(*name)
		if err != nil {
			return err
		}
		fmt.Printf("tokens revoked: %d\n", n)
		return nil
	}
	return fmt.Errorf("token: unknown subcommand %q", args[0])
}

func stats(args []string) error {
	fs := flag.NewFlagSet("stats", flag.ExitOnError)
	data := dataDir(fs)
	vaultName := fs.String("vault", "main", "vault name")
	if err := fs.Parse(args); err != nil {
		return err
	}
	reg := vault.NewRegistry(*data)
	defer reg.Close()
	files, _, err := reg.Get(*vaultName)
	if err != nil {
		return err
	}
	st, err := files.Stats()
	if err != nil {
		return err
	}
	fmt.Printf("vault      %s\nfiles      %d\nfolders    %d\ndeleted    %d\nbytes      %d\nrevisions  %d\nseq        %d\n",
		*vaultName, st.Files, st.Folders, st.Deleted, st.Bytes, st.Revs, st.Seq)
	return nil
}
