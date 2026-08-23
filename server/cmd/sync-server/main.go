// SPDX-License-Identifier: MIT

// Команда sync-server — весь сервер в одном статическом бинарнике.
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
	fmt.Fprint(os.Stderr, `sync-server — self-hosted Obsidian sync

  serve   [--data DIR] [--addr HOST:PORT] [--max-upload BYTES]
  token   add --vault NAME --name DEVICE | list | revoke --name DEVICE
  stats   --vault NAME
  import  --from DIR [--vault NAME] [--with-config] [--dry-run]

Каталог данных по умолчанию: ./data (переопределяется OBSIDIAN_SYNC_DATA).
`)
	return errors.New("no command given")
}

func dataDir(fs *flag.FlagSet) *string {
	def := os.Getenv("OBSIDIAN_SYNC_DATA")
	if def == "" {
		def = "./data"
	}
	return fs.String("data", def, "каталог данных сервера")
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
	addr := fs.String("addr", "127.0.0.1:8080", "адрес прослушивания (TLS вешается снаружи)")
	maxUpload := fs.Int64("max-upload", 512<<20, "лимит на размер одного файла, байт; 0 — без лимита")
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
		// WriteTimeout намеренно не выставлен: крупные вложения качаются долго,
		// а обрыв на середине выгрузки — это ровно тот сценарий, который мы чиним.
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
		vaultName := fs.String("vault", "main", "имя волта")
		name := fs.String("name", "", "имя устройства (обязательно)")
		if err := fs.Parse(args[1:]); err != nil {
			return err
		}
		if *name == "" {
			return errors.New("--name обязателен")
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
		fmt.Printf("Токен для %q (волт %q):\n\n  %s\n\nПоказывается один раз — на диске лежит только его sha256.\n", *name, *vaultName, tok)
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
			fmt.Println("токенов нет")
			return nil
		}
		fmt.Printf("%-20s %-16s %-20s %s\n", "DEVICE", "VAULT", "CREATED", "LAST SEEN")
		for _, t := range toks {
			seen := "никогда"
			if t.LastSeen.Unix() > 0 {
				seen = t.LastSeen.Format(time.RFC3339)
			}
			fmt.Printf("%-20s %-16s %-20s %s\n", t.Name, t.Vault, t.CreatedAt.Format(time.RFC3339), seen)
		}
		return nil

	case "revoke":
		fs := flag.NewFlagSet("token revoke", flag.ExitOnError)
		data := dataDir(fs)
		name := fs.String("name", "", "имя устройства")
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
		fmt.Printf("отозвано токенов: %d\n", n)
		return nil
	}
	return fmt.Errorf("token: unknown subcommand %q", args[0])
}

func stats(args []string) error {
	fs := flag.NewFlagSet("stats", flag.ExitOnError)
	data := dataDir(fs)
	vaultName := fs.String("vault", "main", "имя волта")
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
	fmt.Printf("волт      %s\nфайлов    %d\nпапок     %d\nудалено   %d\nбайт      %d\nревизий   %d\nseq       %d\n",
		*vaultName, st.Files, st.Folders, st.Deleted, st.Bytes, st.Revs, st.Seq)
	return nil
}
