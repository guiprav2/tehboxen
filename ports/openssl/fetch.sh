#!/bin/sh
# Recreate our OpenSSL tree: the release tarball (VERSION: version + sha256, as published next
# to the tarball on GitHub) + patches/*.patch (none so far: configure options suffice).
. "$(dirname "$0")/../env.sh"
SRC=$WORK/openssl
read VER SHA < "$PORTS/openssl/VERSION"
TGZ=$WORK/openssl-$VER.tar.gz
[ -f "$TGZ" ] || curl -sSfL -o "$TGZ" "https://github.com/openssl/openssl/releases/download/openssl-$VER/openssl-$VER.tar.gz"
echo "$SHA  $TGZ" | sha256sum -c - >/dev/null || { echo "openssl-$VER.tar.gz: checksum mismatch" >&2; exit 1; }
rm -rf "$SRC"
mkdir -p "$SRC"
tar xzf "$TGZ" -C "$SRC" --strip-components=1
cd "$SRC"
git init -q && git add -A && git -c user.name=ports -c user.email=ports@localhost commit -qm "openssl $VER"
for p in "$PORTS"/openssl/patches/*.patch; do [ -s "$p" ] && git apply "$p"; done
true
