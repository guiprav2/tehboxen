#!/bin/sh
# Recreate our busybox tree: the upstream release tarball (VERSION: version + sha256)
# + patches/*.patch, as a git checkout in $WORK/busybox.
. "$(dirname "$0")/../env.sh"
SRC=$WORK/busybox
read VER SHA < "$PORTS/busybox/VERSION"
TGZ=$WORK/busybox-$VER.tar.bz2
[ -f "$TGZ" ] || curl -fL -o "$TGZ" "https://busybox.net/downloads/busybox-$VER.tar.bz2"
echo "$SHA  $TGZ" | sha256sum -c - >/dev/null || { echo "busybox-$VER.tar.bz2: checksum mismatch" >&2; exit 1; }
rm -rf "$SRC"
mkdir -p "$SRC"
tar xjf "$TGZ" -C "$SRC" --strip-components=1
cd "$SRC"
git init -q && git add -A && git -c user.name=ports -c user.email=ports@localhost commit -qm "busybox $VER"
for p in "$PORTS"/busybox/patches/*.patch; do git apply "$p"; done
