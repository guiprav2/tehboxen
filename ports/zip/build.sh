#!/bin/sh
# Build Zip 3.0 (Debian-patched) for wasm32-wasip1 (run fetch.sh first): zip, zipcloak,
# zipnote, zipsplit. No bzip2 method; traditional PKWARE encryption (-e) included.
. "$(dirname "$0")/../infozip-env.sh"
cd "$WORK/zip"
make -f unix/Makefile clean >/dev/null 2>&1
make -f unix/Makefile zips CC="$IZ_CC" BIND="$IZ_CC" LFLAGS2="$IZ_LIBS" OCRCU8=crc32_.o OCRCTB= \
  CFLAGS="-O2 -I. -DUNIX $IZ_WARN -DNO_ASM -DLARGE_FILE_SUPPORT -DUNICODE_SUPPORT -DHAVE_DIRENT_H -DHAVE_TERMIOS_H -DHAVE_WCHAR_H -DNO_VALLOC" \
  > "$WORK/zip-make.log" 2>&1 || { grep -E "error|undefined symbol" "$WORK/zip-make.log" | head -30; exit 1; }
ls -la zip zipcloak zipnote zipsplit
