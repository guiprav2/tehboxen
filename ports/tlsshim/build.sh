#!/bin/sh
# Build toolchain/tls/tlsshim.wasm: libssl behind memory BIOs, a WASI reactor for the node
# runtime's tls/https (other/node/tls.js). Needs ports/openssl built first.
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
OR=$WORK/openssl-root/usr
[ -f "$OR/lib/libssl.a" ] || { echo "build ports/openssl first" >&2; exit 1; }
mkdir -p "$TEHBOXEN/toolchain/tls"
"$WASI_SDK/bin/clang" --target=wasm32-wasip1 --sysroot="$WASI_SDK/share/wasi-sysroot" -mexec-model=reactor -O2 \
  -include "$TB/compat.h" -idirafter "$TB/include" -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN \
  -I"$OR/include" "$PORTS/tlsshim/tlsshim.c" -o "$WORK/tlsshim.wasm" \
  -L"$OR/lib" -L"$TB/lib/wasm32-wasip1" -lssl -lcrypto -ltehboxen \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman
"$WASI_SDK/bin/llvm-strip" -o "$TEHBOXEN/toolchain/tls/tlsshim.wasm" "$WORK/tlsshim.wasm"
ls -la "$TEHBOXEN/toolchain/tls/tlsshim.wasm"
