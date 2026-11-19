#!/bin/sh
# Shared by zip/package.sh and unzip/package.sh: toolchain/<port>/<port>-<ver>-wasm32-wasip1.tgz
# with the given programs in /usr/bin (+ symlinks "name=target") and the Info-ZIP license.
# Usage: infozip-package.sh zip|unzip prog… [link=target…]
. "$(dirname "$0")/env.sh"
set -e
N=$1
shift
read VER SHA < "$PORTS/$N/VERSION"
SRC=$WORK/$N
B=$WORK/$N-bundle
rm -rf "$B"
mkdir -p "$B/package/usr/bin" "$B/package/usr/share/doc/$N"
for a in "$@"; do
  case "$a" in
    *=*) ln -sf "${a#*=}" "$B/package/usr/bin/${a%%=*}" ;;
    *) "$WASI_SDK/bin/llvm-strip" -o "$B/package/usr/bin/$a" "$SRC/$a" && chmod 755 "$B/package/usr/bin/$a" ;;
  esac
done
cp "$SRC/LICENSE" "$B/package/usr/share/doc/$N/LICENSE"
chmod 644 "$B/package/usr/share/doc/$N/LICENSE"
mkdir -p "$TEHBOXEN/toolchain/$N"
cd "$B"
tar czf "$TEHBOXEN/toolchain/$N/$N-$VER-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
ls -la "$TEHBOXEN/toolchain/$N/$N-$VER-wasm32-wasip1.tgz"
