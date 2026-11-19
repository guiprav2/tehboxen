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

```sh
sh ports/build-all.sh                 # everything (fetches wasi-sdk into .ports-work/)
sh ports/vim/fetch.sh                 # recreate the vim fork in .ports-work/vim
# … edit .ports-work/vim …
sh ports/vim/diff.sh                  # save the edits back as patches/0001-wasi.patch
sh ports/vim/build.sh && sh ports/vim/package.sh
```

`env.sh` sets `WORK` (default `.ports-work/`, gitignored) and `WASI_SDK`
(wasi-sdk 34, fetched by `wasi-sdk.sh`); override either from the
environment. After repackaging a system package, bump its `version` in
`other/packages.js` so existing boxes reinstall it.
