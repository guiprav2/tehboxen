/**
 * DNS wire format (RFC 1035) for the simulated Internet: queries and answers
 * are real DNS messages over UDP 53, so dig/host/nslookup, node's dns module,
 * getaddrinfo in WASI programs and the named daemon all speak the same thing.
 */
import { ipToInt, intToIp } from './ip.js';

export let TYPES = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, HINFO: 13, MX: 15, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 };
export let TYPE_NAMES = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
export let RCODES = { 0: 'NOERROR', 1: 'FORMERR', 2: 'SERVFAIL', 3: 'NXDOMAIN', 4: 'NOTIMP', 5: 'REFUSED' };

let enc = new TextEncoder();
let dec = new TextDecoder();

export let normName = (n) => String(n || '').toLowerCase().replace(/\.+$/, '');

class Writer {
  constructor() {
    this.buf = new Uint8Array(512);
    this.len = 0;
  }
  ensure(n) {
    if (this.len + n <= this.buf.length) return;
    let b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n));
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  u8(v) {
    this.ensure(1);
    this.buf[this.len++] = v & 255;
  }
  u16(v) {
    this.u8(v >> 8);
    this.u8(v);
  }
  u32(v) {
    this.u16((v >>> 16) & 0xffff);
    this.u16(v & 0xffff);
  }
  bytes(b) {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  name(n) {
    for (let label of normName(n).split('.').filter(Boolean)) {
      let b = enc.encode(label).slice(0, 63);
      this.u8(b.length);
      this.bytes(b);
    }
    this.u8(0);
  }
  out() {
    return this.buf.slice(0, this.len);
  }
}

function writeRdata(w, type, data) {
  let start = w.len;
  w.u16(0); // length placeholder
  switch (type) {
    case TYPES.A:
      w.u32(ipToInt(data));
      break;
    case TYPES.NS:
    case TYPES.CNAME:
    case TYPES.PTR:
      w.name(data);
      break;
    case TYPES.MX:
      w.u16(Number(data.preference) || 0);
      w.name(data.exchange);
      break;
    case TYPES.TXT:
      for (let s of Array.isArray(data) ? data : [data]) {
        let b = enc.encode(String(s)).slice(0, 255);
        w.u8(b.length);
        w.bytes(b);
      }
      break;
    case TYPES.SOA:
      w.name(data.mname);
      w.name(data.rname);
      for (let k of ['serial', 'refresh', 'retry', 'expire', 'minimum']) w.u32(Number(data[k]) || 0);
      break;
    case TYPES.SRV:
      w.u16(data.priority || 0);
      w.u16(data.weight || 0);
      w.u16(data.port || 0);
      w.name(data.target);
      break;
    default:
      if (data instanceof Uint8Array) w.bytes(data);
  }
  let n = w.len - start - 2;
  w.buf[start] = n >> 8;
  w.buf[start + 1] = n & 255;
}

/**
 * Encode a message:
 * { id, qr, opcode, aa, tc, rd, ra, rcode, questions: [{ name, type }], answers, authorities, additionals }
 * Records: { name, type: 'A'|1, ttl, data } (A: '1.2.3.4', NS/CNAME/PTR: name, MX: { preference, exchange },
 * TXT: [strings], SOA: { mname, rname, serial, … }, SRV: { priority, weight, port, target }).
 */
export function encodeMessage(m) {
  let w = new Writer();
  w.u16(m.id ?? 0);
  let flags = (m.qr ? 0x8000 : 0) | ((m.opcode || 0) << 11) | (m.aa ? 0x400 : 0) | (m.tc ? 0x200 : 0) | (m.rd ? 0x100 : 0) | (m.ra ? 0x80 : 0) | ((m.rcode || 0) & 15);
  w.u16(flags);
  let sections = [m.questions || [], m.answers || [], m.authorities || [], m.additionals || []];
  for (let s of sections) w.u16(s.length);
  for (let q of sections[0]) {
    w.name(q.name);
    w.u16(typeNum(q.type));
    w.u16(q.class || 1);
  }
  for (let s of sections.slice(1)) {
    for (let r of s) {
      let t = typeNum(r.type);
      w.name(r.name);
      w.u16(t);
      w.u16(r.class || 1);
      w.u32(r.ttl ?? 300);
      writeRdata(w, t, r.data);
    }
  }
  return w.out();
}

export let typeNum = (t) => (typeof t === 'number' ? t : TYPES[String(t).toUpperCase()] ?? Number(t));

function readName(b, off) {
  let labels = [];
  let jumped = false;
  let end = off;
  for (let guard = 0; guard < 128; guard++) {
    if (off >= b.length) throw new Error('truncated name');
    let len = b[off];
    if (len === 0) {
      if (!jumped) end = off + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | b[off + 1];
      jumped = true;
      continue;
    }
    labels.push(dec.decode(b.subarray(off + 1, off + 1 + len)));
    off += 1 + len;
  }
  return { name: labels.join('.'), next: end };
}

