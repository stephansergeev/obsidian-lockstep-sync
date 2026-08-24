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
PROXY_DONE=0

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

# Whatever already answers on 443 keeps answering. A machine that is already
# serving something is the normal case, not the exception, and an installer that
# knocks over somebody's existing site to put up its own is not an installer.
EXISTING=""
if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ':443 '; then
	EXISTING="$(ss -tlnp 2>/dev/null | grep ':443 ' | grep -oE 'users:\(\("[^"]+' | grep -oE '"[^"]+' | tr -d '"' | head -1)"
fi

case "$EXISTING" in
	""|caddy)
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
		say "pointing $DOMAIN at the server through Caddy"
		mkdir -p /etc/caddy/conf.d
		# A named site wins over any catch-all already in the Caddyfile, so anything
		# else this machine serves keeps working.
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
		PROXY_DONE=1
		;;
	nginx)
		say "nginx already serves this machine, adding a site for $DOMAIN"
		# The certificate is obtained without letting certbot edit nginx. Its plugin
		# rewrites whatever block it finds, which turned a redirect meant for port 80
		# into a redirect served on 443, and the site answered itself forever.
		mkdir -p /var/www/html
		cat > "/etc/nginx/sites-available/lockstep-$DOMAIN" <<NGINX
server {
	listen 80;
	server_name $DOMAIN;
	location /.well-known/acme-challenge/ { root /var/www/html; }
	location / { return 301 https://\$host\$request_uri; }
}
NGINX
		ln -sf "/etc/nginx/sites-available/lockstep-$DOMAIN" "/etc/nginx/sites-enabled/lockstep-$DOMAIN"
		nginx -t >/dev/null 2>&1 && systemctl reload nginx

		command -v certbot >/dev/null 2>&1 || apt-get install -y -qq certbot >/dev/null 2>&1
		say "obtaining a certificate"
		certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
			--non-interactive --agree-tos --register-unsafely-without-email >/dev/null 2>&1 || true

		if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
			say "no certificate was issued; leaving the site on port 80 only"
			PROXY_DONE=0
		else
			# Whatever already answered on this machine keeps being the default server.
			# A named site added later must not inherit that role and start catching
			# requests meant for something else.
			for existing in /etc/nginx/sites-enabled/*; do
				case "$existing" in *"lockstep-$DOMAIN") continue ;; esac
				grep -q "default_server" "$existing" 2>/dev/null && DEFAULT_SET=1
			done
			if [ -z "${DEFAULT_SET:-}" ]; then
				for existing in /etc/nginx/sites-enabled/*; do
					case "$existing" in *"lockstep-$DOMAIN") continue ;; esac
					sed -i "s/^\(\s*\)listen 80;/\1listen 80 default_server;/; s/^\(\s*\)listen 443 ssl;/\1listen 443 ssl default_server;/" "$(readlink -f "$existing")" 2>/dev/null || true
				done
			fi

			cat > "/etc/nginx/sites-available/lockstep-$DOMAIN" <<NGINX
server {
	listen 80;
	server_name $DOMAIN;
	location /.well-known/acme-challenge/ { root /var/www/html; }
	location / { return 301 https://\$host\$request_uri; }
}

server {
	listen 443 ssl;
	server_name $DOMAIN;

	ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
	ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

	client_max_body_size 512M;

	location / {
		proxy_pass         http://127.0.0.1:$PORT;
		proxy_http_version 1.1;
		proxy_set_header   Host \$host;
		proxy_set_header   X-Real-IP \$remote_addr;
		proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
		proxy_set_header   X-Forwarded-Proto https;
		proxy_read_timeout 30m;
		proxy_send_timeout 30m;
		proxy_request_buffering off;
	}
}
NGINX
			nginx -t >/dev/null 2>&1 && systemctl reload nginx && PROXY_DONE=1
		fi
		;;
	*)
		say "$EXISTING already holds port 443, so TLS was left alone"
		cat <<MANUAL

Point $EXISTING at http://127.0.0.1:$PORT for $DOMAIN yourself, with a generous
body size limit and long timeouts. Large attachments take a while, and cutting one
off mid-transfer is the failure this project exists to prevent.

MANUAL
		PROXY_DONE=0
		;;
esac

say "issuing a token for your first device"
TOKEN="$("$BIN" token add --data "$DATA_DIR" --vault main --name "$(hostname)-first" | grep -o 'obs_[A-Za-z0-9_-]*')"
chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"

# The same link the plugin makes for later devices, so the first one is no harder
# than the rest. Opening it in Obsidian fills the settings in.
urlencode() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1],safe=""))' "$1" 2>/dev/null || echo "$1"; }
SETUP="obsidian://lockstep-setup?url=$(urlencode "https://$DOMAIN")&token=$(urlencode "$TOKEN")&device=desktop"

cat <<DONE

Done.

  Server URL   https://$DOMAIN
  Token        $TOKEN

Open this on the machine where you use Obsidian and it will set the plugin up:

  $SETUP

DONE

if command -v qrencode >/dev/null 2>&1; then
	echo "Or point a phone at this:"
	echo
	qrencode -t ANSIUTF8 -m 2 "$SETUP"
	echo
fi

cat <<DONE
Once one device is set up, the rest are added from inside Obsidian: Add another
device makes a link and a code for them, and nothing has to be typed there.

To issue a token by hand instead:

  sudo $BIN token add --data $DATA_DIR --vault main --name phone

If you already have a vault, load it in one go:

  sudo -u $USER_NAME $BIN import --data $DATA_DIR --vault main --from /path/to/vault

TLS renews itself. The server listens on loopback only and never faces the internet.
DONE
