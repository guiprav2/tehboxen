# unzip for Tehboxen

Info-ZIP UnZip 6.0 as Debian ships it (orig tarball + Debian's patch series — CVE fixes,
Unicode names — both pinned by sha256 in `VERSION`), for wasm32-wasip1. Base system
(`baked: true`): `unzip`, `zipinfo` (→ unzip), `funzip`. Busybox's unzip applet is disabled.
No bzip2-compressed entries (no libbz2).

    sh ports/unzip/fetch.sh && sh ports/unzip/build.sh && sh ports/unzip/package.sh

`patches/0001-wasi.patch`: `unix/unxcfg.h` includes `<utime.h>` on WASI (upstream only does
for a list of known Unixes).
