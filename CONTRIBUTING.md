# Contributing

## The one rule

Every change that touches sync has to come with the scenario it protects. This project
makes a single promise, that no version of anybody's text disappears quietly, and the tests
are how that promise is kept rather than asserted.

## Running everything

```bash
make server                        # the binary the integration tests need
cd server && go test -race ./...   # data loss scenarios against a real server
cd plugin && npm ci && npm test    # merge, encryption, and two devices end to end
```

The plugin tests spin up a real server and drive the real engine against it with two vaults
on disk. Only Obsidian itself is stubbed.

## Where things live

`server/` is Go with no cgo. `plugin/` is TypeScript bundled by esbuild. `spec/` describes
the protocol and the reasoning behind the decisions; if a change alters behaviour described
there, change that too. `ops/` is deployment.

## Style

Comments explain why, not what. The interesting comments in this codebase are the ones that
say what breaks if the code is written the obvious way instead.

English everywhere: interface strings, README, commit messages, comments. Translations are
added to `plugin/src/i18n.ts`, where English is the fallback for every missing key.

Commit messages describe the change and its reason in prose. No trailers.
