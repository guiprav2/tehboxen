#!/bin/sh
# Package OpenSSL as toolchain/openssl/openssl-<version>-wasm32-wasip1.tgz (after build.sh):
# /usr/bin/openssl, /etc/ssl/openssl.cnf, an empty /etc/ssl/certs (the world's CA certificates are
# provisioned per box from the world seed, never baked into the package). Bump the version in
# other/packages.js afterwards.
. "$(dirname "$0")/../env.sh"
set -e
read VER SHA < "$PORTS/openssl/VERSION"
SRC=$WORK/openssl
B=$WORK/openssl-bundle
rm -rf "$B"
mkdir -p "$B/package/usr/bin" "$B/package/etc/ssl/certs" "$B/package/etc/ssl/private" "$B/package/usr/share/doc/openssl"
"$WASI_SDK/bin/llvm-strip" -o "$B/package/usr/bin/openssl" "$SRC/apps/openssl"
chmod 755 "$B/package/usr/bin/openssl"
cp "$SRC/apps/openssl.cnf" "$B/package/etc/ssl/openssl.cnf"
cp "$SRC/LICENSE.txt" "$B/package/usr/share/doc/openssl/LICENSE.txt"
chmod 644 "$B/package/etc/ssl/openssl.cnf" "$B/package/usr/share/doc/openssl/LICENSE.txt"
touch "$B/package/etc/ssl/private/.keep"
# One trust bundle: the world provisions certs/ca-certificates.crt; cert.pem is OpenSSL's default.
ln -s certs/ca-certificates.crt "$B/package/etc/ssl/cert.pem"
touch "$B/package/etc/ssl/certs/.keep"
mkdir -p "$TEHBOXEN/toolchain/openssl"
cd "$B"
tar czf "$TEHBOXEN/toolchain/openssl/openssl-$VER-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
ls -la "$TEHBOXEN/toolchain/openssl/openssl-$VER-wasm32-wasip1.tgz"
