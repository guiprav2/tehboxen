/**
 * An IPv4 network stack: one per box (in its kernel) and one per JS router.
 *
 * Packets are plain objects that the fabric (other/net/fabric.js) carries
 * between interfaces:
 *   { src, dst, ttl, proto: 'tcp'|'udp'|'icmp', sport, dport,
 *     flags ('S', 'SA', 'A', 'PA', 'F', 'FA', 'R', 'RA'), data: Uint8Array,
 *     icmp: { type, code, id, seq, data, orig }, len, ipid }
 * The fabric is lossless and ordered, so TCP keeps its handshake, FIN/RST
 * semantics and states (what ss, tcpdump, conntrack and firewalls see) but
 * no sequence numbers, windows or retransmissions.
 *
 * L2 is reduced to "which interface on this segment owns the next-hop IP"
 * (the fabric's job), so there's no ARP; broadcasts reach the whole segment.
 *
 * Sockets: TCP listeners/connections, UDP sockets and ICMP echo, with both
 * event (node `net`/`dgram`) and pull (WASI recv/accept/poll) interfaces.
 */
import { Netfilter, ctPorts } from './netfilter.js';
import { toBytes, fromBytes, ethFrame, parseEth, arpBytes, parseArp, BROADCAST_MAC } from './wire.js';
import { broadcastOf, inSubnet, ipToInt, isLoopback, maskOf, randomMac } from './ip.js';

export let ERRNO = {
  EPERM: 1, EINTR: 4, EBADF: 9, EAGAIN: 11, EACCES: 13, EFAULT: 14, EBUSY: 16, EINVAL: 22, EMFILE: 24, EPIPE: 32,
  ENOTSOCK: 88, EDESTADDRREQ: 89, EMSGSIZE: 90, EPROTOTYPE: 91, ENOPROTOOPT: 92, EPROTONOSUPPORT: 93, EOPNOTSUPP: 95,
  EAFNOSUPPORT: 97, EADDRINUSE: 98, EADDRNOTAVAIL: 99, ENETDOWN: 100, ENETUNREACH: 101, ECONNABORTED: 103,
  ECONNRESET: 104, ENOBUFS: 105, EISCONN: 106, ENOTCONN: 107, ETIMEDOUT: 110, ECONNREFUSED: 111, EHOSTDOWN: 112,
  EHOSTUNREACH: 113, EALREADY: 114, EINPROGRESS: 115,
};
let STRERROR = {
  EACCES: 'Permission denied', EADDRINUSE: 'Address already in use', EADDRNOTAVAIL: 'Cannot assign requested address',
  ECONNREFUSED: 'Connection refused', ECONNRESET: 'Connection reset by peer', ETIMEDOUT: 'Connection timed out',
  EHOSTUNREACH: 'No route to host', ENETUNREACH: 'Network is unreachable', ENOTCONN: 'Transport endpoint is not connected',
  EPIPE: 'Broken pipe', EINVAL: 'Invalid argument', EISCONN: 'Transport endpoint is already connected', EAGAIN: 'Resource temporarily unavailable',
  EMSGSIZE: 'Message too long', ENETDOWN: 'Network is down', EBADF: 'Bad file descriptor', ENOTSOCK: 'Socket operation on non-socket',
  EOPNOTSUPP: 'Operation not supported', EAFNOSUPPORT: 'Address family not supported by protocol', EINPROGRESS: 'Operation now in progress',
  EALREADY: 'Operation already in progress', ECONNABORTED: 'Software caused connection abort', EPERM: 'Operation not permitted',
};

/** Node-style network error (crosses workers as a plain object). */
export function netError(code, syscall, address, port) {
  let where = address != null ? ` ${address}${port != null ? ':' + port : ''}` : '';
  return { __syserr: true, code, errno: -(ERRNO[code] || 5), syscall, address, port, message: `${syscall} ${code}${where}`, strerror: STRERROR[code] || code };
}

