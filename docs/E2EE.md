# End-to-end encryption for notes: trade-offs and a recommendation

**Status: not implemented. Waiting for the owner's decision.** Nothing in v2.0 depends on this document.

## What we have today

Notes travel over HTTPS and Supabase encrypts its disks. Row-level security stops every other *user* from
reading them. What is **not** protected against: someone with the project's database password or service-role
key (the owner, Supabase staff, or an attacker who steals those) can read every note. End-to-end encryption
(E2EE) would close that gap: notes would be encrypted in the browser with a key the server never sees.

## What it would cost

1. **A lost passphrase means the notes are gone. For ever.** There is no "forgot my passphrase": nobody,
   including the owner, can recover them. For school students this is the biggest risk by far. Mitigations
   (a printed recovery code, a key file to save) help only the students who actually keep them.
2. **Google sign-in cannot provide the key.** Signing in with Google proves who you are; it does not give the
   browser any secret that the server does not also see. So E2EE needs a **second secret** (a passphrase) on
   top of Google sign-in, typed on every new device. That undoes most of the "one tap" simplicity.
3. **Every device needs the key.** A new iPad must get it by typing the passphrase (simple, weakest), scanning
   a QR code from a device that already has it, or importing a recovery file. Changing the passphrase must
   re-wrap the key without re-encrypting every note, which means a two-level key design (below).
4. **The server goes blind.** No server-side search, no server-made thumbnails or PDFs, no content checks, no
   way to repair a damaged note, and no way to help a user who asks "can you look at what happened to my
   page?". Limits can only be enforced on size, never on content. Any future sharing or collaboration becomes
   a key-exchange problem.
5. **Sync gets cruder.** Today a page is JSON the database can validate and the image store can de-duplicate.
   Encrypted, a page is an opaque blob: every stroke re-encrypts and re-uploads the whole page (a busy page is
   1–3 MB of stroke data), images cannot be de-duplicated by content without leaking equality, and the
   database's shape checks disappear.
6. **Performance.** AES-GCM itself is fast (hundreds of MB/s with hardware support). The cost is around it:
   `JSON.stringify` + compression + encryption of a multi-megabyte page after each pause in writing, on the
   main thread unless moved to a Worker, and a deliberate 0.5–1 s key-derivation delay at each unlock.
7. **Metadata still leaks.** The server still sees who you are, how many notebooks and pages you have, their
   sizes, and when you write. Titles can be encrypted too, at the cost of sorting and searching on the server.
8. **It protects less than it sounds on the web.** The code that does the encrypting is served by the same
   site. Whoever can change the site (or a compromised host) can ship code that sends the passphrase away.
   A strict CSP and no third-party scripts, which we have, reduce this; they do not remove it.

## How it would be built (sketch only)

Everything with WebCrypto, no extra library unless Argon2 is chosen.

```
passphrase ──KDF──▶ KEK (key-encryption key, never stored)
                     │ unwraps
                     ▼
              DEK (random 256-bit AES-GCM data key, made once per account)
                     │ encrypts
                     ▼
        each page / notebook record / image, with its own random 96-bit IV
```

- **Key derivation.** `PBKDF2-HMAC-SHA-256` is built into WebCrypto: use ≥ 600,000 iterations and a random
  16-byte salt per account. **Argon2id** is stronger against GPU guessing (suggested: 64 MB memory, 3 passes)
  but needs a WASM library to be vendored and audited, and WASM needs `'wasm-unsafe-eval'` in the CSP.
- **Wrapped key on the server.** `profiles` gains `{kdf, salt, iterations, wrapped_dek, iv}`. Changing the
  passphrase re-wraps the DEK only. A recovery code is simply a second wrapped copy of the DEK under a
  random high-entropy key shown once.
- **Records.** `data` becomes `{v:1, iv, ct}` with `ct = AES-GCM(DEK, iv, gzip(JSON))` and the row's
  `owner/id/kind` as additional authenticated data, so a ciphertext cannot be moved to another row.
  `CompressionStream` shrinks stroke JSON about 4–6× before encryption.
- **Images.** Encrypted file per image; the name becomes `HMAC(DEK-derived key, bytes)` instead of a plain
  SHA-256 so equal images are still stored once per user without revealing their hash.
- **On the device.** The DEK is kept as a **non-extractable** `CryptoKey` in IndexedDB so the app opens
  offline without the passphrase; IndexedDB itself stays unencrypted (the device is trusted, as now).
- **Migration.** Opt-in per account, resumable, old rows rewritten in the background; a one-way door, since
  turning it off would mean uploading plaintext again.
- **Tests that would be needed.** Known-answer vectors, wrong-passphrase behaviour, IV uniqueness, AAD
  binding, passphrase change, recovery code, two devices, interrupted migration.

Rough size: 2–3 weeks of careful work plus review, and a permanent support burden.

## Recommendation

**Do not make E2EE the default for this audience.** For students, losing a term's notes to a forgotten
passphrase is a far more likely harm than a database breach, and v2.0 already limits the latter (private by
default, minimal data, forced row-level security, no service key in the client, UK region).

If the owner wants it, the sensible shape is an **opt-in "Private vault" setting** with: a clear warning
written for teenagers, a mandatory recovery code that must be re-typed before the feature switches on,
PBKDF2 first (no new dependency) with the KDF recorded per account so Argon2id can be adopted later, and
encryption running in a Worker.

**Decisions needed from the owner before any code is written:**

1. Is unrecoverable loss acceptable for users who forget both passphrase and recovery code?
2. Opt-in (recommended) or mandatory?
3. PBKDF2 (built in) or Argon2id (vendored WASM, CSP change)?
4. Are titles encrypted too (no server-side ordering) or left readable?
5. Is giving up future server-side features (search, sharing, thumbnails) acceptable?
