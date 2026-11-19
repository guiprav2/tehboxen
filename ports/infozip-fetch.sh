#!/bin/sh
# Shared by zip/fetch.sh and unzip/fetch.sh: Info-ZIP's last releases (2008/2009) as Debian
# packages them — the orig tarball + Debian's patch series (CVE fixes, Unicode, large files),
# both pinned by sha256 in <port>/VERSION (line 1: upstream version + orig sha256; line 2: Debian
# revision + debian.tar.xz sha256) — then our patches/*.patch. Usage: infozip-fetch.sh zip|unzip
. "$(dirname "$0")/env.sh"
N=$1
SRC=$WORK/$N
{ read VER SHA; read REV DSHA; } < "$PORTS/$N/VERSION"
POOL=https://deb.debian.org/debian/pool/main/$(printf %.1s "$N")/$N
ORIG=$WORK/${N}_$VER.orig.tar.gz
DEB=$WORK/${N}_$VER-$REV.debian.tar.xz
[ -f "$ORIG" ] || curl -fL -o "$ORIG" "$POOL/${N}_$VER.orig.tar.gz"
[ -f "$DEB" ] || curl -fL -o "$DEB" "$POOL/${N}_$VER-$REV.debian.tar.xz"
echo "$SHA  $ORIG" | sha256sum -c - >/dev/null || { echo "$ORIG: checksum mismatch" >&2; exit 1; }
echo "$DSHA  $DEB" | sha256sum -c - >/dev/null || { echo "$DEB: checksum mismatch" >&2; exit 1; }
rm -rf "$SRC"
mkdir -p "$SRC"
tar xzf "$ORIG" -C "$SRC" --strip-components=1
tar xJf "$DEB" -C "$SRC"
cd "$SRC"
grep -v '^\s*\(#\|$\)' debian/patches/series | while read -r p _; do patch -p1 -s < "debian/patches/$p" || exit 1; done
git init -q && git add -A && git -c user.name=ports -c user.email=ports@localhost commit -qm "$N $VER-$REV (Debian)"
for p in "$PORTS/$N"/patches/*.patch; do [ -s "$p" ] && git apply "$p"; done
true