class Emitter {
  constructor() {
    this._ev = new Map();
  }
  on(ev, fn) {
    if (!this._ev.has(ev)) this._ev.set(ev, new Set());
    this._ev.get(ev).add(fn);
    return () => this._ev.get(ev)?.delete(fn);
  }
  emit(ev, ...args) {
    for (let fn of [...(this._ev.get(ev) || [])]) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

let EPHEMERAL = [32768, 60999];
let SEGMENT = 65536;
let enc = new TextEncoder();

function headerLen(pkt) {
  return 20 + (pkt.proto === 'tcp' ? 20 : 8) + (pkt.data?.length || 0) + (pkt.icmp?.data?.length || 0);
}

/** A copy safe to mutate (NAT) without touching the sender's object. */
function clonePkt(p) {
  return { ...p, icmp: p.icmp ? { ...p.icmp, orig: p.icmp.orig ? { ...p.icmp.orig } : undefined } : undefined };
}

/* ---------- TCP ---------- */

export class TcpConn extends Emitter {
  constructor(stack, local, remote, state) {
    super();
    this.stack = stack;
    this.local = local; // { addr, port }
    this.remote = remote;
    this.state = state;
    this.rx = []; // Uint8Array chunks
    this.rxBytes = 0;
    this.eof = false;
    this.error = null;
    this.waiters = new Set(); // poll/read waiters: () => void
    this.writable = true;
    this.owner = null; // { pid, comm, uid }
    this.created = Date.now();
    this.txBytes = 0;
    this.rxTotal = 0;
    // Sequence space (what captures and scanners see): random ISN, next to send / expect.
    this.sndNxt = (Math.random() * 0x100000000) >>> 0;
    this.rcvNxt = 0;
  }

  get key() {
    return connKey(this.local.addr, this.local.port, this.remote.addr, this.remote.port);
  }

  _wake() {
    for (let w of [...this.waiters]) w();
  }

  _send(flags, data) {
    let pkt = { src: this.local.addr, dst: this.remote.addr, proto: 'tcp', sport: this.local.port, dport: this.remote.port, flags, data: data || null, seq: this.sndNxt, ack: flags.includes('A') ? this.rcvNxt : 0, win: 64240 };
    if (flags.includes('S')) pkt.tcpOpts = MSS_OPT;
    this.sndNxt = (this.sndNxt + (data?.length || 0) + (flags.includes('S') ? 1 : 0) + (flags.includes('F') ? 1 : 0)) >>> 0;
    this.stack.output(pkt);
  }

  _onSegment(pkt) {
    let f = pkt.flags || '';
    if (f.includes('R')) {
      if (this.state === 'SYN_SENT') this._fail(netError('ECONNREFUSED', 'connect', this.remote.addr, this.remote.port));
      else if (this.state !== 'CLOSED' && this.state !== 'TIME_WAIT') this._fail(netError('ECONNRESET', 'read'));
      return;
    }
    // Lossless, in-order fabric: just follow the peer's sequence space.
    if (pkt.seq != null) this.rcvNxt = (pkt.seq + (pkt.data?.length || 0) + (f.includes('S') ? 1 : 0) + (f.includes('F') ? 1 : 0)) >>> 0;
    if (this.state === 'SYN_SENT') {
      if (f === 'SA') {
        this.state = 'ESTABLISHED';
        this._send('A');
        this.emit('connect');
        this._wake();
      }
      return;
    }
    if (this.state === 'SYN_RECV') {
      if (f.includes('A') && !f.includes('S')) {
        this.state = 'ESTABLISHED';
        this.listener?._established(this);
      }
      if (!pkt.data?.length && !f.includes('F')) return;
    }
    if (pkt.data?.length) {
      if (this.appClosed) {
        // Data for a socket the application closed: RST, like Linux.
        this._send('R');
        this._closeNow();
        return;
      }
      this.rx.push(pkt.data);
      this.rxBytes += pkt.data.length;
      this.rxTotal += pkt.data.length;
      this.emit('data', pkt.data);
      this._wake();
    }
    if (f.includes('F')) {
      if (this.state === 'ESTABLISHED' || this.state === 'SYN_RECV') this.state = 'CLOSE_WAIT';
      else if (this.state === 'FIN_WAIT1' || this.state === 'FIN_WAIT2') this._timeWait();
      this._send('A');
      if (!this.eof) {
        this.eof = true;
        this.emit('end');
      }
      this._wake();
      if (this.state === 'CLOSE_WAIT' && this.appClosed) this.end();
    } else if (f === 'A' && this.state === 'FIN_WAIT1') this.state = 'FIN_WAIT2';
    else if (f === 'A' && this.state === 'LAST_ACK') this._closeNow();
  }

  _fail(err) {
    if (this.state === 'CLOSED') return;
    this.error = err;
    this.state = 'CLOSED';
    this.eof = true;
    this.writable = false;
    this.stack._dropConn(this);
    this.emit('error', err);
    this.emit('close', true);
    this._wake();
  }

  _timeWait() {
    this.state = 'TIME_WAIT';
    setTimeout(() => this._closeNow(), 2000);
  }

  _closeNow() {
    if (this.state === 'CLOSED') return;
    this.state = 'CLOSED';
    this.writable = false;
    this.stack._dropConn(this);
    this.emit('close', false);
    this._wake();
  }

  /** Queue bytes; returns the count (never blocks: the fabric has no windows). */
  write(bytes) {
    if (!this.writable || this.error) throw this.error || netError('EPIPE', 'write');
    if (this.state === 'SYN_SENT' || this.state === 'SYN_RECV') throw netError('ENOTCONN', 'write');
    let b = typeof bytes === 'string' ? enc.encode(bytes) : bytes;
    for (let i = 0; i < b.length; i += SEGMENT) this._send('PA', b.slice(i, i + SEGMENT));
    this.txBytes += b.length;
    return b.length;
  }

  /** Half-close (shutdown SHUT_WR): FIN. */
  end() {
    if (!this.writable) return;
    this.writable = false;
    if (this.state === 'ESTABLISHED' || this.state === 'SYN_RECV') {
      this.state = 'FIN_WAIT1';
      this._send('FA');
    } else if (this.state === 'CLOSE_WAIT') {
      this.state = 'LAST_ACK';
      this._send('FA');
    } else if (this.state === 'SYN_SENT') this._closeNow();
  }

  /** Application close: FIN if still open; later data gets an RST. */
  close() {
    this.appClosed = true;
    this.rx = [];
    this.rxBytes = 0;
    if (this.state === 'SYN_SENT') return this._closeNow();
    this.end();
  }

  /** Abortive close (SO_LINGER 0 / destroy with error): RST. */
  reset() {
    if (this.state !== 'CLOSED' && this.state !== 'SYN_SENT') this._send('RA');
    this.appClosed = true;
    this._closeNow();
  }

  /** Take up to max bytes now: Uint8Array, empty array at EOF, or null if nothing yet. */
  take(max = Infinity) {
    if (this.rxBytes) {
      let out = [];
      let n = 0;
      while (this.rx.length && n < max) {
        let c = this.rx[0];
        if (n + c.length <= max) {
          out.push(c);
          n += c.length;
          this.rx.shift();
        } else {
          let k = max - n;
          out.push(c.subarray(0, k));
          this.rx[0] = c.subarray(k);
          n += k;
        }
      }
      this.rxBytes -= n;
      if (out.length === 1) return out[0];
      let all = new Uint8Array(n);
      let o = 0;
      for (let c of out) {
        all.set(c, o);
        o += c.length;
      }
      return all;
    }
    if (this.error && this.error.code !== 'ECONNREFUSED') throw this.error;
    if (this.eof || this.state === 'CLOSED') return new Uint8Array(0);
    return null;
  }

  /** Blocking read: resolves with bytes (empty at EOF). */
  read(max = 65536, { timeout = -1 } = {}) {
    let got = this.take(max);
    if (got) return Promise.resolve(got);
    return new Promise((resolve, reject) => {
      let timer = null;
      let w = () => {
        try {
          let g = this.take(max);
          if (!g) return;
          done();
          resolve(g);
        } catch (err) {
          done();
          reject(err);
        }
      };
      let done = () => {
        this.waiters.delete(w);
        if (timer) clearTimeout(timer);
      };
      this.waiters.add(w);
      if (timeout >= 0) timer = setTimeout(() => (done(), reject(netError('EAGAIN', 'recv'))), timeout);
    });
  }

  /** Poll flags: { in, out, hup, err }. */
  poll() {
    return {
      in: this.rxBytes > 0 || this.eof || this.state === 'CLOSED',
      out: this.writable && (this.state === 'ESTABLISHED' || this.state === 'CLOSE_WAIT'),
      hup: this.state === 'CLOSED' || (this.eof && !this.writable),
      err: !!this.error,
    };
  }
}

let connKey = (la, lp, ra, rp) => `${la}:${lp}>${ra}:${rp}`;
let MSS_OPT = new Uint8Array([2, 4, 0x05, 0xb4]); // MSS 1460

/** The RST a host answers an unexpected segment with (RFC 793, like Linux). */
function rstFor(pkt) {
  let f = pkt.flags || '';
  if (f.includes('A')) return { src: pkt.dst, dst: pkt.src, proto: 'tcp', sport: pkt.dport, dport: pkt.sport, flags: 'R', seq: pkt.ack >>> 0, ack: 0, win: 0, data: null };
  let len = (pkt.data?.length || 0) + (f.includes('S') ? 1 : 0) + (f.includes('F') ? 1 : 0);
  return { src: pkt.dst, dst: pkt.src, proto: 'tcp', sport: pkt.dport, dport: pkt.sport, flags: 'RA', seq: 0, ack: ((pkt.seq >>> 0) + len) >>> 0, win: 0, data: null };
}

export class TcpListener extends Emitter {
  constructor(stack, addr, port, backlog) {
    super();
    this.stack = stack;
    this.local = { addr, port };
    this.backlog = backlog;
    this.queue = []; // established, not yet accepted
    this.waiters = new Set();
    this.closed = false;
    this.owner = null;
  }

  _established(conn) {
    if (this.closed) return conn.reset();
    this.queue.push(conn);
    this.emit('connection', conn);
    for (let w of [...this.waiters]) w();
  }

  /** Next connection now, or null. Node-style listeners get them via 'connection' instead. */
  take() {
    return this.queue.shift() || null;
  }

  accept({ timeout = -1 } = {}) {
    let c = this.take();
    if (c) return Promise.resolve(c);
    if (this.closed) return Promise.reject(netError('EINVAL', 'accept'));
    return new Promise((resolve, reject) => {
      let timer = null;
      let w = () => {
        if (this.closed) {
          done();
          return reject(netError('EINVAL', 'accept'));
        }
        let c = this.take();
        if (!c) return;
        done();
        resolve(c);
      };
      let done = () => {
        this.waiters.delete(w);
        if (timer) clearTimeout(timer);
      };
      this.waiters.add(w);
      if (timeout >= 0) timer = setTimeout(() => (done(), reject(netError('EAGAIN', 'accept'))), timeout);
    });
  }

  poll() {
    return { in: this.queue.length > 0 || this.closed, out: false, hup: this.closed, err: false };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stack.listeners.delete(listenKey(this.local.addr, this.local.port));
    for (let c of this.queue) c.reset();
    this.queue = [];
    for (let w of [...this.waiters]) w();
    this.emit('close');
  }
}

let listenKey = (addr, port) => `${addr}:${port}`;

/* ---------- UDP ---------- */

export class UdpSocket extends Emitter {
  constructor(stack, addr, port) {
    super();
    this.stack = stack;
    this.local = { addr, port };
    this.remote = null; // connect()ed peer
    this.queue = []; // { data, from: { addr, port } }
    this.waiters = new Set();
    this.closed = false;
    this.broadcast = false;
    this.device = null; // SO_BINDTODEVICE
    this.error = null; // pending ICMP error (connected sockets)
    this.owner = null;
  }

  _deliver(pkt) {
    if (this.remote && (pkt.src !== this.remote.addr || pkt.sport !== this.remote.port)) return;
    let msg = { data: pkt.data || new Uint8Array(0), from: { addr: pkt.src, port: pkt.sport } };
    this.queue.push(msg);
    if (this.queue.length > 1024) this.queue.shift();
    this.emit('message', msg.data, msg.from);
    for (let w of [...this.waiters]) w();
  }

  connect(addr, port) {
    this.remote = addr == null ? null : { addr, port: Number(port) };
    if (this.remote && this.local.addr === '0.0.0.0') {
      let r = this.stack.route(addr, { dev: this.device });
      if (r) this.local.addr = r.src;
    }
  }

  send(data, to) {
    if (this.closed) throw netError('EBADF', 'send');
    let dst = to || this.remote;
    if (!dst) throw netError('EDESTADDRREQ', 'send');
    let b = typeof data === 'string' ? enc.encode(data) : data;
    if (b.length > 65507) throw netError('EMSGSIZE', 'sendto');
    let bcast = dst.addr === '255.255.255.255' || this.stack.isBroadcastAddr(dst.addr);
    if (bcast && !this.broadcast) throw netError('EACCES', 'sendto', dst.addr, dst.port);
    let src = this.local.addr;
    if (src === '0.0.0.0' || bcast) {
      let r = bcast ? this.stack.broadcastRoute(dst.addr, this.device) : this.stack.route(dst.addr, { dev: this.device });
      if (!r) throw netError('ENETUNREACH', 'sendto', dst.addr, dst.port);
      src = this.local.addr !== '0.0.0.0' ? this.local.addr : r.src;
    }
    let pkt = { src, dst: dst.addr, proto: 'udp', sport: this.local.port, dport: Number(dst.port), data: b };
    if (this.ttl) pkt.ttl = this.ttl;
    this.stack.output(pkt, { dev: this.device || undefined });
    return b.length;
  }

  take() {
    if (this.error) {
      let e = this.error;
      this.error = null;
      throw e;
    }
    return this.queue.shift() || null;
  }

  recv({ timeout = -1 } = {}) {
    let m = this.take();
    if (m) return Promise.resolve(m);
    if (this.closed) return Promise.reject(netError('EBADF', 'recvfrom'));
    return new Promise((resolve, reject) => {
      let timer = null;
      let w = () => {
        try {
          let m = this.take();
          if (!m && !this.closed) return;
          done();
          m ? resolve(m) : reject(netError('EBADF', 'recvfrom'));
        } catch (err) {
          done();
          reject(err);
        }
      };
      let done = () => {
        this.waiters.delete(w);
        if (timer) clearTimeout(timer);
      };
      this.waiters.add(w);
      if (timeout >= 0) timer = setTimeout(() => (done(), reject(netError('EAGAIN', 'recvfrom'))), timeout);
    });
  }

  poll() {
    return { in: this.queue.length > 0 || !!this.error || this.closed, out: !this.closed, hup: this.closed, err: !!this.error };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stack.udp.delete(this);
    for (let w of [...this.waiters]) w();
    this.emit('close');
  }
}

/* ---------- raw ICMP ---------- */

let csum = (b, o = 0, n = b.length - o) => {
  let sum = 0;
  for (let i = 0; i < n - 1; i += 2) sum += (b[o + i] << 8) | b[o + i + 1];
  if (n & 1) sum += b[o + n - 1] << 8;
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16);
  return ~sum & 0xffff;
};
let put16 = (b, o, v) => ((b[o] = (v >> 8) & 255), (b[o + 1] = v & 255));
let putIp = (b, o, ip) => String(ip).split('.').forEach((x, i) => (b[o + i] = Number(x)));
function ipHeader(b, o, { src, dst, ttl = 64, proto = 1, len, id = 0 }) {
  b[o] = 0x45;
  put16(b, o + 2, len);
  put16(b, o + 4, id);
  put16(b, o + 6, 0x4000);
  b[o + 8] = ttl;
  b[o + 9] = proto;
  putIp(b, o + 12, src);
  putIp(b, o + 16, dst);
  put16(b, o + 10, csum(b, o, 20));
}

/** An ICMP packet as a raw socket reads it: IPv4 header + ICMP message (errors quote the original). */
export let icmpBytes = (pkt) => toBytes(pkt);

/**
 * Raw IP socket (SOCK_RAW): receives copies of every local IPv4 datagram of its protocol
 * (header included); sends either a payload the kernel wraps (ICMP message, TCP/UDP
 * segment) or, with IP_HDRINCL / IPPROTO_RAW, a whole datagram as given (spoofing included).
 */
export class RawIpSocket extends Emitter {
  constructor(stack, proto = 'icmp', hdrincl = false) {
    super();
    this.stack = stack;
    this.proto = proto; // 'icmp' | 'tcp' | 'udp' | 'raw'
    this.hdrincl = hdrincl || proto === 'raw';
    this.local = { addr: '0.0.0.0', port: 0 };
    this.remote = null;
    this.queue = [];
    this.waiters = new Set();
    this.closed = false;
    this.ttl = null;
    this.owner = null;
  }
  _deliver(pkt) {
    let msg = { data: toBytes(pkt), from: { addr: pkt.src, port: 0 } };
    this.queue.push(msg);
    if (this.queue.length > 1024) this.queue.shift();
    this.emit('message', msg.data, msg.from);
    for (let w of [...this.waiters]) w();
  }
  send(bytes, to) {
    let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let dst = to || this.remote;
    let pkt;
    if (this.hdrincl) {
      pkt = fromBytes(b);
      if (!pkt) throw netError('EINVAL', 'sendto');
      if (dst?.addr && dst.addr !== '0.0.0.0') pkt.dst = pkt.dst === '0.0.0.0' ? dst.addr : pkt.dst;
      pkt.keepIpid = !!pkt.ipid;
    } else {
      if (!dst) throw netError('EDESTADDRREQ', 'sendto');
      let r = this.stack.route(dst.addr);
      if (!r) throw netError('ENETUNREACH', 'sendto', dst.addr);
      // Wrap the payload in a kernel IP header, then read it back as a packet.
      let hdr = toBytes({ src: r.src, dst: dst.addr, proto: this.proto === 'raw' ? 'udp' : this.proto, icmp: { type: 0 }, data: new Uint8Array(0) }).subarray(0, 20);
      let ip = new Uint8Array(20 + b.length);
      ip.set(hdr);
      ip[2] = ip.length >> 8;
      ip[3] = ip.length & 255;
      ip.set(b, 20);
      pkt = fromBytes(ip);
      if (!pkt) throw netError('EINVAL', 'sendto');
    }
    if (!pkt.src || pkt.src === '0.0.0.0') pkt.src = this.stack.route(pkt.dst)?.src || '0.0.0.0';
    if (this.ttl && !this.hdrincl) pkt.ttl = this.ttl;
    this.stack.output(pkt, { raw: true });
    return b.length;
  }
  connect(addr) {
    this.remote = addr == null ? null : { addr, port: 0 };
  }
  take() {
    return this.queue.shift() || null;
  }
  recv(opts) {
    return UdpSocket.prototype.recv.call(this, opts);
  }
  poll() {
    return { in: this.queue.length > 0 || this.closed, out: !this.closed, hup: this.closed, err: false };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stack.rawSockets.delete(this);
    for (let w of [...this.waiters]) w();
  }
}
export { RawIpSocket as RawIcmpSocket };

/**
 * AF_PACKET socket: every frame in or out of an interface (or all of them), as Ethernet
 * frames (SOCK_RAW) or bare IP datagrams (SOCK_DGRAM, "cooked"). Sending injects a frame
 * straight onto the wire: no routing, no netfilter, like Linux.
 */
export class PacketSocket extends Emitter {
  constructor(stack, { cooked = false, ethertype = 0x0003 } = {}) {
    super();
    this.stack = stack;
    this.cooked = cooked;
    this.ethertype = ethertype; // 0x0003 = ETH_P_ALL
    this.ifname = null; // bound interface (null: all)
    this.local = { addr: '0.0.0.0', port: 0 };
    this.remote = null;
    this.queue = [];
    this.waiters = new Set();
    this.closed = false;
    this.owner = null;
  }
  /** frame: Ethernet bytes; meta: { ifname, pkttype (0 host, 1 broadcast, 3 other host, 4 outgoing), type, srcMac } */
  _deliver(frame, meta) {
    if (this.ifname && meta.ifname !== this.ifname) return;
    if (this.ethertype !== 0x0003 && this.ethertype !== meta.type) return;
    let data = this.cooked ? frame.subarray(14) : frame;
    let msg = { data: data.slice(), from: { addr: '0.0.0.0', port: 0 }, ll: { ifindex: this.stack.ifIndex(meta.ifname), proto: meta.type, pkttype: meta.pkttype, mac: meta.srcMac } };
    this.queue.push(msg);
    if (this.queue.length > 4096) this.queue.shift();
    this.emit('message', msg.data, msg.from);
    for (let w of [...this.waiters]) w();
  }
  /** Inject: a whole Ethernet frame (SOCK_RAW), or a payload for { ifname, mac, proto } (SOCK_DGRAM). */
  send(bytes, to = {}) {
    let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let ifname = to.ifname || this.ifname;
    if (!ifname || !this.stack.ifaces.get(ifname)) throw netError('ENXIO', 'sendto');
    let iface = this.stack.ifaces.get(ifname);
    let frame = this.cooked ? ethFrame(to.mac || BROADCAST_MAC, iface.mac, to.proto || this.ethertype, b) : b;
    let eth = parseEth(frame);
    if (!eth) throw netError('EINVAL', 'sendto');
    this.stack.injectFrame(ifname, eth, frame);
    return b.length;
  }
  bind(ifname, ethertype) {
    this.ifname = ifname || null;
    if (ethertype) this.ethertype = ethertype;
  }
  take() {
    return this.queue.shift() || null;
  }
  recv(opts) {
    return UdpSocket.prototype.recv.call(this, opts);
  }
  poll() {
    return { in: this.queue.length > 0 || this.closed, out: !this.closed, hup: this.closed, err: false };
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.stack.packetSockets.delete(this);
    for (let w of [...this.waiters]) w();
  }
}

/* ---------- the stack ---------- */

export class Stack extends Emitter {
  /**
   * @param {object} o
   * @param {string} o.hostname
   * @param {(ifname: string, nextHop: string, pkt: object) => void} o.transmit hand a packet to the fabric
   * @param {boolean} [o.forwarding] ip_forward
   */
  constructor({ hostname = 'localhost', transmit, forwarding = false, log } = {}) {
    super();
    this.hostname = hostname;
    this.transmit = transmit || (() => {});
    this.log = log || (() => {});
    this.sysctl = { 'net.ipv4.ip_forward': forwarding ? 1 : 0, 'net.ipv4.icmp_echo_ignore_all': 0, 'net.ipv4.ip_default_ttl': 64 };
    this.ifaces = new Map();
    this.routes = [];
    this.nf = new Netfilter();
    this.listeners = new Map(); // "addr:port" → TcpListener
    this.conns = new Map(); // connKey → TcpConn
    this.udp = new Set();
    this.pings = new Map(); // "id:seq" → { resolve, reject, timer }
    this.rawSockets = new Set(); // RawIpSocket: copies of local datagrams of their protocol
    this.packetSockets = new Set(); // PacketSocket: every frame on the interfaces
    this.neighbors = new Map(); // "ifname ip" → { mac, at } (the ARP cache: ip neigh, /proc/net/arp)
    // Next-hop MAC for captures and injection; the fabric provides it (page) or pushes tables (boxes).
    this.macOf = () => null;
    this.transmitFrame = () => {}; // (ifname, dstMac, frameKind, payload) → fabric
    this.taps = new Set(); // (ifname, dir 'in'|'out', pkt) => void
    this.ipid = Math.floor(Math.random() * 65535);
    // While a box boots, packets for services that aren't listening yet are
    // dropped rather than refused, so clients' retransmissions find them.
    this.bootGraceUntil = 0;
    this.addIface('lo', { mac: '00:00:00:00:00:00', addrs: [{ ip: '127.0.0.1', prefix: 8 }], up: true, loopback: true });
  }

