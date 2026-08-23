.PHONY: all server plugin release test fmt clean cross

all: server plugin

server:
	cd server && go build -o ../bin/sync-server ./cmd/sync-server

# Сборка под VPS: linux/amd64 и linux/arm64, статически, без cgo.
cross:
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags="-s -w" -o ../bin/sync-server-linux-amd64 ./cmd/sync-server
	cd server && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags="-s -w" -o ../bin/sync-server-linux-arm64 ./cmd/sync-server

# Obsidian и BRAT ищут manifest.json и main.js в КОРНЕ репозитория,
# поэтому после сборки артефакты раскладываются наверх.
plugin:
	cd plugin && npm run build
	cp plugin/main.js plugin/manifest.json plugin/versions.json .

# Ассеты релиза: ровно эти три файла ждёт BRAT и каталог сообщества.
release: plugin
	@echo "готово к релизу: main.js manifest.json versions.json"

test:
	cd server && go test ./...
	cd plugin && npm run check

fmt:
	cd server && gofmt -w .

clean:
	rm -rf bin plugin/main.js main.js
