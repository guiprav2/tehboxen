#!/bin/sh
# Build uacme (an ACME client: OpenSSL + libcurl) for wasm32-wasip1. Its seven C files (Makefile.am uacme_SOURCES) are
# compiled directly with ports/uacme/config.h instead of autotools (the tag tarball ships no
# configure). Needs ports/openssl and ports/curl built first.
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
OR=$WORK/openssl-root/usr
CR=$WORK/curl-root/usr
[ -f "$CR/lib/libcurl.a" ] || { echo "build ports/curl first" >&2; exit 1; }
cd "$WORK/uacme"
cp "$PORTS/uacme/config.h" config.h
"$WASI_SDK/bin/clang" --target=wasm32-wasip1 --sysroot="$WASI_SDK/share/wasi-sysroot" -include "$TB/compat.h" -idirafter "$TB/include" \
  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN \
  -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false -O2 -I. -I"$OR/include" -I"$CR/include" \
  uacme.c crypto.c curlwrap.c base64.c json.c msg.c read-file.c -o uacme \
  -L"$CR/lib" -L"$OR/lib" -L"$TB/lib/wasm32-wasip1" $TB_LDFLAGS -lcurl -lssl -lcrypto -ltehboxen \
  -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman -lsetjmp
ls -la uacme
