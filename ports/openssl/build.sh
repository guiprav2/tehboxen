#!/bin/sh
# Build OpenSSL (libcrypto, libssl, the openssl CLI) for wasm32-wasip1 (run fetch.sh first) and
# install it into $WORK/openssl-root (headers + static libs for other ports: wget, nmap…).
# Generic 32-bit Unix target, no asm/threads/dso/engines; no QUIC (its notifier wants
# socketpair) and no AF_UNIX BIOs (wasi-libc's sockaddr_un has no sun_path). Randomness comes
# from getentropy() → WASI random_get.
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
cd "$WORK/openssl"
./Configure linux-generic32 no-asm no-threads no-shared no-dso no-afalgeng no-async no-secure-memory \
  no-tests no-docs no-module no-engine no-ktls no-uplink no-quic --prefix=/usr --openssldir=/etc/ssl \
  CC="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot -include $TB/compat.h -idirafter $TB/include -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN -DOPENSSL_NO_UNIX_SOCK" \
  CFLAGS=-O2 LDFLAGS="-L$TB/lib/wasm32-wasip1 $TB_LDFLAGS" \
  LDLIBS="-ltehboxen -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman" \
  AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" > "$WORK/openssl-configure.log" 2>&1 \
  || { tail -20 "$WORK/openssl-configure.log"; exit 1; }
rm -f apps/openssl # relink against the current libtehboxen
make -j"$(nproc)" build_sw > "$WORK/openssl-make.log" 2>&1 || { grep -E "error:|undefined symbol" "$WORK/openssl-make.log" | head -30; exit 1; }
rm -rf "$WORK/openssl-root"
make install_sw DESTDIR="$WORK/openssl-root" > /dev/null 2>&1
ls -la apps/openssl "$WORK/openssl-root/usr/lib/libssl.a"
