/**
 * Wire format of the simulated network's packets: the stack's packet objects
 * ↔ real IPv4 / TCP / UDP / ICMP bytes (and Ethernet / ARP frames), for raw
 * sockets, packet capture (AF_PACKET: libpcap, nmap, tcpdump) and injection.
 *
 * Packet object fields (other/net/stack.js): src, dst, ttl, ipid, tos, proto
 * ('tcp'|'udp'|'icmp'), sport, dport, flags ('S', 'SA', 'PA', 'FA', 'R'…,
 * plus 'U'/'E'/'C' for URG/ECE/CWR), seq, ack, win, tcpOpts (Uint8Array),
 * data (Uint8Array), icmp: { type, code, id, seq, data, orig }.
 */

let put16 = (b, o, v) => ((b[o] = (v >>> 8) & 255), (b[o + 1] = v & 255));
let put32 = (b, o, v) => {
  put16(b, o, (v >>> 16) & 0xffff);
  put16(b, o + 2, v & 0xffff);
};
let get16 = (b, o) => (b[o] << 8) | b[o + 1];
let get32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
let ipBytes = (ip) => String(ip || '0.0.0.0').split('.').map(Number);
let ipText = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
let PROTO = { icmp: 1, tcp: 6, udp: 17 };
let PROTO_NAME = { 1: 'icmp', 6: 'tcp', 17: 'udp' };
let FLAG_BITS = { F: 0x01, S: 0x02, R: 0x04, P: 0x08, A: 0x10, U: 0x20, E: 0x40, C: 0x80 };

export function checksum(b, o = 0, n = b.length - o, init = 0) {
  let sum = init;
  for (let i = 0; i < n - 1; i += 2) sum += (b[o + i] << 8) | b[o + i + 1];
  if (n & 1) sum += b[o + n - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
}

function pseudoSum(src, dst, proto, len) {
  let s = ipBytes(src);
  let d = ipBytes(dst);
  return ((s[0] << 8) | s[1]) + ((s[2] << 8) | s[3]) + ((d[0] << 8) | d[1]) + ((d[2] << 8) | d[3]) + proto + len;
}

export let flagsToBits = (f) => [...String(f || '')].reduce((n, c) => n | (FLAG_BITS[c] || 0), 0);
// Same letter order the stack uses: 'SA', 'PA', 'FA', 'RA'.
export let bitsToFlags = (n) => ['S', 'P', 'F', 'R', 'A', 'U', 'E', 'C'].filter((c) => n & FLAG_BITS[c]).join('');

/** L4 header + payload of a packet. */
function l4Bytes(p) {
  if (p.proto === 'tcp') {
    let opts = p.tcpOpts || new Uint8Array(0);
    let optLen = (opts.length + 3) & ~3;
    let data = p.data || new Uint8Array(0);
    let b = new Uint8Array(20 + optLen + data.length);
    put16(b, 0, p.sport || 0);
    put16(b, 2, p.dport || 0);
    put32(b, 4, p.seq >>> 0);
    put32(b, 8, p.ack >>> 0);
    b[12] = ((20 + optLen) / 4) << 4;
    b[13] = typeof p.flags === 'number' ? p.flags : flagsToBits(p.flags);
    put16(b, 14, p.win ?? 64240);
    put16(b, 18, p.urp || 0);
    b.set(opts, 20);
    b.set(data, 20 + optLen);
    put16(b, 16, checksum(b, 0, b.length, pseudoSum(p.src, p.dst, 6, b.length)));
    return b;
  }
  if (p.proto === 'udp') {
    let data = p.data || new Uint8Array(0);
    let b = new Uint8Array(8 + data.length);
    put16(b, 0, p.sport || 0);
    put16(b, 2, p.dport || 0);
    put16(b, 4, b.length);
    b.set(data, 8);
    let c = checksum(b, 0, b.length, pseudoSum(p.src, p.dst, 17, b.length));
    put16(b, 6, c || 0xffff);
    return b;
  }
  // ICMP
  let m = p.icmp || {};
  let body;
  if ((m.type === 3 || m.type === 11) && m.orig) {
    // Quote the offending datagram: its IP header + the first 8 bytes of its L4 header.
    let o = m.orig;
    let q = toBytes({ src: o.src, dst: o.dst, ttl: o.ttl ?? 1, ipid: o.ipid || 0, proto: o.proto, sport: o.sport, dport: o.dport, seq: o.seq ?? 0, ack: 0, flags: o.flags || '', icmp: o.proto === 'icmp' ? { type: 8, code: 0, id: o.id, seq: o.seq } : undefined, data: new Uint8Array(0) });
    let quoted = q.subarray(0, Math.min(q.length, 28));
    body = new Uint8Array(8 + quoted.length);
    body.set(quoted, 8);
  } else {
    let data = m.data || new Uint8Array(0);
    body = new Uint8Array(8 + data.length);
    put16(body, 4, m.id ?? 0);
    put16(body, 6, m.seq ?? 0);
    body.set(data, 8);
  }
  body[0] = m.type;
  body[1] = m.code || 0;
  put16(body, 2, checksum(body));
  return body;
}

/** IPv4 datagram bytes for a packet object. */
export function toBytes(p) {
  let l4 = l4Bytes(p);
  let b = new Uint8Array(20 + l4.length);
  b[0] = 0x45;
  b[1] = p.tos || 0;
  put16(b, 2, b.length);
  put16(b, 4, p.ipid || 0);
  put16(b, 6, p.df === false ? 0 : 0x4000);
  b[8] = p.ttl ?? 64;
  b[9] = PROTO[p.proto] ?? 0;
  b.set(ipBytes(p.src), 12);
  b.set(ipBytes(p.dst), 16);
  put16(b, 10, checksum(b, 0, 20));
  b.set(l4, 20);
  return b;
}

/**
 * Parse an IPv4 datagram into a packet object (null if it isn't one we carry).
 * The L4 header isn't validated beyond lengths: raw senders may craft anything.
 */
export function fromBytes(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 20 || b[0] >> 4 !== 4) return null;
  let ihl = (b[0] & 15) * 4;
  let total = Math.min(get16(b, 2) || b.length, b.length);
  let proto = PROTO_NAME[b[9]];
  if (!proto || total < ihl) return null;
  let p = { src: ipText(b, 12), dst: ipText(b, 16), ttl: b[8], ipid: get16(b, 4), tos: b[1], df: !!(get16(b, 6) & 0x4000), proto };
  let l = b.subarray(ihl, total);
  if (proto === 'tcp') {
    if (l.length < 20) return null;
    let off = (l[12] >> 4) * 4;
    p.sport = get16(l, 0);
    p.dport = get16(l, 2);
    p.seq = get32(l, 4);
    p.ack = get32(l, 8);
    p.flags = bitsToFlags(l[13]);
    p.win = get16(l, 14);
    p.urp = get16(l, 18);
    p.tcpOpts = l.slice(20, Math.max(20, Math.min(off, l.length)));
    p.data = l.slice(Math.min(off, l.length));
  } else if (proto === 'udp') {
    if (l.length < 8) return null;
    p.sport = get16(l, 0);
    p.dport = get16(l, 2);
    p.data = l.slice(8, Math.max(8, Math.min(get16(l, 4), l.length)));
  } else {
    if (l.length < 8) return null;
    let icmp = { type: l[0], code: l[1] };
    if ((icmp.type === 3 || icmp.type === 11) && l.length >= 8 + 20) {
      let q = fromBytes(l.slice(8));
      if (q) icmp.orig = { proto: q.proto, src: q.src, dst: q.dst, sport: q.sport, dport: q.dport, id: q.icmp?.id, seq: q.proto === 'icmp' ? q.icmp?.seq : q.seq, ttl: q.ttl };
    } else {
      icmp.id = get16(l, 4);
      icmp.seq = get16(l, 6);
      icmp.data = l.slice(8);
    }
    p.icmp = icmp;
  }
  p.len = total;
  return p;
}

