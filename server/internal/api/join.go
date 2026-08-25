// SPDX-License-Identifier: MIT

package api

import (
	"encoding/json"
	"errors"
	"html/template"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/stephansergeev/obsidian-lockstep-sync/server/internal/auth"
)

// The join page: the one address a new device needs.
//
// A setup link on its own does nothing on a device that has no plugin yet, and
// says nothing about what to do instead. The page puts the steps in order, with a
// button for each, and the last button is the setup link. The code in the address
// is short-lived and single-use; the token exists only after Connect is pressed.

// joinTTL is how long a link made from inside the plugin stays valid. Long enough
// to walk to the other device and install a plugin; short enough that a photograph
// of the screen is worthless by the evening.
const joinTTL = 15 * time.Minute

// Where the plugin comes from. Until the plugin is in the community catalogue it
// is installed through BRAT, which takes two taps instead of one; the catalogue
// link replaces both when the listing goes live.
const (
	pluginRepo      = "stephansergeev/obsidian-lockstep-sync"
	pluginID        = "lockstep-sync"
	inCatalogue     = false
	bratInstallLink = "obsidian://show-plugin?id=obsidian42-brat"
)

func (s *Server) createJoin(w http.ResponseWriter, r *http.Request, c ctx) {
	var req struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 64 {
		writeErr(w, http.StatusBadRequest, "bad_request", "name must be between 1 and 64 characters")
		return
	}
	code, err := s.Auth.CreateJoin(c.tok.Vault, name, c.tok.Name, joinTTL)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.logger().Info("issued a join code", "vault", c.tok.Vault, "name", name, "by", c.tok.Name)
	writeJSON(w, http.StatusOK, map[string]any{
		"code":       code,
		"url":        publicBase(r) + "/join/" + code,
		"expires_in": int(joinTTL.Seconds()),
	})
}

func (s *Server) redeemJoin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<10)).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	tok, j, err := s.Auth.RedeemJoin(strings.TrimSpace(req.Code))
	if errors.Is(err, auth.ErrJoinInvalid) {
		writeErr(w, http.StatusGone, "join_invalid", "this link has expired or was already used; make a new one from a device that is set up")
		return
	}
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "internal", err.Error())
		return
	}
	s.logger().Info("redeemed a join code", "vault", j.Vault, "name", j.Device, "issued_by", j.IssuedBy)
	writeJSON(w, http.StatusOK, map[string]any{
		"token": tok, "vault": j.Vault, "device": j.Device, "url": publicBase(r),
	})
}

func (s *Server) joinPage(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	// The browser enforces what the page promises: no request to anywhere, no
	// script or style but the inline ones below. Checkable with curl -I, or in
	// the phone's developer tools, by anyone who would rather not take our word.
	w.Header().Set("Content-Security-Policy",
		"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'")
	j, err := s.Auth.PeekJoin(code)
	if err != nil {
		w.WriteHeader(http.StatusGone)
		_ = joinTmpl.Execute(w, joinView{Expired: true})
		return
	}
	base := publicBase(r)
	q := url.Values{}
	q.Set("url", base)
	q.Set("code", code)
	q.Set("device", j.Device)
	_ = joinTmpl.Execute(w, joinView{
		Vault:       j.Vault,
		Device:      j.Device,
		Host:        r.Host,
		Minutes:     int(time.Until(j.ExpiresAt).Minutes()) + 1,
		InCatalogue: inCatalogue,
		BratLink:    template.URL(bratInstallLink),
		PluginLink:  template.URL("obsidian://brat?plugin=" + pluginRepo),
		CatalogLink: template.URL("obsidian://show-plugin?id=" + pluginID),
		ConnectLink: template.URL("obsidian://lockstep-setup?" + q.Encode()),
	})
}

