#!/bin/sh
# Recreate our nmap tree: the release tarball (VERSION: version + sha256), current
# config.sub/config.guess (the bundled ones predate wasm32), patches/*.patch.
. "$(dirname "$0")/../env.sh"
SRC=$WORK/nmap
read VER SHA < "$PORTS/nmap/VERSION"
TBZ=$WORK/nmap-$VER.tar.bz2
[ -f "$TBZ" ] || curl -fL -o "$TBZ" "https://nmap.org/dist/nmap-$VER.tar.bz2"
echo "$SHA  $TBZ" | sha256sum -c - >/dev/null || { echo "nmap-$VER.tar.bz2: checksum mismatch" >&2; exit 1; }
rm -rf "$SRC"
mkdir -p "$SRC"
tar xjf "$TBZ" -C "$SRC" --strip-components=1
cd "$SRC"
git init -q && git add -A && git -c user.name=ports -c user.email=ports@localhost commit -qm "nmap $VER"
for f in $(find . -name config.sub); do cp /usr/share/misc/config.sub "$f"; done
for f in $(find . -name config.guess); do cp /usr/share/misc/config.guess "$f"; done
for p in "$PORTS"/nmap/patches/*.patch; do git apply "$p"; done
