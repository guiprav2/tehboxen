#!/bin/sh
# Recreate our curl tree: the release tarball (VERSION: version + sha256; signed by Daniel
# Stenberg, https://daniel.haxx.se/mykey.asc) + patches/*.patch (none so far).
. "$(dirname "$0")/../env.sh"
SRC=$WORK/curl
read VER SHA < "$PORTS/curl/VERSION"
TXZ=$WORK/curl-$VER.tar.xz
[ -f "$TXZ" ] || curl -sSfL -o "$TXZ" "https://github.com/curl/curl/releases/download/curl-$(echo "$VER" | tr . _)/curl-$VER.tar.xz"
echo "$SHA  $TXZ" | sha256sum -c - >/dev/null || { echo "curl-$VER.tar.xz: checksum mismatch" >&2; exit 1; }
rm -rf "$SRC"
mkdir -p "$SRC"
tar xJf "$TXZ" -C "$SRC" --strip-components=1
cd "$SRC"
git init -q && git add -A && git -c user.name=ports -c user.email=ports@localhost commit -qm "curl $VER"
for p in "$PORTS"/curl/patches/*.patch; do [ -s "$p" ] && git apply "$p"; done
true
