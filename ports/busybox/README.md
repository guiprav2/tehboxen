# busybox for Tehboxen

BusyBox (version in `VERSION`, checksum-verified release tarball) built for
wasm32-wasip1 with wasi-sdk and libtehboxen; `applets.config` picks the applets
on top of `make allnoconfig`. Baked into every box as the `busybox` system
package (other/packages.js): `/bin/busybox` plus applet symlinks, installed at
boot without `pkg install`.

    sh ports/busybox/fetch.sh && sh ports/busybox/build.sh && sh ports/busybox/package.sh

`patches/0001-wasi.patch` (regenerate with `git diff > ...` in `$WORK/busybox`):

- `include/platform.h`: no mntent/statfs/ethernet/pty/`/dev/fd` on WASI.
- `libbb/vfork_daemon_rexec.c`: `spawn()` → libtehboxen's fork-less `tehboxen_spawn()`;
  daemonizing → `tehboxen_detach()` (the shell stops waiting, the process runs on).
- `archival/libarchive/open_transformer.c`: decompression "transformers" run into an
  unlinked temp file instead of a forked child behind a pipe.
- `libbb/udp_io.c`: plain `sendto`/`recvfrom` (no `IP_PKTINFO` control messages).
- `libbb/xconnect.c`: no Unix-socket (`local:`) addresses.
- `networking/udhcp/*`: no packet sockets/ARP: udhcpc sends and listens on UDP
  sockets bound to the interface (the kernel delivers broadcasts to unconfigured
  interfaces); arpping reports "no reply"; the signal self-pipe is a no-op.
- `networking/traceroute.c`: its fixed socket fds 3/4 are WASI preopens; use 60/61.
- `scripts/trylink`: no `--start-group` for wasm-ld (build.sh links itself anyway).

Not built: ash/hush (boxsh is the shell), `time` (needs full rusage), `timeout` and `cpio` (need fork). Also patched: `tar -z/-j` creation writes a temp file, then compresses it through `system()`. Known gaps: `nc -lk` (fork per connection), `wget https://` (no TLS).
