#!/bin/sh
# toolchain/wasi-threads-sysroot-34.tgz: wasi-sdk 34's wasm32-wasip1-threads sysroot (wasi-libc
# with pthreads, eh/ and noeh/ libc++, libc++abi, libunwind; no LTO copies) plus its threads
# compiler-rt builtins (clang-rt/), under "package/". Repacked because GitHub release assets
# can't be fetched from the browser (no CORS). Mounted by other/node/clang.js at /opt/wasi-threads.
. "$(dirname "$0")/../env.sh"
V=${WASI_SDK_VERSION%%.*}
D=$WORK/wasi-threads-sysroot
rm -rf "$D" && mkdir -p "$D/x" "$D/pkg/package/clang-rt"
curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$V/wasi-sysroot-$WASI_SDK_VERSION.tar.gz" |
  tar xz -C "$D/x" --wildcards "wasi-sysroot-$WASI_SDK_VERSION/include/wasm32-wasip1-threads/*" "wasi-sysroot-$WASI_SDK_VERSION/lib/wasm32-wasip1-threads/*"
curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-$V/libclang_rt-$WASI_SDK_VERSION.tar.gz" | tar xz -C "$D/x"
mv "$D/x/wasi-sysroot-$WASI_SDK_VERSION/include" "$D/x/wasi-sysroot-$WASI_SDK_VERSION/lib" "$D/pkg/package/"
find "$D/pkg" -type d -name llvm-lto -prune -exec rm -rf {} +
cp "$D/x/libclang_rt-$WASI_SDK_VERSION/wasm32-unknown-wasip1-threads/libclang_rt.builtins.a" "$D/pkg/package/clang-rt/"
tar czf "$TEHBOXEN/toolchain/wasi-threads-sysroot-$V.tgz" --owner=0 --group=0 --sort=name -C "$D/pkg" package