/* ---------- Ethernet / ARP ---------- */

let macBytes = (mac) => String(mac || '00:00:00:00:00:00').split(':').map((h) => parseInt(h, 16));
let macText = (b, o) => [...b.subarray(o, o + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':');
export let BROADCAST_MAC = 'ff:ff:ff:ff:ff:ff';

/** Ethernet frame: 14-byte header + payload (an IPv4 datagram or an ARP message). */
export function ethFrame(dstMac, srcMac, type, payload) {
  let b = new Uint8Array(14 + payload.length);
  b.set(macBytes(dstMac), 0);
  b.set(macBytes(srcMac), 6);
  put16(b, 12, type);
  b.set(payload, 14);
  return b;
}

export function parseEth(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 14) return null;
  return { dstMac: macText(b, 0), srcMac: macText(b, 6), type: get16(b, 12), payload: b.subarray(14) };
}

/** ARP message (Ethernet/IPv4): { op: 1 request | 2 reply, sha, spa, tha, tpa }. */
export function arpBytes({ op, sha, spa, tha = '00:00:00:00:00:00', tpa }) {
  let b = new Uint8Array(28);
  put16(b, 0, 1);
  put16(b, 2, 0x0800);
  b[4] = 6;
  b[5] = 4;
  put16(b, 6, op);
  b.set(macBytes(sha), 8);
  b.set(ipBytes(spa), 14);
  b.set(macBytes(tha), 18);
  b.set(ipBytes(tpa), 24);
  return b;
}

export function parseArp(b) {
  if (b.length < 28 || get16(b, 0) !== 1 || get16(b, 2) !== 0x0800) return null;
  return { op: get16(b, 6), sha: macText(b, 8), spa: ipText(b, 14), tha: macText(b, 18), tpa: ipText(b, 24) };
}