  get forwarding() {
    return !!Number(this.sysctl['net.ipv4.ip_forward']);
  }

  /* ----- interfaces / addresses / routes ----- */

  addIface(name, { mac = randomMac(), addrs = [], up = true, segment = null, loopback = false, mtu } = {}) {
    let iface = { name, mac, addrs: [], up, segment, loopback, mtu: mtu || (loopback ? 65536 : 1500), stats: { rxPackets: 0, rxBytes: 0, txPackets: 0, txBytes: 0, rxDropped: 0, txDropped: 0 } };
    this.ifaces.set(name, iface);
    for (let a of addrs) this.addAddr(name, a.ip, a.prefix);
    this.emit('change');
    return iface;
  }

  removeIface(name) {
    this.ifaces.delete(name);
    this.routes = this.routes.filter((r) => r.dev !== name);
    this.emit('change');
  }

  addAddr(ifname, ip, prefix, { proto = 'kernel' } = {}) {
    let iface = this.ifaces.get(ifname);
    if (!iface) throw netError('ENODEV', 'ioctl');
    if (iface.addrs.some((a) => a.ip === ip && a.prefix === prefix)) throw Object.assign(netError('EEXIST', 'ioctl'), { message: 'RTNETLINK answers: File exists' });
    iface.addrs.push({ ip, prefix: Number(prefix), proto });
    if (!iface.loopback) {
      let net = { dst: intToNet(ip, prefix), prefix: Number(prefix), via: null, dev: ifname, src: ip, proto: 'kernel', scope: 'link', metric: 0 };
      if (!this.routes.some((r) => r.dst === net.dst && r.prefix === net.prefix && r.dev === ifname)) this.routes.push(net);
    }
    this.emit('change');
  }

