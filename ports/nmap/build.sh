#!/bin/sh
# Build nmap for wasm32-wasip1 (run fetch.sh first): bundled libpcap (our AF_PACKET capture
# backend in pcap-null.c), libdnet (Linux backends; WASI route/ndisc), Lua (NSE), pcre, zlib,
# liblinear. No OpenSSL/libssh2/ncat/nping/zenmap/ndiff yet. C++ exceptions and setjmp use
# Wasm EH (exnref), with wasi-sdk's eh libc++ and libunwind.
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
cd "$WORK/nmap"
FL="-include $TB/compat.h -idirafter $TB/include -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"
export ac_cv_dnet_linux_procfs=yes
./configure --host=wasm32-wasi --build=x86_64-linux-gnu \
  CC="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot $FL" \
  CXX="$WASI_SDK/bin/clang++ --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot $FL -fwasm-exceptions" \
  AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" CFLAGS=-O2 CXXFLAGS=-O2 \
  LDFLAGS="-L$WASI_SDK/share/wasi-sysroot/lib/wasm32-wasip1/eh -L$TB/lib/wasm32-wasip1 $TB_LDFLAGS" \
  LIBS="-ltehboxen -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman -lsetjmp -lunwind" \
  --without-openssl --without-libssh2 --without-zenmap --without-ndiff --without-nping --without-ncat \
  --with-libpcap=included --with-pcap=null --with-libpcre=included --with-libz=included --with-liblua=included \
  --with-libdnet=included --with-liblinear=included --prefix=/usr/local > "$WORK/nmap-configure.log" 2>&1 \
  || { tail -20 "$WORK/nmap-configure.log"; exit 1; }
make -j"$(nproc)" > "$WORK/nmap-make.log" 2>&1 || { grep -E "error:|undefined symbol" "$WORK/nmap-make.log" | head -30; exit 1; }
ls -la nmap
