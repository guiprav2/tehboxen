#!/bin/sh
# Package curl as toolchain/curl/curl-<version>-wasm32-wasip1.tgz (after build.sh): /usr/bin/curl.
# Bump the version in other/packages.js afterwards.
. "$(dirname "$0")/../env.sh"
set -e
read VER SHA < "$PORTS/curl/VERSION"
B=$WORK/curl-bundle
rm -rf "$B"
mkdir -p "$B/package/usr/bin" "$B/package/usr/share/doc/curl"
"$WASI_SDK/bin/llvm-strip" -o "$B/package/usr/bin/curl" "$WORK/curl/src/curl"
chmod 755 "$B/package/usr/bin/curl"
cp "$WORK/curl/COPYING" "$B/package/usr/share/doc/curl/COPYING"
chmod 644 "$B/package/usr/share/doc/curl/COPYING"
mkdir -p "$TEHBOXEN/toolchain/curl"
cd "$B"
tar czf "$TEHBOXEN/toolchain/curl/curl-$VER-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
ls -la "$TEHBOXEN/toolchain/curl/curl-$VER-wasm32-wasip1.tgz"