  delAddr(ifname, ip, prefix) {
    let iface = this.ifaces.get(ifname);
    if (!iface) return;
    let before = iface.addrs.length;
    iface.addrs = iface.addrs.filter((a) => !(a.ip === ip && (prefix == null || a.prefix === Number(prefix))));
    if (iface.addrs.length === before) throw Object.assign(netError('EADDRNOTAVAIL', 'ioctl'), { message: 'RTNETLINK answers: Cannot assign requested address' });
    this.routes = this.routes.filter((r) => !(r.dev === ifname && r.proto === 'kernel' && r.src === ip));
    this.emit('change');
  }

  flushAddrs(ifname) {
    let iface = this.ifaces.get(ifname);
    if (!iface) return;
    for (let a of [...iface.addrs]) this.delAddr(ifname, a.ip, a.prefix);
  }

  setLink(ifname, up) {
    let iface = this.ifaces.get(ifname);
    if (!iface) throw Object.assign(netError('ENODEV', 'ioctl'), { message: `Cannot find device "${ifname}"` });
    iface.up = !!up;
    this.emit('change');
  }

  addRoute({ dst = '0.0.0.0', prefix = 0, via = null, dev = null, src = null, metric = 0, proto = 'static' }) {
    if (!dev && via) {
      let r = this.route(via, { connectedOnly: true });
      if (!r) throw Object.assign(netError('ENETUNREACH', 'ioctl'), { message: 'Error: Nexthop has invalid gateway.' });
      dev = r.dev;
    }
    if (!dev) throw Object.assign(netError('EINVAL', 'ioctl'), { message: 'Error: Device for nexthop is not up.' });
    let entry = { dst: intToNet(dst, prefix), prefix: Number(prefix), via, dev, src, proto, metric: Number(metric) || 0, scope: via ? 'global' : 'link' };
    if (this.routes.some((r) => r.dst === entry.dst && r.prefix === entry.prefix && r.metric === entry.metric)) throw Object.assign(netError('EEXIST', 'ioctl'), { message: 'RTNETLINK answers: File exists' });
    this.routes.push(entry);
    this.emit('change');
  }

  delRoute({ dst = '0.0.0.0', prefix = 0, via, dev }) {
    let d = intToNet(dst, prefix);
    let i = this.routes.findIndex((r) => r.dst === d && r.prefix === Number(prefix) && (via == null || r.via === via) && (dev == null || r.dev === dev));
    if (i === -1) throw Object.assign(netError('ESRCH', 'ioctl'), { message: 'RTNETLINK answers: No such process' });
    this.routes.splice(i, 1);
    this.emit('change');
  }

  /** All local unicast addresses. */
  localAddrs() {
    let out = [];
    for (let i of this.ifaces.values()) for (let a of i.addrs) out.push(a.ip);
    return out;
  }

  isLocalAddr(ip) {
    if (isLoopback(ip)) return true;
    for (let i of this.ifaces.values()) if (i.addrs.some((a) => a.ip === ip)) return true;
    return false;
  }

  isBroadcastAddr(ip, ifname) {
    if (ip === '255.255.255.255') return true;
    for (let i of this.ifaces.values()) {
      if (ifname && i.name !== ifname) continue;
      if (i.addrs.some((a) => a.prefix < 31 && broadcastOf(a.ip, a.prefix) === ip)) return true;
    }
    return false;
  }

