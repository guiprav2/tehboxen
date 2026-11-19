# Shared by zip/build.sh and unzip/build.sh: the compiler and link line for Info-ZIP's
# unix/Makefile (its configure runs test programs, which can't run when cross-compiling, so
# the feature defines are given explicitly by each build.sh).
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
IZ_CC="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot -include $TB/compat.h -idirafter $TB/include -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN"
IZ_LIBS="-L$TB/lib/wasm32-wasip1 $TB_LDFLAGS -ltehboxen -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman"
IZ_WARN="-Wno-implicit-int -Wno-deprecated-non-prototype"