// publicBase is the address the outside world reaches this server by, as the
// reverse proxy reports it. The installer's nginx sets both headers.
func publicBase(r *http.Request) string {
	scheme := r.Header.Get("X-Forwarded-Proto")
	if scheme == "" {
		if r.TLS != nil {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}
	return scheme + "://" + r.Host
}

type joinView struct {
	Expired     bool
	Vault       string
	Device      string
	Host        string
	Minutes     int
	InCatalogue bool
	// Typed as URLs on purpose: html/template rewrites an unknown scheme such as
	// obsidian:// to a dead anchor unless told the value is trusted, and these are
	// built here from constants and a code the server minted.
	BratLink    template.URL
	PluginLink  template.URL
	CatalogLink template.URL
	ConnectLink template.URL
}

// Styled after Obsidian's own default theme, both variants, so the page looks like
// the app it is about to open. No external resources: the server is the whole
// deployment, and the page must not phone anywhere else.
var joinTmpl = template.Must(template.New("join").Parse(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Lockstep Sync</title>
<style>
:root {
  --bg: #ffffff; --bg2: #f6f6f6; --border: #e0e0e0; --text: #222222; --muted: #5c5c5c;
  --accent: #7f57f1; --accent-hover: #6d47e0; --on-accent: #ffffff;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #1e1e1e; --bg2: #262626; --border: #363636; --text: #dadada; --muted: #999999;
          --accent: #8a5cf5; --accent-hover: #9b73f7; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased; }
main { max-width: 440px; margin: 0 auto; padding: 32px 20px 48px; }
h1 { font-size: 22px; font-weight: 600; margin: 0 0 4px; }
.sub { color: var(--muted); margin: 0 0 24px; }
.step { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin: 0 0 12px; }
.step h2 { font-size: 15px; font-weight: 600; margin: 0 0 6px; }
.step p { margin: 0 0 10px; color: var(--muted); font-size: 14px; }
.step p:last-child { margin-bottom: 0; }
a.btn { display: block; text-align: center; text-decoration: none; padding: 11px 16px; border-radius: 6px;
  font-weight: 500; font-size: 15px; margin-top: 8px; border: 1px solid var(--border); background: var(--bg); color: var(--text); }
a.btn.cta { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
a.btn:hover { border-color: var(--accent); }
a.btn.cta:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
a.text { color: var(--accent); text-decoration: none; }
.foot { color: var(--muted); font-size: 13px; margin-top: 20px; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
</style>
</head>
<body>
<main>
{{if .Expired}}
<h1>Lockstep Sync</h1>
<p class="sub">This link has expired or was already used.</p>
<div class="step"><p>Make a new one from a device that is already set up: Settings → Lockstep Sync → <strong>Link a new device</strong>. Each link works once and for a short while, on purpose.</p></div>
{{else}}
<h1>Lockstep Sync</h1>
<p class="sub">A step-by-step guide to installing the Lockstep plugin and syncing a vault across several devices. This device joins vault <strong>{{.Vault}}</strong> on {{.Host}} as <strong>{{.Device}}</strong>.</p>

<div class="step">
<h2>1. Create a vault</h2>
<p>Open Obsidian → <strong>Create new vault</strong> → give it a name → <strong>Create</strong>. Skip this if a vault is already open.</p>
<p id="missing" hidden>Obsidian did not open, so it may not be installed. <a class="text" id="get" href="https://obsidian.md/download">Get it here</a>, then come back to this page.</p>
</div>

<div class="step">
<h2>2. Allow community plugins</h2>
<p><strong>Settings</strong> → <strong>Community plugins</strong> → <strong>Turn on community plugins</strong>.</p>
</div>

{{if .InCatalogue}}
<div class="step">
<h2>3. Install Lockstep Sync</h2>
<p>Press <strong>Install</strong>, then <strong>Enable</strong>.</p>
<a class="btn" href="{{.CatalogLink}}">Install Lockstep Sync</a>
</div>

<div class="step">
<h2>4. Connect</h2>
<p>Fills in the server address and this device's access. If the vault is encrypted, enter its passphrase in the plugin's settings.</p>
<a class="btn cta" href="{{.ConnectLink}}">Connect</a>
</div>
{{else}}
<div class="step">
<h2>3. Install BRAT</h2>
<p>Press <strong>Install</strong>, then <strong>Enable</strong>.</p>
<a class="btn" href="{{.BratLink}}">Install BRAT</a>
</div>

<div class="step">
<h2>4. Install Lockstep Sync</h2>
<p>Press <strong>Add plugin</strong> in the window that opens.</p>
<a class="btn" href="{{.PluginLink}}">Install Lockstep Sync with BRAT</a>
</div>

<div class="step">
<h2>5. Connect</h2>
<p>Fills in the server address and this device's access. If the vault is encrypted, enter its passphrase in the plugin's settings.</p>
<a class="btn cta" href="{{.ConnectLink}}">Connect</a>
</div>
{{end}}

<p class="foot">This link works once and for about {{.Minutes}} more minutes. It carries the server address and a one-time code, nothing else.</p>
<script>
(function () {
  // A page cannot ask whether Obsidian is installed. It can notice that pressing
  // a button that should have opened it left the page in front, and only then
  // point at the store for this platform.
  var ua = navigator.userAgent || "";
  var a = document.getElementById("get");
  if (/iPhone|iPad|iPod/.test(ua)) a.href = "https://apps.apple.com/app/obsidian-connected-notes/id1557175442";
  else if (/Android/.test(ua)) a.href = "https://play.google.com/store/apps/details?id=md.obsidian";
  var left = false;
  var gone = function () { left = true; };
  document.addEventListener("visibilitychange", function () { if (document.hidden) gone(); });
  window.addEventListener("pagehide", gone);
  window.addEventListener("blur", gone);
  var buttons = document.querySelectorAll('a[href^="obsidian:"]');
  for (var i = 0; i < buttons.length; i++) {
    buttons[i].addEventListener("click", function () {
      left = false;
      setTimeout(function () {
        if (!left && !document.hidden) document.getElementById("missing").hidden = false;
      }, 1800);
    });
  }
})();
</script>
{{end}}
</main>
</body>
</html>
`))
