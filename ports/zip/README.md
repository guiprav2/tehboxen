# zip for Tehboxen

Info-ZIP Zip 3.0 as Debian ships it (orig tarball + Debian's patch series, both pinned by
sha256 in `VERSION`), for wasm32-wasip1. Base system (`baked: true`): `zip`, `zipcloak`,
`zipnote`, `zipsplit`. Built straight from `unix/Makefile` with explicit feature defines
(its configure runs test programs, impossible when cross-compiling). No bzip2 method.

    sh ports/zip/fetch.sh && sh ports/zip/build.sh && sh ports/zip/package.sh

No Tehboxen patches needed. Shared scripts: ports/infozip-{fetch,env,package}.sh.
