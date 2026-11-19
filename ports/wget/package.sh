#!/bin/sh
# Package GNU wget as toolchain/wget/wget-<version>-wasm32-wasip1.tgz (after build.sh):
# /usr/bin/wget and /etc/wgetrc. Bump the version in other/packages.js afterwards.
. "$(dirname "$0")/../env.sh"
set -e
read VER SHA < "$PORTS/wget/VERSION"
SRC=$WORK/wget
B=$WORK/wget-bundle
rm -rf "$B"
mkdir -p "$B/package/usr/bin" "$B/package/etc" "$B/package/usr/share/doc/wget"
"$WASI_SDK/bin/llvm-strip" -o "$B/package/usr/bin/wget" "$SRC/src/wget"
chmod 755 "$B/package/usr/bin/wget"
cp "$PORTS/wget/wgetrc" "$B/package/etc/wgetrc"
cp "$SRC/COPYING" "$B/package/usr/share/doc/wget/COPYING"
chmod 644 "$B/package/etc/wgetrc" "$B/package/usr/share/doc/wget/COPYING"
mkdir -p "$TEHBOXEN/toolchain/wget"
cd "$B"
tar czf "$TEHBOXEN/toolchain/wget/wget-$VER-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
ls -la "$TEHBOXEN/toolchain/wget/wget-$VER-wasm32-wasip1.tgz"
