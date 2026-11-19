#!/bin/sh
# Build GNU wget for wasm32-wasip1 with OpenSSL (run openssl/build.sh, then fetch.sh, first).
# No PSL, IDN, PCRE, zlib, metalink, threads, NLS. gnulib needs three nudges:
#  - its "warnings" probe captures `$CC -E` output, which includes our force-included compat.h
#    → GL_CFLAG_GNULIB_WARNINGS is cleared at make time;
#  - its replacement headers insist on config.h coming first, and compat.h includes system
#    headers → make's CC force-includes src/config.h ahead of compat.h;
#  - without threads it always replaces pthread_sigmask; libtehboxen's is fine → kept.
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
OR=$WORK/openssl-root/usr
[ -f "$OR/lib/libssl.a" ] || { echo "build ports/openssl first" >&2; exit 1; }
cd "$WORK/wget"
BASE="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot"
FL="-include $TB/compat.h -idirafter $TB/include -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"
LIBS="-lssl -lcrypto -ltehboxen -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman -lsetjmp"
./configure --host=wasm32-wasi --build=x86_64-linux-gnu CC="$BASE $FL" \
  AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" CFLAGS="-O2 -I$OR/include" \
  LDFLAGS="-L$OR/lib -L$TB/lib/wasm32-wasip1 $TB_LDFLAGS" LIBS="$LIBS" \
  OPENSSL_CFLAGS="-I$OR/include" OPENSSL_LIBS="-L$OR/lib -lssl -lcrypto" \
  --with-ssl=openssl --without-libpsl --disable-nls --disable-iri --disable-pcre --disable-pcre2 \
  --without-zlib --without-metalink --without-libuuid --without-cares --disable-threads \
  --prefix=/usr --sysconfdir=/etc > "$WORK/wget-configure.log" 2>&1 || { tail -20 "$WORK/wget-configure.log"; exit 1; }
sed -i 's/^REPLACE_PTHREAD_SIGMASK = 1/REPLACE_PTHREAD_SIGMASK = 0/; s/ pthread_sigmask\.\$U\.o//; s/ pthread_sigmask\.o//' lib/Makefile src/Makefile
make -j"$(nproc)" GL_CFLAG_GNULIB_WARNINGS= CC="$BASE -include $PWD/src/config.h $FL" LIBS="$LIBS" \
  > "$WORK/wget-make.log" 2>&1 || { grep -E "error:|undefined symbol" "$WORK/wget-make.log" | head -30; exit 1; }
ls -la src/wget