  /** Route lookup: { dev, via, src } or null (longest prefix, then lowest metric). */
  route(dst, { dev = null, connectedOnly = false } = {}) {
    if (isLoopback(dst) || this.isLocalAddr(dst)) return { dev: 'lo', via: null, src: isLoopback(dst) ? '127.0.0.1' : dst, local: true };
    let best = null;
    for (let r of this.routes) {
      if (dev && r.dev !== dev) continue;
      if (connectedOnly && r.via) continue;
      let iface = this.ifaces.get(r.dev);
      if (!iface?.up) continue;
      if (!inSubnet(dst, r.dst, r.prefix)) continue;
      if (!best || r.prefix > best.prefix || (r.prefix === best.prefix && r.metric < best.metric)) best = r;
    }
    if (!best) {
      // SO_BINDTODEVICE with no route: on-link through that device.
      if (dev && this.ifaces.get(dev)?.up) return { dev, via: null, src: this.primaryAddr(dev) || '0.0.0.0' };
      return null;
    }
    return { dev: best.dev, via: best.via, src: best.src || this.primaryAddr(best.dev, best.via || dst) || '0.0.0.0' };
  }

  broadcastRoute(dst, dev) {
    let iface = dev ? this.ifaces.get(dev) : [...this.ifaces.values()].find((i) => !i.loopback && i.up && (dst === '255.255.255.255' || i.addrs.some((a) => broadcastOf(a.ip, a.prefix) === dst)));
    if (!iface?.up) return null;
    return { dev: iface.name, via: null, src: this.primaryAddr(iface.name) || '0.0.0.0', broadcast: true };
  }

  primaryAddr(ifname, near) {
    let iface = this.ifaces.get(ifname);
    if (!iface?.addrs.length) return null;
    if (near) {
      let hit = iface.addrs.find((a) => inSubnet(near, a.ip, a.prefix));
      if (hit) return hit.ip;
    }
    return iface.addrs[0].ip;
  }

  /* ----- packet I/O ----- */

  _tap(ifname, dir, pkt, nextHop) {
    for (let t of this.taps) {
      try {
        t(ifname, dir, pkt);
      } catch {}
    }
    if (!this.packetSockets.size) return;
    let iface = this.ifaces.get(ifname);
    let zero = '00:00:00:00:00:00';
    let mine = iface?.loopback ? zero : iface?.mac;
    let other = iface?.loopback ? zero : dir === 'out' ? this.neighborMac(ifname, nextHop || pkt.dst) || zero : pkt.srcMac || zero;
    let bcast = pkt.dst === '255.255.255.255' || this.isBroadcastAddr(pkt.dst, ifname);
    let frame = ethFrame(dir === 'out' ? (bcast ? BROADCAST_MAC : other) : bcast ? BROADCAST_MAC : mine, dir === 'out' ? mine : other, 0x0800, toBytes(pkt));
    this._capture(ifname, frame, { type: 0x0800, pkttype: dir === 'out' ? 4 : bcast ? 1 : 0, srcMac: dir === 'out' ? mine : other });
  }

  /** Locally generated packet (sockets, ICMP replies). */
  output(pkt, { dev } = {}) {
    delete pkt.fwd;
    pkt.ttl ??= Number(this.sysctl['net.ipv4.ip_default_ttl']) || 64;
    if (!pkt.keepIpid) pkt.ipid = this.ipid = (this.ipid + 1) & 0xffff;
    delete pkt.keepIpid;
    pkt.len = headerLen(pkt);
    let bcast = pkt.dst === '255.255.255.255' || this.isBroadcastAddr(pkt.dst);
    let r = bcast ? this.broadcastRoute(pkt.dst, dev) : this.route(pkt.dst, { dev });
    if (!r) {
      this._socketError(pkt, 'ENETUNREACH');
      return false;
    }
    // conntrack + nat OUTPUT
    let { entry, dir, ctstate } = this._track(pkt);
    if (!entry || dir === null) {
      // new: nat OUTPUT may DNAT (REDIRECT / port forwards from the box itself)
      if (entry) {
        let v = this.nf.evaluate('nat', 'OUTPUT', pkt, { in: null, out: r.dev, ctstate });
        if (v.target === 'DNAT' || v.target === 'REDIRECT') {
          this._applyDnat(entry, pkt, v, r.dev);
          r = this.route(pkt.dst, { dev }) || r;
        }
      }
    }
    let v = this.nf.evaluate('filter', 'OUTPUT', pkt, { in: null, out: r.dev, ctstate });
    if (v.target === 'DROP') return false;
    if (v.target === 'REJECT') {
      this._socketError(pkt, 'EPERM');
      return false;
    }
    if (!this._postrouting(pkt, entry, dir, r.dev, ctstate)) return false;
    if (entry) {
      this.nf.conntrack.confirm(entry);
      this.nf.conntrack.touch(entry, dir || 'orig', pkt);
    }
    if (r.local) {
      let lo = this.ifaces.get('lo');
      lo.stats.txPackets++;
      lo.stats.txBytes += pkt.len;
      this._tap('lo', 'out', pkt);
      let copy = clonePkt(pkt);
      queueMicrotask(() => this._input('lo', copy, { fromLocal: true }));
      return true;
    }
    return this._xmit(r.dev, r.via || pkt.dst, pkt, bcast);
  }

  _xmit(ifname, nextHop, pkt, bcast) {
    let iface = this.ifaces.get(ifname);
    if (!iface?.up) return false;
    iface.stats.txPackets++;
    iface.stats.txBytes += pkt.len || 0;
    this._tap(ifname, 'out', pkt, nextHop);
    this.transmit(ifname, bcast ? '255.255.255.255' : nextHop, clonePkt(pkt));
    return true;
  }

  /** Packet from the fabric on an interface. */
  receive(ifname, pkt) {
    let iface = this.ifaces.get(ifname);
    if (!iface?.up) return;
    iface.stats.rxPackets++;
    iface.stats.rxBytes += pkt.len || 0;
    if (pkt.srcMac && pkt.src && iface.addrs.some((a) => inSubnet(pkt.src, a.ip, a.prefix))) this._learn(ifname, pkt.src, pkt.srcMac);
    this._tap(ifname, 'in', pkt);
    this._input(ifname, clonePkt(pkt), {});
  }

  /** conntrack lookup/creation: { entry, dir ('orig'|'reply'|null for new), ctstate }. */
  _track(pkt) {
    let ct = this.nf.conntrack;
    let hit = ct.lookup(pkt);
    if (hit) return { entry: hit.entry, dir: hit.dir, ctstate: hit.dir === 'reply' || hit.entry.seenReply ? 'ESTABLISHED' : 'NEW' };
    if (pkt.proto === 'icmp' && pkt.icmp?.orig && (pkt.icmp.type === 3 || pkt.icmp.type === 11)) {
      // ICMP error about one of our connections: RELATED (and un-NATed below).
      let o = pkt.icmp.orig;
      let inner = ct.lookup({ proto: o.proto, src: o.dst, dst: o.src, sport: o.dport, dport: o.sport, icmp: o.proto === 'icmp' ? { id: o.id } : undefined });
      if (inner) return { entry: null, dir: null, ctstate: 'RELATED', related: inner };
    }
    if (pkt.proto === 'tcp' && pkt.flags && !pkt.flags.includes('S')) return { entry: null, dir: null, ctstate: 'INVALID' };
    if (pkt.proto === 'icmp' && pkt.icmp && pkt.icmp.type !== 8) return { entry: null, dir: null, ctstate: 'INVALID' };
    return { entry: ct.create(pkt), dir: null, ctstate: 'NEW' };
  }

  _applyDnat(entry, pkt, v, inDev) {
    let ip;
    let port;
    if (v.target === 'REDIRECT') {
      ip = inDev === 'lo' || !inDev ? '127.0.0.1' : this.primaryAddr(inDev) || '127.0.0.1';
      port = v.rule.toPorts ? Number(String(v.rule.toPorts).split('-')[0]) : pkt.dport;
    } else {
      let [a, p] = String(v.rule.toDestination).split(':');
      ip = a;
      port = p ? Number(String(p).split('-')[0]) : pkt.dport;
    }
    pkt.dst = ip;
    if (pkt.proto !== 'icmp') pkt.dport = port;
    entry.dnat = { ip, port };
    entry.reply.src = ip;
    if (pkt.proto !== 'icmp') entry.reply.sport = port;
  }

