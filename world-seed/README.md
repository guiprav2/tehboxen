# /world

The root computer's description of the world. The desktop page's network
fabric (other/net/fabric.js) runs exactly what is here; edit, then
`worldctl apply` (or reload) to rebuild it.

- `net/segments.yaml` — network segments (LANs, `internet`) and latency in ms
- `net/routers/<id>.yaml` — JS routers: interfaces, routes, NAT, port forwards, DHCP, DNS forwarding, firewall
- `boxes/<id>.yaml` — machines: image, hostname, interfaces (static `a.b.c.d/nn` or `dhcp`), extra users and files.
  `local` is the player's own machine (the page itself).
- `images/<name>/image.yaml` + `rootfs/` — what a new box is provisioned with (`from:` inherits another image)
- `state/` — DHCP leases and other runtime state the fabric saves

Files seeded from the repo are kept up to date until you edit them; edited
files are yours. Put world-specific networks, servers and users here (or in a
world pack), never in host JS.
