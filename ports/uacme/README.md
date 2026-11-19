# uacme for Tehboxen

uacme, a lightweight ACME client (OpenSSL + libcurl), for wasm32-wasip1: `sudo pkg install uacme`.
Gets certificates from TrustRoot (`acme.trustroot.net`, world-seed's acme box) or any ACME CA:

    uacme -a https://acme.trustroot.net/directory -y new admin@example.box
    uacme -a https://acme.trustroot.net/directory -h /usr/share/uacme/uacme.sh issue example.box

The http-01 hook writes the token under `$UACME_CHALLENGE_PATH` (default
/var/www/.well-known/acme-challenge), which a web server on :80 must serve.

`patches/0001-wasi.patch`: `hook_run()` runs the hook with `tehboxen_run_argv()` (no fork),
with the `UACME_*` variables in its environment. `config.h` replaces autotools.