  /** nat POSTROUTING (SNAT/MASQUERADE for new connections, NAT for tracked ones). */
  _postrouting(pkt, entry, dir, outDev, ctstate) {
    if (dir === 'orig' && entry?.snat) {
      pkt.src = entry.snat.ip;
      if (pkt.proto === 'icmp') pkt.icmp.id = entry.snat.port;
      else pkt.sport = entry.snat.port;
      return true;
    }
    if (dir === 'reply' && entry?.dnat) {
      pkt.src = entry.orig.dst;
      if (pkt.proto === 'icmp') pkt.icmp.id = entry.orig.sport;
      else pkt.sport = entry.orig.dport;
      return true;
    }
    if (dir !== null || !entry) return true;
    let v = this.nf.evaluate('nat', 'POSTROUTING', pkt, { in: null, out: outDev, ctstate });
    if (v.target !== 'SNAT' && v.target !== 'MASQUERADE') return true;
    let ip = v.target === 'MASQUERADE' ? this.primaryAddr(outDev, pkt.dst) : String(v.rule.toSource).split(':')[0];
    if (!ip) return false;
    let [sp] = ctPorts(pkt);
    let port = sp;
    let range = v.rule.toPorts || String(v.rule.toSource || '').split(':')[1];
    let [lo, hi] = range ? range.split('-').map(Number) : [1024, 65535];
    let taken = (p) => this.nf.conntrack.replyTaken(pkt.proto, pkt.dst, pkt.proto === 'icmp' ? p : pkt.dport, ip, p);
    if (range ? port < lo || port > (hi || lo) || taken(port) : taken(port)) {
      port = null;
      for (let i = 0; i < 4096; i++) {
        let p = lo + Math.floor(Math.random() * ((hi || lo) - lo + 1));
        if (!taken(p)) {
          port = p;
          break;
        }
      }
      if (port == null) return false;
    }
    pkt.src = ip;
    if (pkt.proto === 'icmp') pkt.icmp.id = port;
    else pkt.sport = port;
    entry.snat = { ip, port };
    entry.reply.dst = ip;
    entry.reply.dport = port;
    return true;
  }

  _input(ifname, pkt, { fromLocal = false }) {
    let t = fromLocal ? this._loopTrack(pkt) : this._track(pkt);
    let { entry, dir, ctstate } = t;
    // PREROUTING: un-NAT replies / RELATED errors, DNAT new connections.
    if (!fromLocal) {
      if (dir === 'orig' && entry.dnat) {
        pkt.dst = entry.dnat.ip;
        if (pkt.proto === 'icmp') pkt.icmp.id = entry.dnat.port;
        else pkt.dport = entry.dnat.port;
      } else if (dir === 'reply' && entry.snat) {
        pkt.dst = entry.orig.src;
        if (pkt.proto === 'icmp') pkt.icmp.id = entry.orig.sport;
        else pkt.dport = entry.orig.sport;
      } else if (t.related) {
        let e = t.related.entry;
        if (e.snat && t.related.dir === 'reply') {
          pkt.dst = e.orig.src;
          let o = pkt.icmp.orig;
          o.src = e.orig.src;
          if (o.proto === 'icmp') o.id = e.orig.sport;
          else o.sport = e.orig.sport;
        }
      } else if (entry && dir === null) {
        let v = this.nf.evaluate('nat', 'PREROUTING', pkt, { in: ifname, out: null, ctstate });
        if (v.target === 'DNAT' || v.target === 'REDIRECT') this._applyDnat(entry, pkt, v, ifname);
      }
    }
    let local = this.isLocalAddr(pkt.dst) || this.isBroadcastAddr(pkt.dst, ifname) || (pkt.proto === 'udp' && pkt.dport === 68 && pkt.dst === '255.255.255.255');
    if (local) {
      let v = this.nf.evaluate('filter', 'INPUT', pkt, { in: ifname, out: null, ctstate });
      if (v.target === 'DROP') return this._drop(ifname);
      if (v.target === 'REJECT') {
        this._reject(pkt, v.rule, ifname);
        return this._drop(ifname);
      }
      if (entry && !fromLocal) {
        this.nf.conntrack.confirm(entry);
        this.nf.conntrack.touch(entry, dir || 'orig', pkt);
      }
      return this._deliver(pkt, ifname);
    }
    if (fromLocal) return;
    if (!this.forwarding) return this._drop(ifname);
    if (pkt.ttl <= 1) {
      this._icmpError(pkt, 11, 0, ifname);
      return this._drop(ifname);
    }
    let r = this.route(pkt.dst);
    if (!r || r.local) {
      this._icmpError(pkt, 3, 0, ifname);
      return this._drop(ifname);
    }
    let v = this.nf.evaluate('filter', 'FORWARD', pkt, { in: ifname, out: r.dev, ctstate });
    if (v.target === 'DROP') return this._drop(ifname);
    if (v.target === 'REJECT') {
      this._reject(pkt, v.rule, ifname);
      return this._drop(ifname);
    }
    pkt.ttl--;
    // Remember the pre-NAT sender: if the next hop doesn't answer, it gets the ICMP error.
    let pre = { src: pkt.src, sport: pkt.sport, id: pkt.icmp?.id, inIf: ifname };
    if (!this._postrouting(pkt, entry, dir, r.dev, ctstate)) return this._drop(ifname);
    pkt.fwd = pre;
    if (entry) {
      this.nf.conntrack.confirm(entry);
      this.nf.conntrack.touch(entry, dir || 'orig', pkt);
    }
    this._xmit(r.dev, r.via || pkt.dst, pkt, false);
  }

  /** Looped-back packets were tracked on output already. */
  _loopTrack(pkt) {
    let hit = this.nf.conntrack.lookup(pkt);
    if (hit) return { entry: hit.entry, dir: hit.dir, ctstate: hit.dir === 'reply' || hit.entry.seenReply ? 'ESTABLISHED' : 'NEW' };
    return { entry: null, dir: null, ctstate: pkt.proto === 'icmp' && pkt.icmp?.type !== 8 ? 'RELATED' : 'NEW' };
  }

  _drop(ifname) {
    let i = this.ifaces.get(ifname);
    if (i) i.stats.rxDropped++;
  }

  _reject(pkt, rule, ifname) {
    let w = rule?.rejectWith || 'icmp-port-unreachable';
    if (w === 'tcp-reset' && pkt.proto === 'tcp') {
      if (!(pkt.flags || '').includes('R')) this.output(rstFor(pkt));
      return;
    }
    let code = { 'icmp-net-unreachable': 0, 'icmp-host-unreachable': 1, 'icmp-proto-unreachable': 2, 'icmp-port-unreachable': 3, 'icmp-net-prohibited': 9, 'icmp-host-prohibited': 10, 'icmp-admin-prohibited': 13 }[w] ?? 3;
    this._icmpError(pkt, 3, code, ifname);
  }

  /** ICMP error about pkt back to its source (never about ICMP errors). */
  _icmpError(pkt, type, code, ifname) {
    if (pkt.proto === 'icmp' && pkt.icmp?.type !== 8 && pkt.icmp?.type !== 0) return;
    if (pkt.dst === '255.255.255.255' || pkt.src === '0.0.0.0') return;
    let src = (ifname && ifname !== 'lo' && this.primaryAddr(ifname, pkt.src)) || this.route(pkt.src)?.src;
    if (!src) return;
    let orig = { proto: pkt.proto, src: pkt.src, dst: pkt.dst, sport: pkt.sport, dport: pkt.dport, id: pkt.icmp?.id, seq: pkt.icmp?.seq, ttl: pkt.ttl };
    this.output({ src, dst: pkt.src, proto: 'icmp', icmp: { type, code, orig } });
  }

  /**
   * The fabric found nobody owning the next hop (no ARP reply): locally
   * originated packets fail with EHOSTUNREACH, forwarded ones get an ICMP
   * host unreachable (traceroute's !H).
   */
  arpFailed(ifname, pkt) {
    if (pkt.fwd) {
      let o = { ...pkt, src: pkt.fwd.src, sport: pkt.fwd.sport, icmp: pkt.icmp ? { ...pkt.icmp, id: pkt.fwd.id } : undefined };
      return this._icmpError(o, 3, 1, pkt.fwd.inIf);
    }
    if (this.isLocalAddr(pkt.src) || pkt.src === '0.0.0.0') this._socketError(pkt, 'EHOSTUNREACH');
    else this._icmpError(pkt, 3, 1, ifname);
  }

