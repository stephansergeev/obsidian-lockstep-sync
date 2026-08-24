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

**Losing the passphrase costs the server copy, not the notes.** There is no recovery and no
escrow, and nothing derives the key but the passphrase. What that costs is precise: files on
a device are stored as ordinary files and stay readable, so every device that has the vault
keeps it. The copy on the server becomes bytes nobody can open, taking the revision history
and any future device set up from it. Recovering means starting a new vault on the server and
filling it from a device that still has the files.

**The passphrase cannot be changed on an existing vault.** Key parameters are written once,
and everything stored is sealed with what they derive. Changing them without re-encrypting
every file would leave a vault its own devices cannot read, so the server refuses the write
rather than allowing it.

**A short passphrase is warned about, not refused.** It falls to a dictionary long before
brute force becomes relevant, whatever the key derivation costs, so the guidance is four or
more unrelated words. Somebody who reads that and chooses otherwise has made a decision about
their own notes, and nothing here overrules it.

## About the QR code

Adding a device shows a QR code, and a code is unreadable by eye. Being asked to scan
something you cannot read is the shape of every phishing attempt anybody has been taught to
refuse, so the suspicion is the right instinct. Here is why this particular one is not that,
and how to check rather than take it on trust.

**It is your own screen.** This flow never asks anybody to scan a code they received from
somewhere. It is drawn by your own device, from data that device already has, for a device
you are holding.

**The same link is printed underneath it.** The code is a convenience, not a secret. Read the
link, compare it, or ignore the code entirely and copy the link instead.

**What is inside is listed beside it, in words:** the address of your server, a token minted
seconds earlier for that one device, and the name you gave it. Nothing else. Not the
passphrase, which never travels by any route, and nothing that executes.

**The receiving device says what it did.** After the link is opened it names the vault it was
configured for, so the result can be checked rather than assumed.

**A token is revocable and scoped.** If a code is ever seen by somebody it should not have
been, revoke that one device: `sync-server token revoke --name <device>`. Nothing else is
affected.

## Verifying what you downloaded

Release artefacts are built by GitHub Actions from the tagged commit, and every release
carries `SHA256SUMS`:

```bash
sha256sum -c SHA256SUMS --ignore-missing
```

Release tags are signed.
