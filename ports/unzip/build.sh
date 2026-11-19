#!/bin/sh
# Build UnZip 6.0 (Debian-patched) for wasm32-wasip1 (run fetch.sh first). No bzip2 entries
# (would need libbz2); Unicode names, large files, Unix uid/gid and modes (fchmod/fchown).
. "$(dirname "$0")/../infozip-env.sh"
cd "$WORK/unzip"
make -f unix/Makefile clean >/dev/null 2>&1
make -f unix/Makefile unzip funzip CC="$IZ_CC" LD="$IZ_CC" AS="$IZ_CC -c" LF2="$IZ_LIBS" \
  CF="-I. -DUNIX -O2 $IZ_WARN -DLARGE_FILE_SUPPORT -DUNICODE_SUPPORT -DUNICODE_WCHAR -DUTF8_MAYBE_NATIVE -DNO_LCHMOD -DHAVE_DIRENT_H -DHAVE_TERMIOS_H -DNO_VALLOC -DIZ_HAVE_UXUIDGID" \
  > "$WORK/unzip-make.log" 2>&1 || { grep -E "error|undefined symbol" "$WORK/unzip-make.log" | head -30; exit 1; }
ls -la unzip funzip