  _socketError(pkt, code) {
    if (pkt.proto === 'tcp') {
      let c = this.conns.get(connKey(pkt.src, pkt.sport, pkt.dst, pkt.dport));
      if (c?.state === 'SYN_SENT') queueMicrotask(() => c._fail(netError(code, 'connect', pkt.dst, pkt.dport)));
    } else if (pkt.proto === 'icmp' && pkt.icmp?.type === 8) {
      let p = this.pings.get(`${pkt.icmp.id}:${pkt.icmp.seq}`);
      if (p) queueMicrotask(() => p.error(code));
    }
  }

  /* ----- local delivery ----- */

  _deliver(pkt, ifname) {
    for (let r of this.rawSockets) if (r.proto === pkt.proto) r._deliver(pkt);
    if (pkt.proto === 'tcp') return this._tcpIn(pkt);
    if (pkt.proto === 'udp') return this._udpIn(pkt, ifname);
    if (pkt.proto === 'icmp') return this._icmpIn(pkt, ifname);
  }

  _tcpIn(pkt) {
    let c = this.conns.get(connKey(pkt.dst, pkt.dport, pkt.src, pkt.sport));
    if (c) return c._onSegment(pkt);
    let f = pkt.flags || '';
    if (f === 'S') {
      let l = this.listeners.get(listenKey(pkt.dst, pkt.dport)) || this.listeners.get(listenKey('0.0.0.0', pkt.dport));
      if (l && !l.closed && l.queue.length < l.backlog) {
        let conn = new TcpConn(this, { addr: pkt.dst, port: pkt.dport }, { addr: pkt.src, port: pkt.sport }, 'SYN_RECV');
        conn.rcvNxt = ((pkt.seq >>> 0) + 1) >>> 0;
        conn.listener = l;
        conn.owner = l.owner;
        this.conns.set(conn.key, conn);
        conn._send('SA');
        return;
      }
      if (l) return; // backlog full: drop the SYN
      if (Date.now() < this.bootGraceUntil) return;
    }
    if (!f.includes('R')) this.output(rstFor(pkt));
  }

  _udpIn(pkt, ifname) {
    let bcast = pkt.dst === '255.255.255.255' || this.isBroadcastAddr(pkt.dst, ifname);
    let hits = [];
    for (let s of this.udp) {
      if (s.closed || s.local.port !== pkt.dport) continue;
      if (s.device && s.device !== ifname) continue;
      if (!bcast && s.local.addr !== '0.0.0.0' && s.local.addr !== pkt.dst) continue;
      if (s.remote && (s.remote.addr !== pkt.src || s.remote.port !== pkt.sport)) continue;
      hits.push(s);
    }
    if (!hits.length) {
      if (!bcast && Date.now() >= this.bootGraceUntil) this._icmpError(pkt, 3, 3, ifname);
      return;
    }
    // Unicast goes to the most specific socket; broadcasts to every match.
    if (!bcast) hits = [hits.find((s) => s.remote) || hits.find((s) => s.local.addr === pkt.dst) || hits[0]];
    for (let s of hits) s._deliver(pkt);
  }

  _icmpIn(pkt, ifname) {
    let m = pkt.icmp || {};

    if (m.type === 8) {
      if (Number(this.sysctl['net.ipv4.icmp_echo_ignore_all'])) return;
      if (this.isBroadcastAddr(pkt.dst, ifname)) return;
      this.output({ src: pkt.dst, dst: pkt.src, proto: 'icmp', icmp: { type: 0, code: 0, id: m.id, seq: m.seq, data: m.data } });
      return;
    }
    if (m.type === 0) {
      let p = this.pings.get(`${m.id}:${m.seq}`);
      p?.reply({ from: pkt.src, ttl: pkt.ttl, type: 0, bytes: (m.data?.length || 0) + 8 });
      return;
    }
    if ((m.type === 3 || m.type === 11) && m.orig) {
      let o = m.orig;
      if (o.proto === 'icmp') {
        let p = this.pings.get(`${o.id}:${o.seq}`);
        p?.reply({ from: pkt.src, ttl: pkt.ttl, type: m.type, code: m.code });
        return;
      }
      if (o.proto === 'tcp') {
        let c = this.conns.get(connKey(o.src, o.sport, o.dst, o.dport));
        if (c?.state === 'SYN_SENT') {
          if (m.type === 11) {
            c.hops?.(pkt.src, m.type, o.ttl);
            return;
          }
          let code = m.code === 3 ? 'ECONNREFUSED' : m.code === 0 ? 'ENETUNREACH' : 'EHOSTUNREACH';
          c._fail(netError(code, 'connect', o.dst, o.dport));
        }
        return;
      }
      if (o.proto === 'udp') {
        for (let s of this.udp) {
          if (s.local.port !== o.sport) continue;
          if (m.type === 11) s.emit('icmp', { from: pkt.src, type: m.type, code: m.code, ttl: o.ttl });
          else if (s.remote && s.remote.addr === o.dst && s.remote.port === o.dport) {
            s.error = netError(m.code === 3 ? 'ECONNREFUSED' : 'EHOSTUNREACH', 'recvfrom');
            for (let w of [...s.waiters]) w();
          } else s.emit('icmp', { from: pkt.src, type: m.type, code: m.code, ttl: o.ttl });
        }
      }
    }
  }

  /* ----- socket API ----- */

  _ephemeral(used) {
    for (let i = 0; i < 1000; i++) {
      let p = EPHEMERAL[0] + Math.floor(Math.random() * (EPHEMERAL[1] - EPHEMERAL[0]));
      if (!used(p)) return p;
    }
    throw netError('EADDRNOTAVAIL', 'bind');
  }

  _checkBind(addr, port, uid) {
    if (addr !== '0.0.0.0' && !this.isLocalAddr(addr)) throw netError('EADDRNOTAVAIL', 'bind', addr, port);
    if (port > 0 && port < 1024 && Number(uid) !== 0) throw netError('EACCES', 'bind', addr, port);
  }

  tcpPortInUse(port, addr = '0.0.0.0') {
    for (let l of this.listeners.values()) if (l.local.port === port && (addr === '0.0.0.0' || l.local.addr === '0.0.0.0' || l.local.addr === addr)) return true;
    for (let c of this.conns.values()) if (c.local.port === port && c.state !== 'CLOSED') return true;
    return false;
  }

  /** Listen on addr:port (port 0 = ephemeral). */
  tcpListen({ addr = '0.0.0.0', port = 0, backlog = 128, uid = 0 } = {}) {
    port = Number(port) || 0;
    this._checkBind(addr, port, uid);
    if (!port) port = this._ephemeral((p) => this.tcpPortInUse(p));
    for (let l of this.listeners.values()) {
      if (l.local.port === port && (addr === '0.0.0.0' || l.local.addr === '0.0.0.0' || l.local.addr === addr)) throw netError('EADDRINUSE', 'listen', addr, port);
    }
    let l = new TcpListener(this, addr, port, Math.max(1, Math.min(4096, Number(backlog) || 128)));
    this.listeners.set(listenKey(addr, port), l);
    return l;
  }