export function decodeMessage(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12) throw new Error('short DNS message');
  let u16 = (o) => (b[o] << 8) | b[o + 1];
  let u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  let flags = u16(2);
  let m = {
    id: u16(0),
    qr: !!(flags & 0x8000),
    opcode: (flags >> 11) & 15,
    aa: !!(flags & 0x400),
    tc: !!(flags & 0x200),
    rd: !!(flags & 0x100),
    ra: !!(flags & 0x80),
    rcode: flags & 15,
    questions: [],
    answers: [],
    authorities: [],
    additionals: [],
  };
  let counts = [u16(4), u16(6), u16(8), u16(10)];
  let off = 12;
  for (let i = 0; i < counts[0]; i++) {
    let { name, next } = readName(b, off);
    m.questions.push({ name, type: u16(next), class: u16(next + 2) });
    off = next + 4;
  }
  for (let [si, key] of [[1, 'answers'], [2, 'authorities'], [3, 'additionals']]) {
    for (let i = 0; i < counts[si]; i++) {
      let { name, next } = readName(b, off);
      let type = u16(next);
      let cls = u16(next + 2);
      let ttl = u32(next + 4);
      let rdlen = u16(next + 8);
      let rd = next + 10;
      let data;
      switch (type) {
        case TYPES.A:
          data = intToIp(u32(rd));
          break;
        case TYPES.NS:
        case TYPES.CNAME:
        case TYPES.PTR:
          data = readName(b, rd).name;
          break;
        case TYPES.MX:
          data = { preference: u16(rd), exchange: readName(b, rd + 2).name };
          break;
        case TYPES.TXT: {
          data = [];
          let o = rd;
          while (o < rd + rdlen) {
            let l = b[o];
            data.push(dec.decode(b.subarray(o + 1, o + 1 + l)));
            o += 1 + l;
          }
          break;
        }
        case TYPES.SOA: {
          let a = readName(b, rd);
          let r = readName(b, a.next);
          let o = r.next;
          data = { mname: a.name, rname: r.name, serial: u32(o), refresh: u32(o + 4), retry: u32(o + 8), expire: u32(o + 12), minimum: u32(o + 16) };
          break;
        }
        case TYPES.SRV:
          data = { priority: u16(rd), weight: u16(rd + 2), port: u16(rd + 4), target: readName(b, rd + 6).name };
          break;
        default:
          data = b.slice(rd, rd + rdlen);
      }
      m[key].push({ name, type, class: cls, ttl, data });
      off = rd + rdlen;
    }
  }
  return m;
}

/** Record data as zone-file / dig text. */
export function rdataText(r) {
  let t = typeNum(r.type);
  let d = r.data;
  switch (t) {
    case TYPES.NS:
    case TYPES.CNAME:
    case TYPES.PTR:
      return normName(d) + '.';
    case TYPES.MX:
      return `${d.preference} ${normName(d.exchange)}.`;
    case TYPES.TXT:
      return (Array.isArray(d) ? d : [d]).map((s) => JSON.stringify(String(s))).join(' ');
    case TYPES.SOA:
      return `${normName(d.mname)}. ${normName(d.rname)}. ${d.serial} ${d.refresh} ${d.retry} ${d.expire} ${d.minimum}`;
    case TYPES.SRV:
      return `${d.priority} ${d.weight} ${d.port} ${normName(d.target)}.`;
    default:
      return d instanceof Uint8Array ? `\\# ${d.length}` : String(d);
  }
}

/** "4.3.2.1.in-addr.arpa" for 1.2.3.4. */
export let reverseName = (ip) => String(ip).split('.').reverse().join('.') + '.in-addr.arpa';

/**
 * Parse a BIND-style zone file (the common subset: $ORIGIN, $TTL, @, relative
 * names, ( ) continuation, ; comments, A NS CNAME MX TXT SOA PTR SRV).
 * @returns {{ origin: string, ttl: number, records: Array<{name,type,ttl,data}> }}
 */
export function parseZone(text, origin) {
  let ttl = 3600;
  let records = [];
  let last = origin;
  let lines = [];
  let buf = '';
  let depth = 0;
  for (let raw of String(text).split('\n')) {
    let line = raw.replace(/;.*$/, '');
    for (let ch of line) depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    buf += ' ' + line.replace(/[()]/g, ' ');
    if (depth <= 0) {
      lines.push({ text: buf, indented: /^\s/.test(raw) && buf.trim() !== '' });
      buf = '';
      depth = 0;
    }
  }
  let abs = (n) => {
    if (n === '@') return normName(origin);
    if (n.endsWith('.')) return normName(n);
    return normName(origin ? `${n}.${origin}` : n);
  };
  for (let { text: line, indented } of lines) {
    let words = line.match(/"(?:[^"\\]|\\.)*"|\S+/g);
    if (!words) continue;
    if (words[0] === '$ORIGIN') {
      origin = normName(words[1]);
      continue;
    }
    if (words[0] === '$TTL') {
      ttl = Number(words[1]) || ttl;
      continue;
    }
    let name = last;
    if (!indented) {
      name = abs(words.shift());
      last = name;
    }
    let rttl = ttl;
    while (words.length && (/^\d+$/.test(words[0]) || words[0] === 'IN')) {
      let w = words.shift();
      if (w !== 'IN') rttl = Number(w);
    }
    let type = String(words.shift() || '').toUpperCase();
    if (!TYPES[type]) continue;
    let data;
    switch (type) {
      case 'A':
        data = words[0];
        break;
      case 'NS':
      case 'CNAME':
      case 'PTR':
        data = abs(words[0]);
        break;
      case 'MX':
        data = { preference: Number(words[0]), exchange: abs(words[1]) };
        break;
      case 'TXT':
        data = words.map((w) => (w.startsWith('"') ? JSON.parse(w) : w));
        break;
      case 'SOA':
        data = { mname: abs(words[0]), rname: abs(words[1]), serial: Number(words[2]), refresh: Number(words[3]), retry: Number(words[4]), expire: Number(words[5]), minimum: Number(words[6]) };
        break;
      case 'SRV':
        data = { priority: Number(words[0]), weight: Number(words[1]), port: Number(words[2]), target: abs(words[3]) };
        break;
      default:
        continue;
    }
    records.push({ name, type: TYPES[type], ttl: rttl, data });
  }
  return { origin: normName(origin), ttl, records };
}
