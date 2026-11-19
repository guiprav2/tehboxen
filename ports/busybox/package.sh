#!/bin/sh
# Package busybox as toolchain/busybox/busybox-<version>-wasm32-wasip1.tgz (after build.sh):
# /bin/busybox plus a symlink per applet at its usual place (busybox.links), and udhcpc's
# default script. Bump the busybox version in other/packages.js afterwards.
. "$(dirname "$0")/../env.sh"
read VER SHA < "$PORTS/busybox/VERSION"
SRC=$WORK/busybox
B=$WORK/busybox-bundle
rm -rf "$B"
mkdir -p "$B/package/bin" "$B/package/usr/share/udhcpc"
"$WASI_SDK/bin/llvm-strip" -o "$B/package/bin/busybox" "$SRC/busybox_unstripped"
chmod 755 "$B/package/bin/busybox"
while read -r path; do
  [ -n "$path" ] || continue
  dir=$(dirname "$path")
  mkdir -p "$B/package$dir"
  # Absolute targets, like `busybox --install -s`.
  [ "$path" = /bin/busybox ] || ln -sf /bin/busybox "$B/package$path"
done < "$SRC/busybox.links"
cp "$PORTS/busybox/default.script" "$B/package/usr/share/udhcpc/default.script"
chmod 755 "$B/package/usr/share/udhcpc/default.script"
mkdir -p "$TEHBOXEN/toolchain/busybox"
cd "$B"
tar czf "$TEHBOXEN/toolchain/busybox/busybox-$VER-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
ls -la "$TEHBOXEN/toolchain/busybox/busybox-$VER-wasm32-wasip1.tgz"
