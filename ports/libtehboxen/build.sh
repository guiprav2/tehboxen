#!/bin/sh
# libtehboxen: system()/popen(), termios, pwd/grp, ids, fork stubs and the cwd init for WASI
# programs (tehboxen.c), BSD sockets + <netdb.h> on the simulated network (socket.c). Headers live in toolchain/libtehboxen (they are what the
# in-box clang mounts at /usr/tehboxen); this builds the archives next to them.
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
OUT=$TEHBOXEN/toolchain/libtehboxen
for t in wasm32-wasip1 wasm32-wasip1-threads; do
  F=""; [ $t = wasm32-wasip1-threads ] && F="-pthread"
  mkdir -p "$OUT/lib/$t"
  objs=""
  for src in tehboxen socket posix resolv; do
    "$WASI_SDK/bin/clang" --target=$t --sysroot="$WASI_SDK/share/wasi-sysroot" -I"$OUT/include" -include "$OUT/compat.h" \
      -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_GETPID $F -O2 -c "$PORTS/libtehboxen/$src.c" -o "$WORK/$src-$t.o"
    objs="$objs $WORK/$src-$t.o"
  done
  rm -f "$OUT/lib/$t/libtehboxen.a"
  "$WASI_SDK/bin/llvm-ar" rcs "$OUT/lib/$t/libtehboxen.a" $objs
done
