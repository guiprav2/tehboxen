# GNU wget for Tehboxen

GNU Wget (release tarball + sha256 in `VERSION`; GNU-signed upstream) with OpenSSL, for
wasm32-wasip1, base system (`baked: true`; busybox's wget applet is off). `/etc/wgetrc` points
at the world trust bundle, so HTTPS is verified like anywhere else.

    sh ports/openssl/build.sh   # first: wget links $WORK/openssl-root
    sh ports/wget/fetch.sh && sh ports/wget/build.sh && sh ports/wget/package.sh

`patches/0001-wasi.patch`: `src/ptimer.c` keeps clock ids as `clockid_t` (a pointer on WASI).
build.sh documents three gnulib workarounds for our force-included compat.h.
