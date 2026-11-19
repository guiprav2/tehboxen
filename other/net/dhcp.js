/**
 * DHCP (RFC 2131) wire format, server (JS routers) and client (dhclient).
 * Real BOOTP/DHCP messages over UDP 67/68 broadcasts on the segment.
 */
import { intToIp, ipToInt, maskOf, inSubnet } from './ip.js';

export let MSG = { DISCOVER: 1, OFFER: 2, REQUEST: 3, DECLINE: 4, ACK: 5, NAK: 6, RELEASE: 7, INFORM: 8 };
export let MSG_NAMES = Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k]));
let enc = new TextEncoder();
let dec = new TextDecoder();

let macBytes = (mac) => String(mac).split(':').map((h) => parseInt(h, 16));
let macText = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');

/** { op, xid, flags, ciaddr, yiaddr, siaddr, giaddr, chaddr, type, options: { requestedIp, serverId, lease, subnet, router, dns, hostname, domain } } */
export function encodeDhcp(m) {
  let opts = [];
  let push = (code, bytes) => opts.push(code, bytes.length, ...bytes);
  let ip4 = (ip) => {
    let n = ipToInt(ip);
    return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  };
  let u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  push(53, [m.type]);
  let o = m.options || {};
  if (o.serverId) push(54, ip4(o.serverId));
  if (o.requestedIp) push(50, ip4(o.requestedIp));
  if (o.lease != null) push(51, u32(o.lease));
  if (o.renew != null) push(58, u32(o.renew));
  if (o.subnet) push(1, ip4(o.subnet));
  if (o.router?.length) push(3, o.router.flatMap(ip4));
  if (o.dns?.length) push(6, o.dns.flatMap(ip4));
  if (o.hostname) push(12, [...enc.encode(o.hostname)]);
  if (o.domain) push(15, [...enc.encode(o.domain)]);
  if (o.broadcast) push(28, ip4(o.broadcast));
  if (o.params) push(55, o.params);
  if (o.message) push(56, [...enc.encode(o.message)]);
  opts.push(255);
  let b = new Uint8Array(240 + opts.length);
  let dv = new DataView(b.buffer);
  b[0] = m.op || (m.type === MSG.OFFER || m.type === MSG.ACK || m.type === MSG.NAK ? 2 : 1);
  b[1] = 1;
  b[2] = 6;
  dv.setUint32(4, m.xid >>> 0);
  dv.setUint16(10, m.flags || 0);
  dv.setUint32(12, ipToInt(m.ciaddr || '0.0.0.0'));
  dv.setUint32(16, ipToInt(m.yiaddr || '0.0.0.0'));
  dv.setUint32(20, ipToInt(m.siaddr || '0.0.0.0'));
  dv.setUint32(24, ipToInt(m.giaddr || '0.0.0.0'));
  b.set(macBytes(m.chaddr || '00:00:00:00:00:00'), 28);
  b.set([99, 130, 83, 99], 236);
  b.set(opts, 240);
  return b;
}

export function decodeDhcp(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 240 || b[236] !== 99 || b[237] !== 130 || b[238] !== 83 || b[239] !== 99) throw new Error('not DHCP');
  let dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let m = {
    op: b[0],
    xid: dv.getUint32(4),
    flags: dv.getUint16(10),
    ciaddr: intToIp(dv.getUint32(12)),
    yiaddr: intToIp(dv.getUint32(16)),
    siaddr: intToIp(dv.getUint32(20)),
    giaddr: intToIp(dv.getUint32(24)),
    chaddr: macText(b.subarray(28, 34)),
    type: 0,
    options: {},
  };
  let ips = (o, n) => {
    let out = [];
    for (let i = 0; i + 3 < n; i += 4) out.push(intToIp(dv.getUint32(o + i)));
    return out;
  };
  for (let i = 240; i < b.length; ) {
    let code = b[i];
    if (code === 255) break;
    if (code === 0) {
      i++;
      continue;
    }
    let len = b[i + 1];
    let o = i + 2;
    switch (code) {
      case 53:
        m.type = b[o];
        break;
      case 54:
        m.options.serverId = ips(o, 4)[0];
        break;
      case 50:
        m.options.requestedIp = ips(o, 4)[0];
        break;
      case 51:
        m.options.lease = dv.getUint32(o);
        break;
      case 58:
        m.options.renew = dv.getUint32(o);
        break;
      case 1:
        m.options.subnet = ips(o, 4)[0];
        break;
      case 3:
        m.options.router = ips(o, len);
        break;
      case 6:
        m.options.dns = ips(o, len);
        break;
      case 12:
        m.options.hostname = dec.decode(b.subarray(o, o + len));
        break;
      case 15:
        m.options.domain = dec.decode(b.subarray(o, o + len));
        break;
      case 28:
        m.options.broadcast = ips(o, 4)[0];
        break;
      case 56:
        m.options.message = dec.decode(b.subarray(o, o + len));
        break;
    }
    i = o + len;
  }
  return m;
}

