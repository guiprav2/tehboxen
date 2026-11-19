/**
 * JS routers: firmware-less network devices that live in the fabric (page),
 * configured from the root computer's /world/net/routers/<id>.yaml:
 *
 *   hostname: home-router
 *   interfaces:
 *     - { name: wan, segment: internet, addr: 73.42.18.9/8 }
 *     - { name: lan, segment: home, addr: 192.168.1.1/24 }
 *   routes: [{ to: default, dev: wan }]          # or { to: 10.0.0.0/8, via: 10.1.1.1 }
 *   masquerade: [wan]                            # NAT (iptables -t nat -A POSTROUTING -o wan -j MASQUERADE)
 *   forwards: [{ proto: tcp, port: 2222, to: 192.168.1.10:22, in: wan }]
 *   dhcp: { iface: lan, range: 192.168.1.100-192.168.1.199, dns: [192.168.1.1], domain: lan, lease: 86400 }
 *   dns: { listen: lan, forwarders: [8.8.8.8, 1.1.1.1] }   # dnsmasq-style forwarder
 *   firewall: |                                  # extra iptables-restore text, applied last
 *     *filter
 *     -A FORWARD -i wan -m conntrack --ctstate NEW -j DROP
 *     COMMIT
 *
 * A router is just a Stack with ip_forward on plus a couple of services.
 */
import { Stack } from './stack.js';
import { parseCidr } from './ip.js';
import { startDhcpServer } from './dhcp.js';
import { decodeMessage, encodeMessage } from './dns.js';

export class Router {
  /**
   * @param {string} id
   * @param {object} cfg parsed YAML
   * @param {{ attach: (owner, ifname, segment, stack) => void, transmit: Function, saveLeases?: Function, log?: Function }} fabric
   */
  constructor(id, cfg, fabric) {
    this.id = id;
    this.cfg = cfg;
    this.fabric = fabric;
    this.services = [];
    this.stack = new Stack({ hostname: cfg.hostname || id, forwarding: true, transmit: (ifname, nextHop, pkt) => fabric.transmit(`router:${id}`, ifname, nextHop, pkt), log: fabric.log });
  }

  async start(leases = {}) {
    let { cfg, stack } = this;
    for (let i of cfg.interfaces || []) {
      let c = parseCidr(i.addr);
      stack.addIface(i.name, { mac: i.mac || macFor(`${this.id}/${i.name}`), segment: i.segment, addrs: c ? [{ ip: c.ip, prefix: c.prefix }] : [] });
      this.fabric.attach(`router:${this.id}`, i.name, i.segment, stack);
    }
    for (let r of cfg.routes || []) {
      let c = parseCidr(r.to || 'default');
      stack.addRoute({ dst: c.ip, prefix: c.prefix, via: r.via || null, dev: r.dev || null, metric: r.metric || 0 });
    }
    let rules = ['*nat'];
    for (let f of cfg.forwards || []) {
      let proto = f.proto || 'tcp';
      rules.push(`-A PREROUTING${f.in ? ` -i ${f.in}` : ''} -p ${proto} -m ${proto} --dport ${f.port} -j DNAT --to-destination ${f.to}`);
    }
    for (let ifname of cfg.masquerade || []) rules.push(`-A POSTROUTING -o ${ifname} -j MASQUERADE`);
    rules.push('COMMIT');
    stack.nf.restore(rules.join('\n'));
    if (cfg.firewall) stack.nf.restore(String(cfg.firewall), ['--noflush']);
    if (cfg.dhcp?.iface) {
      this.dhcp = startDhcpServer(stack, { ...cfg.dhcp, leases, onLeases: (l) => this.fabric.saveLeases?.(this.id, l) });
      this.services.push(this.dhcp);
    }
    if (cfg.dns?.forwarders?.length) this.services.push(this.startDnsForwarder(cfg.dns));
  }

  /** dnsmasq-ish: relay queries from the LAN to the upstream resolvers. */
  startDnsForwarder({ listen, forwarders }) {
    let addr = listen ? this.stack.primaryAddr(listen) : '0.0.0.0';
    let sock = this.stack.udpBind({ addr: addr || '0.0.0.0', port: 53, uid: 0 });
    let cache = new Map();
    sock.on('message', async (data, from) => {
      let q;
      try {
        q = decodeMessage(data);
      } catch {
        return;
      }
      let key = q.questions.map((x) => `${x.name.toLowerCase()} ${x.type}`).join('|');
      let hit = cache.get(key);
      if (hit && hit.expires > Date.now()) {
        let res = decodeMessage(hit.bytes);
        res.id = q.id;
        return sock.send(encodeMessage(res), from);
      }
      let up = this.stack.udpBind({});
      try {
        for (let ns of forwarders) {
          up.send(data, { addr: ns, port: 53 });
          let m;
          try {
            m = await up.recv({ timeout: 4000 });
          } catch {
            continue;
          }
          let res = decodeMessage(m.data);
          let ttl = Math.min(300, ...res.answers.map((a) => a.ttl));
          if (res.rcode === 0 || res.rcode === 3) cache.set(key, { bytes: m.data, expires: Date.now() + Math.max(0, res.rcode === 3 ? 60 : ttl) * 1000 });
          return sock.send(m.data, from);
        }
        sock.send(encodeMessage({ ...q, qr: true, ra: true, rcode: 2, answers: [] }), from);
      } finally {
        up.close();
      }
    });
    return sock;
  }

  stop() {
    for (let s of this.services) s.close?.();
  }
}

/** Stable locally administered MAC for an interface id. */
export function macFor(key) {
  let h = 2166136261;
  for (let ch of String(key)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let h2 = Math.imul(h ^ 0x9e3779b9, 2654435761) >>> 0;
  let b = [0x02, (h >>> 24) & 255, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, h2 & 255];
  return b.map((x) => x.toString(16).padStart(2, '0')).join(':');
}
