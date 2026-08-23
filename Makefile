.PHONY: all server plugin release test fmt clean cross

all: server plugin

server:
	cd server && go build -o ../bin/sync-server ./cmd/sync-server

# Builds for a server: linux/amd64 and linux/arm64, static, no cgo.
cross:
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../bin/sync-server-linux-amd64 ./cmd/sync-server
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../bin/sync-server-linux-arm64 ./cmd/sync-server

# Obsidian and BRAT look for manifest.json and main.js in the repository ROOT,
# so the build artefacts are copied up after the bundle is made.
plugin:
	cd plugin && npm run build
	cp plugin/main.js plugin/manifest.json plugin/versions.json .

# Release assets: these three files are what BRAT and the catalogue expect.
release: plugin
	@echo "ready to release: main.js manifest.json versions.json"

test:
	cd server && go test ./...
	cd plugin && npm run check

fmt:
	cd server && gofmt -w .

clean:
	rm -rf bin plugin/main.js main.js