let prefixToMask = (p) => intToIp(maskOf(p));
export let maskToPrefix = (mask) => {
  let n = ipToInt(mask);
  let p = 0;
  while (p < 32 && n & (0x80000000 >>> p)) p++;
  return p;
};

/**
 * DHCP server on a stack interface.
 * @param {import('./stack.js').Stack} stack
 * @param {{ iface: string, range: string, router?: string, dns?: string[], domain?: string, lease?: number,
 *           static?: Record<string,string>, leases?: Record<string,{ip,expires,hostname}>, onLeases?: Function }} cfg
 */
export function startDhcpServer(stack, cfg) {
  let iface = stack.ifaces.get(cfg.iface);
  let addr = iface.addrs[0];
  let [lo, hi] = String(cfg.range).split('-').map((s) => ipToInt(s.trim()));
  let leaseSecs = Number(cfg.lease) || 86400;
  let leases = new Map(Object.entries(cfg.leases || {})); // mac → { ip, expires, hostname }
  let statics = new Map(Object.entries(cfg.static || {}));
  let offers = new Map(); // mac → ip
  let sock = stack.udpBind({ port: 67, uid: 0, reuse: true });
  sock.device = cfg.iface;
  sock.broadcast = true;

  let inUse = (ip, mac) => {
    for (let [m, l] of leases) if (m !== mac && l.ip === ip && l.expires > Date.now()) return true;
    for (let [m, s] of statics) if (m !== mac && s === ip) return true;
    for (let [m, o] of offers) if (m !== mac && o === ip) return true;
    return ip === addr.ip;
  };
  let pick = (mac, requested) => {
    if (statics.has(mac)) return statics.get(mac);
    let prev = leases.get(mac);
    if (prev && !inUse(prev.ip, mac)) return prev.ip;
    if (requested && ipToInt(requested) >= lo && ipToInt(requested) <= hi && !inUse(requested, mac)) return requested;
    for (let n = lo; n <= hi; n++) if (!inUse(intToIp(n), mac)) return intToIp(n);
    return null;
  };
  let options = (extra = {}) => ({
    serverId: addr.ip,
    lease: leaseSecs,
    renew: Math.floor(leaseSecs / 2),
    subnet: prefixToMask(addr.prefix),
    router: [cfg.router || addr.ip],
    dns: cfg.dns?.length ? cfg.dns : [addr.ip],
    domain: cfg.domain,
    ...extra,
  });
  let reply = (req, type, yiaddr, extra) => {
    let m = { op: 2, type, xid: req.xid, flags: req.flags, yiaddr: yiaddr || '0.0.0.0', siaddr: addr.ip, chaddr: req.chaddr, options: type === MSG.NAK ? { serverId: addr.ip, message: extra?.message } : options(extra) };
    let unicast = req.ciaddr !== '0.0.0.0' && !(req.flags & 0x8000);
    sock.send(encodeDhcp(m), { addr: unicast ? req.ciaddr : '255.255.255.255', port: 68 });
  };
  sock.on('message', (data) => {
    let req;
    try {
      req = decodeDhcp(data);
    } catch {
      return;
    }
    if (req.op !== 1) return;
    let mac = req.chaddr;
    if (req.type === MSG.DISCOVER) {
      let ip = pick(mac, req.options.requestedIp);
      if (!ip) return;
      offers.set(mac, ip);
      setTimeout(() => offers.get(mac) === ip && offers.delete(mac), 60000);
      reply(req, MSG.OFFER, ip);
    } else if (req.type === MSG.REQUEST) {
      if (req.options.serverId && req.options.serverId !== addr.ip) {
        offers.delete(mac);
        return;
      }
      let want = req.options.requestedIp || req.ciaddr;
      let ok = want && inSubnet(want, addr.ip, addr.prefix) && !inUse(want, mac) && (statics.get(mac) ? statics.get(mac) === want : ipToInt(want) >= lo && ipToInt(want) <= hi);
      if (!ok) return reply(req, MSG.NAK, null, { message: 'requested address not available' });
      offers.delete(mac);
      leases.set(mac, { ip: want, expires: Date.now() + leaseSecs * 1000, hostname: req.options.hostname || '' });
      cfg.onLeases?.(Object.fromEntries(leases));
      reply(req, MSG.ACK, want);
    } else if (req.type === MSG.RELEASE) {
      let l = leases.get(mac);
      if (l) l.expires = 0;
      cfg.onLeases?.(Object.fromEntries(leases));
    } else if (req.type === MSG.INFORM) {
      reply(req, MSG.ACK, null);
    }
  });
  return { leases, close: () => sock.close() };
}

