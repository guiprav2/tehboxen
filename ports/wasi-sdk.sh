#!/bin/sh
# Fetch wasi-sdk (the host toolchain the ports build with) into $WORK.
. "$(dirname "$0")/env.sh"
[ -x "$WASI_SDK/bin/clang" ] && exit 0
echo "fetching wasi-sdk $WASI_SDK_VERSION…"
curl -fsSL "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION%%.*}/wasi-sdk-$WASI_SDK_VERSION-x86_64-linux.tar.gz" | tar xz -C "$WORK"
