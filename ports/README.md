# ports: Tehboxen's WASI apps and toolchain pieces, built on the host

Each directory is a recipe: pinned upstream source (when there is one), our
patches as plain diffs, and scripts that rebuild the artifacts the box
fetches from `toolchain/`. Upstream trees aren't vendored: `fetch.sh`
recreates our patched fork from the pinned commit + `patches/`.

| port | builds | used by |
| --- | --- | --- |
| `libtehboxen/` | `toolchain/libtehboxen/lib/*/libtehboxen.a` (headers live next to them) | every in-box clang link; vim |
| `wasi-threads-sysroot/` | `toolchain/wasi-threads-sysroot-34.tgz` | `clang -pthread` |
| `vim/` | `toolchain/vim/vim-9.2-wasm32-wasip1.tgz` | the `vim` system package (other/packages.js) |
| `busybox/` | `toolchain/busybox/busybox-1.37.0-wasm32-wasip1.tgz` | base system (baked): coreutils-ish applets, tar, net tools |
| `xz/` | `toolchain/xz/xz-5.8.4-wasm32-wasip1.tgz` | base system (baked): xz/unxz/xzcat/lzma, `tar cJf` |
| `zip/`, `unzip/` | `toolchain/{zip,unzip}/…-wasm32-wasip1.tgz` | base system (baked): Info-ZIP, Debian-patched (`infozip-*.sh`) |
| `nmap/` | `toolchain/nmap/nmap-7.993-wasm32-wasip1.tgz` | the `nmap` package (`sudo pkg install nmap`) |

```sh
sh ports/build-all.sh                 # everything (fetches wasi-sdk into .ports-work/)
sh ports/vim/fetch.sh                 # recreate the vim fork in .ports-work/vim
# … edit .ports-work/vim …
sh ports/vim/diff.sh                  # save the edits back as patches/0001-wasi.patch
sh ports/vim/build.sh && sh ports/vim/package.sh
```

`env.sh` sets `WORK` (default `.ports-work/`, gitignored) and `WASI_SDK`
(wasi-sdk 34, fetched by `wasi-sdk.sh`); override either from the
environment. It also exports `TB_LDFLAGS` (libtehboxen's `--wrap` list and init export:
every port links with it, as does the in-box clang) and `CONFIG_SITE=config.site`
(autoconf answers for functions libtehboxen adds, which its link probes can't see). After repackaging a system package, bump its `version` in
`other/packages.js` so existing boxes reinstall it.

## Smoke tests

`sh ports/test.sh [port]` runs each built port's binary on the host (Node's WASI,
`test/run-wasi.mjs` standing in for the `tehboxen.*` imports) and checks the output;
`build-all.sh` ends with it. Networking, terminals and `dup`-dependent paths are
browser-only (verify with the Playwright harness).

## Keeping patches reliable

Each port pins one upstream version (a commit, or a release tarball + sha256) and
applies its `patches/*.patch` with `git apply`, which refuses on any mismatch. To
upgrade: bump the pin, run `fetch.sh`, refresh whatever no longer applies, rebuild,
`test.sh`. POSIX gaps go into libtehboxen, not into port patches.
