# Submitting to the community catalogue

The process is no longer a pull request against `obsidianmd/obsidian-releases`. Plugins are
now submitted through the directory at **community.obsidian.md**, signed in with an Obsidian
account and with the GitHub account linked so ownership of the repository can be verified.

## What the directory reads

It reads `manifest.json` at the HEAD of the default branch, and it installs from the GitHub
release whose tag matches the `version` in that manifest. Both have to line up or the
submission fails validation.

## State of this repository

| Requirement | Here |
|---|---|
| `manifest.json` in the repository root | yes, kept in step by `make plugin` |
| `README.md` | yes |
| `LICENSE` | yes, MIT |
| Release tag equal to the manifest version | yes, every release is cut that way |
| Release assets `main.js`, `manifest.json`, `styles.css` | yes |
| `id` unique and free of the word "obsidian" | `lockstep-sync` |
| Name without the word "Obsidian" | `Lockstep Sync` |
| Description under the limit | 148 characters |
| No telemetry, no analytics, no network calls beyond the configured server | none |
| Styling in CSS rather than assigned from JavaScript | moved to `styles.css` |
| No `innerHTML`, no `as any`, no `@ts-ignore`, no stray `console.log` | verified by grep |

## What a reviewer is likely to raise

**The passphrase is stored in the plugin's settings file.** It sits in `data.json` inside the
vault, unencrypted. This is deliberate: the threat this encryption answers is the server, not
the device the vault already lives on, and asking for a passphrase on every launch mostly
teaches people to turn encryption off. It is worth saying so in the submission rather than
waiting to be asked.

**The vault adapter is used rather than the `Vault` API.** Sync has to read and write exact
paths, including files Obsidian does not track, and it needs bytes rather than strings. There
is no way to do that through the higher-level API.

## What the automated review said on 1.0.0, and what changed

Listed on 2026-08-25. The review passed with warnings, most of them one cause: the
plugin's `package.json` lived in `plugin/`, the checker installs in the root, and every
Obsidian type resolved to `any`. The plugin now lives in the root. The rest were taken
one by one: `getLanguage()` for the locale, `window.setTimeout`, the configuration folder
from `Vault#configDir`, provenance attestations on release assets. Two recommendations
stand by design: the release carries the server binaries and installer alongside the
plugin files (the installer downloads them from the same release), and the plugin lists
vault files, which is what a sync is.

## Steps

1. `make plugin` so the root artefacts match the source.
2. Bump the version in `manifest.json`, run `make plugin` again, commit.
3. Cut a release whose tag is exactly that version, attaching `main.js`, `manifest.json` and
   `styles.css`.
4. Sign in at community.obsidian.md, link the GitHub account, add the plugin.
5. If the review asks for changes, fix them and publish a new release with a higher version.
   The directory reads the manifest at HEAD, so the repository has to move with it.