  /**
   * Connect; resolves once established. Errors: ECONNREFUSED (RST / port
   * unreachable), EHOSTUNREACH / ENETUNREACH (ICMP or no route), ETIMEDOUT
   * (dropped by a firewall), with node's `connect` error messages.
   */
  tcpConnect({ addr, port, localAddr = null, localPort = 0, timeout = 21000, uid = 0, ttl, onConn } = {}) {
    port = Number(port);
    if (!(port > 0 && port < 65536)) return Promise.reject(netError('EINVAL', 'connect', addr, port));
    let r = this.route(addr);
    if (!r) return Promise.reject(netError('ENETUNREACH', 'connect', addr, port));
    let src = localAddr && localAddr !== '0.0.0.0' ? localAddr : r.src;
    if (!src || src === '0.0.0.0') return Promise.reject(netError('ENETUNREACH', 'connect', addr, port));
    let lport = Number(localPort) || 0;
    if (lport) this._checkBind(src, lport, uid);
    else lport = this._ephemeral((p) => this.tcpPortInUse(p));
    let conn = new TcpConn(this, { addr: src, port: lport }, { addr, port }, 'SYN_SENT');
    if (this.conns.has(conn.key)) return Promise.reject(netError('EADDRINUSE', 'connect', addr, port));
    this.conns.set(conn.key, conn);
    onConn?.(conn);
    return new Promise((resolve, reject) => {
      let timer = timeout > 0 ? setTimeout(() => conn._fail(netError('ETIMEDOUT', 'connect', addr, port)), timeout) : null;
      let offOk = conn.on('connect', () => {
        clearTimeout(timer);
        offOk();
        offErr();
        resolve(conn);
      });
      let offErr = conn.on('error', (err) => {
        clearTimeout(timer);
        offOk();
        offErr();
        reject(err);
      });
      let syn = () => {
        let pkt = { src, dst: addr, proto: 'tcp', sport: lport, dport: port, flags: 'S', data: null };
        if (ttl) pkt.ttl = ttl;
        this.output(pkt);
      };
      syn();
      // Retransmit the SYN with exponential backoff while unanswered.
      let delay = 1000;
      let retx = () => {
        if (conn.state !== 'SYN_SENT') return;
        syn();
        delay *= 2;
        conn.retxTimer = setTimeout(retx, delay);
      };
      conn.retxTimer = setTimeout(retx, delay);
      conn.on('close', () => clearTimeout(conn.retxTimer));
      conn.on('connect', () => clearTimeout(conn.retxTimer));
    });
  }

  _dropConn(conn) {
    if (this.conns.get(conn.key) === conn) this.conns.delete(conn.key);
  }

  /** A raw IP socket (ping, traceroute: ICMP; nmap: TCP/UDP/IPPROTO_RAW). */
  rawOpen(proto = 'icmp', hdrincl = false) {
    let s = new RawIpSocket(this, proto, hdrincl);
    this.rawSockets.add(s);
    return s;
  }

  rawIcmp_open() {
    return this.rawOpen('icmp');
  }

  /** An AF_PACKET socket. */
  packetOpen(opts) {
    let s = new PacketSocket(this, opts);
    this.packetSockets.add(s);
    return s;
  }

  /** Interface index as ip/ioctls number them (1 = lo, in creation order). */
  ifIndex(ifname) {
    return [...this.ifaces.keys()].indexOf(ifname) + 1;
  }
  ifByIndex(index) {
    return [...this.ifaces.keys()][index - 1] || null;
  }

  /* ----- frames: capture, injection, ARP ----- */

  _capture(ifname, frame, meta) {
    for (let s of this.packetSockets) s._deliver(frame, { ...meta, ifname });
  }

  _learn(ifname, ip, mac) {
    if (!ip || !mac || mac === BROADCAST_MAC || ip === '0.0.0.0') return;
    this.neighbors.set(`${ifname} ${ip}`, { mac, at: Date.now() });
  }

  neighborMac(ifname, ip) {
    if (ip === '255.255.255.255' || this.isBroadcastAddr(ip, ifname)) return BROADCAST_MAC;
    let n = this.neighbors.get(`${ifname} ${ip}`);
    if (n) return n.mac;
    let mac = this.macOf(ifname, ip);
    if (mac) this._learn(ifname, ip, mac);
    return mac;
  }

  /** A frame from a packet socket: IPv4 goes onto the wire as-is, ARP to the segment. */
  injectFrame(ifname, eth, frame) {
    let iface = this.ifaces.get(ifname);
    if (!iface?.up) throw netError('ENETDOWN', 'sendto');
    this._capture(ifname, frame, { type: eth.type, pkttype: 4, srcMac: eth.srcMac });
    if (iface.loopback) {
      if (eth.type === 0x0800) {
        let pkt = fromBytes(eth.payload);
        if (pkt) queueMicrotask(() => this._input('lo', pkt, { fromLocal: true }));
      }
      return;
    }
    if (eth.type === 0x0800) {
      let pkt = fromBytes(eth.payload);
      if (!pkt) return;
      pkt.len = eth.payload.length;
      iface.stats.txPackets++;
      iface.stats.txBytes += pkt.len;
      this.transmitFrame(ifname, eth.dstMac, 'ip', pkt);
    } else if (eth.type === 0x0806) {
      let arp = parseArp(eth.payload);
      if (arp) this.transmitFrame(ifname, eth.dstMac, 'arp', arp);
    }
  }

  /** ARP from the segment: capture it, answer requests for our addresses. */
  receiveArp(ifname, arp, srcMac) {
    let iface = this.ifaces.get(ifname);
    if (!iface?.up) return;
    let bcast = arp.op === 1;
    this._capture(ifname, ethFrame(bcast ? BROADCAST_MAC : iface.mac, srcMac, 0x0806, arpBytes(arp)), { type: 0x0806, pkttype: bcast ? 1 : 0, srcMac });
    this._learn(ifname, arp.spa, arp.sha);
    if (arp.op === 1 && iface.addrs.some((a) => a.ip === arp.tpa)) {
      let reply = { op: 2, sha: iface.mac, spa: arp.tpa, tha: arp.sha, tpa: arp.spa };
      this._capture(ifname, ethFrame(arp.sha, iface.mac, 0x0806, arpBytes(reply)), { type: 0x0806, pkttype: 4, srcMac: iface.mac });
      this.transmitFrame(ifname, arp.sha, 'arp', reply);
    }
  }

  udpBind({ addr = '0.0.0.0', port = 0, uid = 0, reuse = false } = {}) {
    port = Number(port) || 0;
    this._checkBind(addr, port, uid);
    let used = (p) => [...this.udp].some((s) => s.local.port === p && (addr === '0.0.0.0' || s.local.addr === '0.0.0.0' || s.local.addr === addr));
    if (!port) port = this._ephemeral(used);
    else if (!reuse && [...this.udp].some((s) => !s.reuse && s.local.port === port && (addr === '0.0.0.0' || s.local.addr === '0.0.0.0' || s.local.addr === addr))) throw netError('EADDRINUSE', 'bind', addr, port);
    let s = new UdpSocket(this, addr, port);
    s.reuse = reuse;
    this.udp.add(s);
    return s;
  }

  /**
   * ICMP echo: { from, ttl, time } for a reply, { from, type: 11 } when a
   * router reports TTL exceeded (traceroute), rejects ETIMEDOUT / unreachable.
   */
  ping(dst, { id = Math.floor(Math.random() * 65535), seq = 1, ttl, size = 56, timeout = 4000, src } = {}) {
    let key = `${id}:${seq}`;
    let t0 = performance.now();
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        this.pings.delete(key);
        reject(netError('ETIMEDOUT', 'ping', dst));
      }, timeout);
      let finish = () => {
        clearTimeout(timer);
        this.pings.delete(key);
      };
      this.pings.set(key, {
        reply: (r) => {
          finish();
          resolve({ ...r, time: performance.now() - t0 });
        },
        error: (code) => {
          finish();
          reject(netError(code, 'ping', dst));
        },
      });
      let pkt = { src: src || undefined, dst, proto: 'icmp', icmp: { type: 8, code: 0, id, seq, data: new Uint8Array(size) } };
      if (ttl) pkt.ttl = ttl;
      let r = this.route(dst);
      if (!r) {
        finish();
        return reject(netError('ENETUNREACH', 'ping', dst));
      }
      pkt.src ??= r.src;
      this.output(pkt);
    });
  }

  /** Sockets for ss / netstat. */
  sockets() {
    let out = [];
    for (let l of this.listeners.values()) out.push({ proto: 'tcp', state: 'LISTEN', local: l.local, remote: { addr: '0.0.0.0', port: '*' }, recvQ: l.queue.length, sendQ: l.backlog, owner: l.owner });
    for (let c of this.conns.values()) out.push({ proto: 'tcp', state: c.state, local: c.local, remote: c.remote, recvQ: c.rxBytes, sendQ: 0, owner: c.owner });
    for (let s of this.udp) out.push({ proto: 'udp', state: s.remote ? 'ESTAB' : 'UNCONN', local: s.local, remote: s.remote || { addr: '0.0.0.0', port: '*' }, recvQ: s.queue.reduce((n, m) => n + m.data.length, 0), sendQ: 0, owner: s.owner });
    return out;
  }
}

function intToNet(ip, prefix) {
  let n = ipToInt(ip) & maskOf(prefix);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}
