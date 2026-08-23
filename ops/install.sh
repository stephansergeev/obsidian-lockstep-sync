#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
#
# Install the Lockstep Sync server on a Debian or Ubuntu machine.
#
#   sudo ./install.sh sync.example.com
#
# It creates an unprivileged user, installs the binary, writes a systemd unit,
# points Caddy at it so TLS is obtained and renewed automatically, and prints a
# token for your first device.
#
# Running it again is safe. It updates the binary and leaves your data alone.

set -euo pipefail

DOMAIN="${1:-}"
VERSION="${LOCKSTEP_VERSION:-latest}"
REPO="stephansergeev/obsidian-lockstep-sync"
USER_NAME="lockstep"
DATA_DIR="/var/lib/lockstep"
BIN="/usr/local/bin/lockstep-sync-server"
PORT="${LOCKSTEP_PORT:-8080}"

die() { echo "error: $*" >&2; exit 1; }
say() { echo "==> $*"; }

[ "$(id -u)" -eq 0 ] || die "run this with sudo"
[ -n "$DOMAIN" ] || die "usage: sudo ./install.sh sync.example.com"

case "$(uname -m)" in
	x86_64|amd64) ARCH=amd64 ;;
	aarch64|arm64) ARCH=arm64 ;;
	*) die "unsupported architecture $(uname -m)" ;;
esac

say "downloading the server"
if [ "$VERSION" = "latest" ]; then
	URL="https://github.com/$REPO/releases/latest/download/sync-server-linux-$ARCH"
else
	URL="https://github.com/$REPO/releases/download/$VERSION/sync-server-linux-$ARCH"
fi
TMP="$(mktemp)"
curl -fsSL "$URL" -o "$TMP" || die "could not download $URL"
install -m 0755 "$TMP" "$BIN"
rm -f "$TMP"

say "creating the service user"
id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin "$USER_NAME"
mkdir -p "$DATA_DIR"
chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"
chmod 700 "$DATA_DIR"

say "writing the systemd unit"
# The server listens on loopback only. Everything about TLS and the outside world
# is Caddy's job, which is also why nothing here needs to run as root.
cat > /etc/systemd/system/lockstep-sync.service <<UNIT
[Unit]
Description=Lockstep Sync server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER_NAME
Group=$USER_NAME
ExecStart=$BIN serve --data $DATA_DIR --addr 127.0.0.1:$PORT
Restart=always
RestartSec=3

NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6
LockPersonality=yes
MemoryDenyWriteExecute=yes

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now lockstep-sync
sleep 1
systemctl is-active --quiet lockstep-sync || die "the service did not start: journalctl -u lockstep-sync"

if ! command -v caddy >/dev/null 2>&1; then
	say "installing Caddy for TLS"
	apt-get update -qq
	apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg >/dev/null
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
		| gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
	curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
		> /etc/apt/sources.list.d/caddy-stable.list
	apt-get update -qq
	apt-get install -y -qq caddy >/dev/null
fi

say "pointing $DOMAIN at the server"
mkdir -p /etc/caddy/conf.d
# A named site wins over any catch-all already in the Caddyfile, so an existing
# service on this machine keeps working.
cat > "/etc/caddy/conf.d/lockstep-$DOMAIN.caddy" <<CADDY
$DOMAIN {
	reverse_proxy 127.0.0.1:$PORT {
		transport http {
			read_timeout 30m
			write_timeout 30m
		}
	}
	request_body {
		max_size 512MB
	}
}
CADDY
grep -q "conf.d/\*.caddy" /etc/caddy/Caddyfile 2>/dev/null || echo 'import /etc/caddy/conf.d/*.caddy' >> /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

say "issuing a token for your first device"
TOKEN="$("$BIN" token add --data "$DATA_DIR" --vault main --name "$(hostname)-first" | grep -o 'obs_[A-Za-z0-9_-]*')"
chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"

cat <<DONE

Done.

  Server URL   https://$DOMAIN
  Token        $TOKEN

Put both into the plugin on your first device. For every other device, issue its
own token so you can revoke one without touching the rest:

  sudo $BIN token add --data $DATA_DIR --vault main --name iphone

If you already have a vault, load it in one go:

  sudo -u $USER_NAME $BIN import --data $DATA_DIR --vault main --from /path/to/vault

TLS is handled by Caddy and renews itself. The server itself listens on loopback
only and never sees the outside world.
DONE
