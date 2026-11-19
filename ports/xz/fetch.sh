#!/bin/sh
# Recreate our xz-utils tree: the release tarball (VERSION: version + sha256; upstream signs
# releases with Lasse Collin's key 3690C240CE51B4670D30AD1C38EE757D69184620) + patches/*.patch.
. "$(dirname "$0")/../env.sh"
SRC=$WORK/xz
read VER SHA < "$PORTS/xz/VERSION"
TGZ=$WORK/xz-$VER.tar.gz
[ -f "$TGZ" ] || curl -fL -o "$TGZ" "https://github.com/tukaani-project/xz/releases/download/v$VER/xz-$VER.tar.gz"
echo "$SHA  $TGZ" | sha256sum -c - >/dev/null || { echo "xz-$VER.tar.gz: checksum mismatch" >&2; exit 1; }
rm -rf "$SRC"
mkdir -p "$SRC"
tar xzf "$TGZ" -C "$SRC" --strip-components=1
cd "$SRC"
git init -q && git add -A && git -c user.name=ports -c user.email=ports@localhost commit -qm "xz $VER"
for p in "$PORTS"/xz/patches/*.patch; do git apply "$p"; done
