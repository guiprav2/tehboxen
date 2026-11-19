#!/bin/sh
# Build vim (and xxd) for wasm32-wasip1 from the fork in $WORK/vim (run fetch.sh first).
# No termcap library: configure gets an empty one to link against, then vim is built with
# its builtin terminal entries only. :!cmd goes through libtehboxen's system() (USE_SYSTEM).
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
TB=$TEHBOXEN/toolchain/libtehboxen
FAKE=$WORK/vim-faketc
mkdir -p "$FAKE"
printf 'int tgetent(char*b,const char*n){return 0;}\nint tgetflag(const char*i){return 0;}\nint tgetnum(const char*i){return -1;}\nchar*tgetstr(const char*i,char**a){return 0;}\nchar*tgoto(const char*c,int a,int b){return 0;}\nint tputs(const char*s,int n,int(*f)(int)){return 0;}\n' > "$FAKE/tc.c"
"$WASI_SDK/bin/clang" --target=wasm32-wasip1 --sysroot="$WASI_SDK/share/wasi-sysroot" -c "$FAKE/tc.c" -o "$FAKE/tc.o"
"$WASI_SDK/bin/llvm-ar" rcs "$FAKE/libfaketc.a" "$FAKE/tc.o"

cd "$WORK/vim/src"
make distclean >/dev/null 2>&1 || true
export CC="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot" AR="$WASI_SDK/bin/llvm-ar" RANLIB="$WASI_SDK/bin/llvm-ranlib" STRIP="$WASI_SDK/bin/llvm-strip"
export CPPFLAGS="-DUSE_SYSTEM -include $TB/include/sys/wait.h -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN -I$TB/include -include $TB/compat.h"
export CFLAGS="-O2 -Wno-implicit-function-declaration"
export LDFLAGS="-L$TB/lib/wasm32-wasip1 -L$FAKE -Wl,-z,stack-size=1048576"
export LIBS="-ltehboxen -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman -Wl,--export=__tehboxen_init -Wl,--wrap=stat,--wrap=lstat,--wrap=fstat,--wrap=fstatat"
export PKG_CONFIG=/bin/false  # never pick up the host's libraries
export vim_cv_toupper_broken=no vim_cv_terminfo=no vim_cv_tgetent=zero vim_cv_getcwd_broken=no vim_cv_stat_ignores_slash=no \
  vim_cv_memmove_handles_overlap=yes vim_cv_bcopy_handles_overlap=yes vim_cv_memcpy_handles_overlap=no \
  vim_cv_tty_group=world vim_cv_tty_mode=0620 vim_cv_timer_create=no vim_cv_timer_create_with_lrt=no
./configure --host=wasm32-wasi --build=x86_64-linux-gnu --with-features=normal --disable-gui --without-x --without-wayland \
  --disable-netbeans --disable-channel --disable-terminal --disable-nls --disable-acl --disable-gpm --disable-sysmouse \
  --disable-selinux --disable-smack --disable-xsmp --disable-xsmp-interact --disable-canberra --disable-libsodium \
  --disable-xattr --with-tlib=faketc --prefix=/usr/local --with-compiledby=tehboxen > "$WORK/vim-configure.log" 2>&1
sed -i 's/^#define HAVE_TGETENT 1/#undef HAVE_TGETENT/; s/^#define HAVE_DLOPEN 1/#undef HAVE_DLOPEN/' auto/config.h
sed -i 's/-lfaketc//g; s/ -ldl//g' auto/config.mk
make auto/osdef.h >/dev/null 2>&1
sed -i -E '/extern (int|char)[[:space:]]+\*?(tgetent|tgetnum|tgetflag|tgetstr|tgoto|tputs)\(/d' auto/osdef.h
make -j"$(nproc)" > "$WORK/vim-make.log" 2>&1 || { tail -30 "$WORK/vim-make.log"; exit 1; }
