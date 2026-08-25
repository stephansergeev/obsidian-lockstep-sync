.PHONY: all server plugin release test fmt clean cross

all: server plugin

server:
	cd server && go build -o ../bin/sync-server ./cmd/sync-server

# Builds for a server: linux/amd64 and linux/arm64, static, no cgo.
cross:
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../bin/sync-server-linux-amd64 ./cmd/sync-server
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../bin/sync-server-linux-arm64 ./cmd/sync-server

# The plugin lives in the repository root, where Obsidian, BRAT and the catalogue
# look for manifest.json and main.js.
plugin:
	npm run build

# Release assets: these three files are what BRAT and the catalogue expect.
release: plugin
	@echo "ready to release: main.js manifest.json styles.css versions.json"

test:
	cd server && go test ./...
	npm run check

fmt:
	cd server && gofmt -w .

clean:
	rm -rf bin main.js
