#!/bin/sh
# Build curl + libcurl for wasm32-wasip1 with OpenSSL (run openssl/build.sh, then fetch.sh, first);
# installs libcurl into $WORK/curl-root for other ports (uacme). CA bundle: the world trust
# bundle. No zlib/brotli/zstd/nghttp2/libssh2/LDAP/RTSP/PSL/IDN, no threaded resolver.
# Three nudges: configure's connect() probe declares `char connect();`, which clashes with
# compat.h's prototype (connect is in libtehboxen, no extra lib needed: preset to ""); curl's
# thread checks add -pthread (shared memory) though nothing here uses threads (stripped);
# setjmp (DNS timeouts) needs Wasm EH; no wakeup socketpair (configure finds pipe(), which
# WASI can't do at run time: every transfer failed with "Out of memory").
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
OR=$WORK/openssl-root/usr
[ -f "$OR/lib/libssl.a" ] || { echo "build ports/openssl first" >&2; exit 1; }
cd "$WORK/curl"
BASE="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot -include $TB/compat.h -idirafter $TB/include -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN"
EH="-mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"
LIBS0="-ltehboxen -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman"
sed -i 's/^  tst_connect_need_LIBS="unknown"$/  tst_connect_need_LIBS=""/' configure
./configure --host=wasm32-wasi --build=x86_64-linux-gnu CC="$BASE" AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" \
  CFLAGS=-O2 CPPFLAGS="-I$OR/include" LDFLAGS="-L$OR/lib -L$TB/lib/wasm32-wasip1 $TB_LDFLAGS" LIBS="$LIBS0" \
  --with-openssl="$OR" --with-ca-bundle=/etc/ssl/certs/ca-certificates.crt --without-libpsl --without-zlib \
  --without-brotli --without-zstd --without-libidn2 --without-nghttp2 --without-libssh2 --disable-ldap --disable-rtsp \
  --disable-threaded-resolver --disable-socketpair --disable-shared --enable-static --disable-docs --disable-manual --disable-unix-sockets \
  --prefix=/usr > "$WORK/curl-configure.log" 2>&1 || { tail -20 "$WORK/curl-configure.log"; exit 1; }
sed -i 's/ -pthread//g' Makefile lib/Makefile src/Makefile libcurl.pc curl-config
make -j2 CC="$BASE $EH" LIBS="-lssl -lcrypto $LIBS0 -lsetjmp" > "$WORK/curl-make.log" 2>&1 || true
sed -i "s/inherited_linker_flags=' -pthread'/inherited_linker_flags=''/" lib/libcurl.la
make -j2 CC="$BASE $EH" LIBS="-lssl -lcrypto $LIBS0 -lsetjmp" > "$WORK/curl-make.log" 2>&1 || { grep -E "error:|undefined symbol" "$WORK/curl-make.log" | head -30; exit 1; }
rm -rf "$WORK/curl-root"
make -C lib install DESTDIR="$WORK/curl-root" > /dev/null 2>&1
make -C include install DESTDIR="$WORK/curl-root" > /dev/null 2>&1
ls -la src/curl "$WORK/curl-root/usr/lib/libcurl.a"
