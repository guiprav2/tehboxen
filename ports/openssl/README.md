# OpenSSL for Tehboxen

OpenSSL 3.5 LTS (release tarball + sha256 in `VERSION`) for wasm32-wasip1, base system
(`baked: true`). The `openssl` CLI (keys, CSRs, CAs, `s_client`/`s_server`), and
`$WORK/openssl-root` (headers + static libcrypto/libssl) for ports that link it (wget…).

    sh ports/openssl/fetch.sh && sh ports/openssl/build.sh && sh ports/openssl/package.sh

No patches: configure options only (generic 32-bit Unix; no asm, threads, DSO, engines, QUIC,
AF_UNIX BIOs). Entropy: getentropy() → WASI random_get.

Trust: one bundle, `/etc/ssl/certs/ca-certificates.crt` (`/etc/ssl/cert.pem` → it), filled
from the world's PKI — never baked into the package.
