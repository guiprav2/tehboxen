#!/bin/sh
# Build busybox for wasm32-wasip1 against libtehboxen (run fetch.sh first).
# Config: `make allnoconfig` + applets.config. setjmp/longjmp use Wasm exception
# handling (exnref), like clang++ exceptions. The link is done here rather than by
# scripts/trylink, whose library pruning doesn't understand wasm-ld.
. "$(dirname "$0")/../env.sh"
"$PORTS/wasi-sdk.sh"
# clang runs wasm-opt after linking; distro binaryen can't parse exnref: use the stub.
PATH=$PORTS/bin:$PATH
TB=$TEHBOXEN/toolchain/libtehboxen
cd "$WORK/busybox"
make allnoconfig >/dev/null
python3 - "$PORTS/busybox/applets.config" <<'PY'
import re, sys
frag = {}
for l in open(sys.argv[1]):
    l = l.strip()
    if l and not l.startswith('#'):
        k, v = l.split('=', 1)
        frag[k] = v
out, seen = [], set()
for l in open('.config').read().split('\n'):
    m = re.match(r'(?:# )?(CONFIG_\w+)(?:=| is not set)', l)
    if m and m.group(1) in frag:
        k = m.group(1); seen.add(k)
        out.append(f'# {k} is not set' if frag[k] == 'n' else f'{k}={frag[k]}')
    else:
        out.append(l)
out += [f'# {k} is not set' if v == 'n' else f'{k}={v}' for k, v in frag.items() if k not in seen]
open('.config', 'w').write('\n'.join(out) + '\n')
PY
yes "" | make oldconfig >/dev/null
CC="$WASI_SDK/bin/clang --target=wasm32-wasip1 --sysroot=$WASI_SDK/share/wasi-sysroot"
CFLAGS="-include $TB/compat.h -idirafter $TB/include -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_GETPID -D_WASI_EMULATED_MMAN -mexception-handling -mllvm -wasm-enable-sjlj -mllvm -wasm-use-legacy-eh=false"
# Compile everything (the final trylink step fails; we link below).
make -j"$(nproc)" CC="$CC" AR="$WASI_SDK/bin/llvm-ar" STRIP="$WASI_SDK/bin/llvm-strip" HOSTCC=gcc \
  EXTRA_CFLAGS="$CFLAGS" SKIP_STRIP=y busybox_unstripped > "$WORK/busybox-make.log" 2>&1 || true
if grep -E "error:" "$WORK/busybox-make.log" | grep -qv "warn-common\|linker command failed"; then
  grep -E "error:" "$WORK/busybox-make.log" | grep -v "warn-common\|linker command failed" | head -40
  exit 1
fi
OBJS="applets/built-in.o $(for d in archival archival/libarchive console-tools coreutils coreutils/libcoreutils debianutils klibc-utils e2fsprogs editors findutils init libbb libpwdgrp loginutils mailutils miscutils modutils networking networking/libiproute networking/udhcp printutils procps runit selinux shell sysklogd util-linux util-linux/volume_id; do echo $d/lib.a; done) $(for d in archival archival/libarchive console-tools coreutils coreutils/libcoreutils debianutils klibc-utils e2fsprogs editors findutils init libbb libpwdgrp loginutils mailutils miscutils modutils networking networking/libiproute networking/udhcp printutils procps runit selinux shell sysklogd util-linux util-linux/volume_id; do echo $d/built-in.o; done)"
$CC -Oz -o busybox_unstripped $OBJS -L"$TB/lib/wasm32-wasip1" \
  -Wl,-u,__main_argc_argv $TB_LDFLAGS \
  -Wl,-z,stack-size=1048576 \
  -ltehboxen -lwasi-emulated-signal -lwasi-emulated-process-clocks -lwasi-emulated-getpid -lwasi-emulated-mman -lsetjmp -lm
make busybox.links >/dev/null 2>&1 || true
ls -la busybox_unstripped
