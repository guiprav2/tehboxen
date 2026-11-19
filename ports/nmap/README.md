# nmap for Tehboxen

Nmap (release tarball + sha256 in `VERSION`) for wasm32-wasip1 against libtehboxen,
installed with `sudo pkg install nmap` (other/packages.js). Unprivileged users get
connect scans; root gets raw scans (SYN/FIN/Xmas/UDP…), ARP discovery, OS detection,
through the kernel's raw IP and AF_PACKET sockets (other/net/stack.js).

    sh ports/nmap/fetch.sh && sh ports/nmap/build.sh && sh ports/nmap/package.sh

`patches/0001-wasi.patch`:

- `libpcap/pcap-null.c`: a live-capture backend for WASI (AF_PACKET socket bound to the
  interface, userland BPF via `pcapint_filter`, `send()` injection, interfaces from
  `if_nameindex` + SIOCGIF* ioctls).
- `libdnet-stripped/src/route-linux.c`: routes from `/proc/net/route`, `route_get` by
  longest prefix (no netlink); `ndisc-linux.c`: IPv6 neighbor tables unsupported.
- `libdnet-stripped/src/addr.c`, `intf.c`: WASI's `AF_INET` is 1 like `ARPHRD_ETHER`; MACs
  are read straight from `SIOCGIFHWADDR`.
- `libnetutil/NetBlock.cc`: wasi-libc's `in6_addr` initializers.
- `nsock/src/netutils.c`: no Unix-socket paths.

Not built yet: OpenSSL (TLS service detection, ssl-* scripts), libssh2, ncat, nping.
