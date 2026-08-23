# Security

This plugin holds notes and, when encryption is on, is the only thing standing between them
and a server. Reports are welcome and taken seriously.

## Reporting a vulnerability

Open a private security advisory through GitHub:
https://github.com/stephansergeev/obsidian-lockstep-sync/security/advisories/new

Please do not open a public issue for anything that could be used against somebody's vault
before there is a fix. You will get an answer within a few days.

## What is in scope

The server, the protocol, the plugin, the encryption, and the installer. Anything that lets
somebody read, alter or destroy a vault they should not have access to, or that weakens the
encryption below what it claims.

## What the design already assumes

**The server is not trusted with content.** With encryption on it holds AES-256-GCM
ciphertext and cannot read it. It does still see file and folder names, sizes and timings.
Encrypting paths is planned and not done.

**The token is the access boundary.** Anyone holding a device token can read, write and
delete in that vault, whatever encryption is set to. Tokens are stored on the server as
sha256, shown once at issue, and revocable per device.

**Transport is the deployment's job.** The server listens on loopback and expects TLS in
front of it. Exposed over plain HTTP the token travels in the clear, and no amount of
content encryption compensates for that.

**The passphrase is stored in the plugin's settings file** inside the vault, unencrypted.
This is deliberate: the threat being answered is the server, not the device the vault
already lives on. If somebody has your laptop, they have your notes regardless.

**Losing the passphrase loses the notes.** There is no recovery and no escrow.

## Verifying what you downloaded

Release artefacts are built by GitHub Actions from the tagged commit, and every release
carries `SHA256SUMS`:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

Release tags are signed.
