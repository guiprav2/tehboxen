#!/bin/sh
# Build xz-utils (xz + static liblzma) for wasm32-wasip1 against libtehboxen (run fetch.sh first).
# Single-threaded: no threads in our WASI runtime.
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
cd "$WORK/xz"
FL="-include $TB/compat.h -idirafter $TB/include -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN"
./configure --host=wasm32-wasi --build=x86_64-linux-gnu \
  CC="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot $FL" \
  AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" CFLAGS=-O2 \
  LDFLAGS="-L$TB/lib/wasm32-wasip1 $TB_LDFLAGS" \
  LIBS="-ltehboxen -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman" \
  --disable-threads --disable-nls --disable-shared --enable-static --disable-doc --disable-scripts \
  --disable-lzmadec --disable-lzmainfo --disable-xzdec --prefix=/usr > "$WORK/xz-configure.log" 2>&1 \
  || { tail -20 "$WORK/xz-configure.log"; exit 1; }
rm -f src/xz/xz  # relink against the current libtehboxen
make -j"$(nproc)" > "$WORK/xz-make.log" 2>&1 || { grep -E "error:|undefined symbol" "$WORK/xz-make.log" | head -30; exit 1; }
ls -la src/xz/xz
