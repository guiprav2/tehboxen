#!/bin/sh
# Recreate our GNU wget tree: the release tarball (VERSION: version + sha256; GNU signs it, see
# README) + patches/*.patch.
. "$(dirname "$0")/../env.sh"
SRC=$WORK/wget
read VER SHA < "$PORTS/wget/VERSION"
TGZ=$WORK/wget-$VER.tar.gz
[ -f "$TGZ" ] || curl -sSfL -o "$TGZ" "https://ftp.gnu.org/gnu/wget/wget-$VER.tar.gz"
echo "$SHA  $TGZ" | sha256sum -c - >/dev/null || { echo "wget-$VER.tar.gz: checksum mismatch" >&2; exit 1; }
rm -rf "$SRC"
mkdir -p "$SRC"
tar xzf "$TGZ" -C "$SRC" --strip-components=1
cd "$SRC"
git init -q && git add -A && git -c user.name=ports -c user.email=ports@localhost commit -qm "wget $VER"
for p in "$PORTS"/wget/patches/*.patch; do git apply "$p"; done
