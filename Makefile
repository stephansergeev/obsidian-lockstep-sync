.PHONY: all server plugin test fmt clean cross

all: server plugin

server:
	cd server && go build -o ../bin/sync-server ./cmd/sync-server

# Сборка под VPS: linux/amd64 и linux/arm64, статически, без cgo.
cross:
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../bin/sync-server-linux-amd64 ./cmd/sync-server
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../bin/sync-server-linux-arm64 ./cmd/sync-server

plugin:
	cd plugin && npm run build

test:
	cd server && go test ./...
	cd plugin && npm run check

fmt:
	cd server && gofmt -w .

clean:
	rm -rf bin plugin/main.js
