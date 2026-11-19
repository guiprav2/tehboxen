# curl for Tehboxen

curl + libcurl (release tarball + sha256 in `VERSION`; signed by Daniel Stenberg) with OpenSSL,
for wasm32-wasip1. Base system (`baked: true`). libcurl is also installed in
`$WORK/curl-root` for ports that link it (uacme).

    sh ports/openssl/build.sh   # first
    sh ports/curl/fetch.sh && sh ports/curl/build.sh && sh ports/curl/package.sh

No source patches; build.sh documents the configure/link nudges.