/**
 * Obtain a lease on an interface and configure it (address, default route).
 * @returns {Promise<{ ip, prefix, router, dns, domain, lease, server }>}
 */
export async function dhcpClient(stack, ifname, { hostname, requested, timeout = 4000, tries = 3, log = () => {} } = {}) {
  let iface = stack.ifaces.get(ifname);
  if (!iface) throw new Error(`Cannot find device "${ifname}"`);
  if (!iface.up) stack.setLink(ifname, true);
  let sock = stack.udpBind({ port: 68, uid: 0, reuse: true });
  sock.device = ifname;
  sock.broadcast = true;
  let xid = (Math.random() * 0xffffffff) >>> 0;
  let send = (type, options) => {
    log(`DHCP${MSG_NAMES[type]} on ${ifname} to 255.255.255.255 port 67 (xid=0x${xid.toString(16)})`);
    sock.send(encodeDhcp({ op: 1, type, xid, flags: 0x8000, chaddr: iface.mac, options: { hostname, params: [1, 3, 6, 12, 15, 28, 51, 54], ...options } }), { addr: '255.255.255.255', port: 67 });
  };
  let wait = async (types) => {
    let deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      let m;
      try {
        m = await sock.recv({ timeout: Math.max(1, deadline - Date.now()) });
      } catch {
        return null;
      }
      let d;
      try {
        d = decodeDhcp(m.data);
      } catch {
        continue;
      }
      if (d.xid === xid && d.op === 2 && types.includes(d.type)) return d;
    }
    return null;
  };
  try {
    for (let t = 0; t < tries; t++) {
      send(MSG.DISCOVER, requested ? { requestedIp: requested } : {});
      let offer = await wait([MSG.OFFER]);
      if (!offer) continue;
      log(`DHCPOFFER of ${offer.yiaddr} from ${offer.options.serverId}`);
      send(MSG.REQUEST, { requestedIp: offer.yiaddr, serverId: offer.options.serverId });
      let ack = await wait([MSG.ACK, MSG.NAK]);
      if (!ack) continue;
      if (ack.type === MSG.NAK) {
        log(`DHCPNAK from ${ack.options.serverId}`);
        requested = null;
        continue;
      }
      log(`DHCPACK of ${ack.yiaddr} from ${ack.options.serverId}`);
      let prefix = maskToPrefix(ack.options.subnet || '255.255.255.0');
      for (let a of [...iface.addrs]) if (a.proto === 'dhcp') stack.delAddr(ifname, a.ip, a.prefix);
      try {
        stack.addAddr(ifname, ack.yiaddr, prefix, { proto: 'dhcp' });
      } catch {}
      let router = ack.options.router?.[0];
      if (router) {
        stack.routes = stack.routes.filter((r) => !(r.dst === '0.0.0.0' && r.prefix === 0 && r.proto === 'dhcp'));
        try {
          stack.addRoute({ dst: '0.0.0.0', prefix: 0, via: router, dev: ifname, proto: 'dhcp', metric: 100 });
        } catch {}
      }
      log(`bound to ${ack.yiaddr} -- renewal in ${ack.options.renew || Math.floor((ack.options.lease || 86400) / 2)} seconds.`);
      return { ip: ack.yiaddr, prefix, router, dns: ack.options.dns || [], domain: ack.options.domain || '', lease: ack.options.lease, server: ack.options.serverId };
    }
    throw new Error(`No DHCPOFFERS received.`);
  } finally {
    sock.close();
  }
}
