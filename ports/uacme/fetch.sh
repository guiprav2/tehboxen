#!/bin/sh
# Recreate our uacme tree: the v<version> tag tarball from GitHub (VERSION: version + sha256)
# + patches/*.patch.
. "$(dirname "$0")/../env.sh"
SRC=$WORK/uacme
read VER SHA < "$PORTS/uacme/VERSION"
TGZ=$WORK/uacme-$VER.tar.gz
[ -f "$TGZ" ] || curl -sSfL -o "$TGZ" "https://github.com/ndilieto/uacme/archive/refs/tags/v$VER.tar.gz"
echo "$SHA  $TGZ" | sha256sum -c - >/dev/null || { echo "uacme-$VER.tar.gz: checksum mismatch" >&2; exit 1; }
rm -rf "$SRC"
mkdir -p "$SRC"
tar xzf "$TGZ" -C "$SRC" --strip-components=1
cd "$SRC"
git init -q && git add -A && git -c user.name=ports -c user.email=ports@localhost commit -qm "uacme $VER"
for p in "$PORTS"/uacme/patches/*.patch; do git apply "$p"; done
