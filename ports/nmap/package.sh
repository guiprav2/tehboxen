#!/bin/sh
# Package nmap as toolchain/nmap/nmap-<version>-wasm32-wasip1.tgz (after build.sh): /usr/local/bin/nmap
# and its data (services, OS and service fingerprints, MAC prefixes, payloads, NSE scripts
# and libraries) in /usr/local/share/nmap. Bump the version in other/packages.js afterwards.
. "$(dirname "$0")/../env.sh"
read VER SHA < "$PORTS/nmap/VERSION"
SRC=$WORK/nmap
B=$WORK/nmap-bundle
D=$B/package/usr/local/share/nmap
rm -rf "$B"
mkdir -p "$B/package/usr/local/bin" "$D"
"$WASI_SDK/bin/llvm-strip" -o "$B/package/usr/local/bin/nmap" "$SRC/nmap"
chmod 755 "$B/package/usr/local/bin/nmap"
for f in nmap-services nmap-protocols nmap-rpc nmap-os-db nmap-service-probes nmap-mac-prefixes nse_main.lua; do cp "$SRC/$f" "$D/"; done
[ -f "$SRC/nmap-payloads" ] && cp "$SRC/nmap-payloads" "$D/"
cp -r "$SRC/scripts" "$SRC/nselib" "$D/"
cp "$SRC/LICENSE" "$D/LICENSE"
find "$D" -type f -exec chmod 644 {} +
mkdir -p "$TEHBOXEN/toolchain/nmap"
cd "$B"
tar czf "$TEHBOXEN/toolchain/nmap/nmap-$VER-wasm32-wasip1.tgz" --owner=0 --group=0 --sort=name package
ls -la "$TEHBOXEN/toolchain/nmap/nmap-$VER-wasm32-wasip1.tgz"
tar tzf "$TEHBOXEN/toolchain/nmap/nmap-$VER-wasm32-wasip1.tgz" | wc -l
