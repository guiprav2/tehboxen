# xz-utils for Tehboxen

XZ Utils (release tarball + sha256 in `VERSION`) for wasm32-wasip1, part of the base system
(`baked: true` in other/packages.js, installed at boot like busybox). Provides `xz`, `unxz`,
`xzcat`, `lzma`, `unlzma`, `lzcat`; busybox's own xz applets are disabled (they only
decompress), so `tar cJf` (busybox tar → `system("xz -c …")`) compresses with this one.

    sh ports/xz/fetch.sh && sh ports/xz/build.sh && sh ports/xz/package.sh

`patches/0001-wasi.patch`:

- `src/common/mythread.h`: the single-threaded `sigprocmask()` wrapper also on WASI
  (upstream assumes WASI has no signals; libtehboxen provides them).
- `src/xz/file_io.c`: no self-pipe on WASI (no `pipe()`); signals are delivered inside
  blocking syscalls, so `poll()` on the data fd alone notices `user_abort`.
