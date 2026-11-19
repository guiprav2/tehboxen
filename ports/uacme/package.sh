#!/bin/sh
# Package uacme as toolchain/uacme/uacme-<version>-wasm32-wasip1.tgz (after build.sh): /usr/bin/uacme
# and its http-01 hook, /usr/share/uacme/uacme.sh. Bump the version in other/packages.js.
. "$(dirname "$0")/../env.sh"
set -e
read VER SHA < "$PORTS/uacme/VERSION"
B=$WORK/uacme-bundle
rm -rf "$B"
mkdir -p "$B/package/usr/bin" "$B/package/usr/share/uacme" "$B/package/usr/share/doc/uacme"
"$WASI_SDK/bin/llvm-strip" -o "$B/package/usr/bin/uacme" "$WORK/uacme/uacme"
cp "$WORK/uacme/uacme.sh" "$B/package/usr/share/uacme/uacme.sh"
cp "$WORK/uacme/COPYING" "$B/package/usr/share/doc/uacme/COPYING"
chmod 755 "$B/package/usr/bin/uacme" "$B/package/usr/share/uacme/uacme.sh"
chmod 644 "$B/package/usr/share/doc/uacme/COPYING"
mkdir -p "$TEHBOXEN/toolchain/uacme"
cd "$B"
tar czf "$TEHBOXEN/toolchain/uacme/uacme-$VER-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
ls -la "$TEHBOXEN/toolchain/uacme/uacme-$VER-wasm32-wasip1.tgz"
