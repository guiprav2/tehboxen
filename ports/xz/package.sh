#!/bin/sh
# Package xz-utils as toolchain/xz/xz-<version>-wasm32-wasip1.tgz (after build.sh): /usr/bin/xz
# plus its usual aliases (unxz, xzcat, lzma, unlzma, lzcat). Bump the version in other/packages.js.
. "$(dirname "$0")/../env.sh"
read VER SHA < "$PORTS/xz/VERSION"
SRC=$WORK/xz
B=$WORK/xz-bundle
rm -rf "$B"
mkdir -p "$B/package/usr/bin" "$B/package/usr/share/doc/xz"
"$WASI_SDK/bin/llvm-strip" -o "$B/package/usr/bin/xz" "$SRC/src/xz/xz"
chmod 755 "$B/package/usr/bin/xz"
for a in unxz xzcat lzma unlzma lzcat; do ln -sf xz "$B/package/usr/bin/$a"; done
cp "$SRC/COPYING" "$SRC/COPYING.0BSD" "$B/package/usr/share/doc/xz/"
mkdir -p "$TEHBOXEN/toolchain/xz"
cd "$B"
tar czf "$TEHBOXEN/toolchain/xz/xz-$VER-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
ls -la "$TEHBOXEN/toolchain/xz/xz-$VER-wasm32-wasip1.tgz"
