/**
 * Socket syscalls of one process (node or WASI), served by the kernel of the
 * box it runs on (other/node/node.js routes every `net.*` op here).
 *
 * BSD-style: net.socket → bind / listen / accept / connect / send / recv /
 * shutdown / close / poll / setopt, on this realm's stack (other/net/local.js).
 * Blocking calls simply await (the worker is parked on its syscall channel);
 * `nonblock` returns EAGAIN instead. Node's evented sockets additionally
 * `net.subscribe` and get pushed { t: 'net-ev', sid, ev, … } messages.
 *
 * UDP datagrams cross the blocking channel as bytes prefixed with the peer
 * (4 address bytes + 2 port bytes), since replies are either JSON or bytes.
 */
import { localStack, localResolver, hostname } from './local.js';
import { netError } from './stack.js';
import { decodeMessage } from './dns.js';
import { query } from './resolver.js';
import { ipToInt, intToIp } from './ip.js';

let enc = new TextEncoder();

export function createProcNet({ actor, pid, comm, push = () => {} }) {
  let socks = new Map(); // sid → { type, state, obj, bind, opts, subs }
  let next = 3;
  let owner = { pid, comm, uid: Number(actor?.uid) || 0 };
  let uid = owner.uid;

  let get = (sid, syscall = 'socket') => {
    let s = socks.get(Number(sid));
    if (!s) throw netError('EBADF', syscall);
    return s;
  };
  let add = (s) => {
    let sid = next++;
    socks.set(sid, s);
    return sid;
  };
  let addrOf = (o) => (o ? { addr: o.addr, port: o.port } : null);

  /** Wire node-style events for a socket object. */
  function subscribe(sid, s) {
    if (s.subscribed) return;
    s.subscribed = true;
    let o = s.obj;
    if (s.type === 'listener') {
      o.on('connection', () => {
        let c = o.take();
        if (!c) return;
        c.owner = owner;
        let csid = add({ type: 'conn', obj: c });
        subscribe(csid, socks.get(csid));
        push({ t: 'net-ev', sid, ev: 'connection', csid, local: addrOf(c.local), remote: addrOf(c.remote) });
      });
      // Connections that arrived before subscribing.
      let c;
      while ((c = o.take())) {
        c.owner = owner;
        let csid = add({ type: 'conn', obj: c });
        subscribe(csid, socks.get(csid));
        push({ t: 'net-ev', sid, ev: 'connection', csid, local: addrOf(c.local), remote: addrOf(c.remote) });
      }
      return;
    }
    if (s.type === 'conn') {
      let flush = () => {
        let b;
        while ((b = o.take())) {
          if (!b.length) break;
          push({ t: 'net-ev', sid, ev: 'data', data: b.slice() });
        }
      };
      o.rx.length && flush();
      o.on('data', () => flush());
      o.on('end', () => push({ t: 'net-ev', sid, ev: 'end' }));
      o.on('error', (err) => push({ t: 'net-ev', sid, ev: 'error', error: err }));
      o.on('close', (hadError) => push({ t: 'net-ev', sid, ev: 'close', hadError }));
      if (o.eof) push({ t: 'net-ev', sid, ev: 'end' });
      return;
    }
    if (s.type === 'udp') {
      let flush = () => {
        let m;
        try {
          while ((m = o.take())) push({ t: 'net-ev', sid, ev: 'message', data: m.data.slice(), from: m.from });
        } catch (err) {
          push({ t: 'net-ev', sid, ev: 'error', error: err });
        }
      };
      flush();
      o.on('message', flush);
    }
  }

  let packFrom = (m) => {
    let out = new Uint8Array(6 + m.data.length);
    let n = ipToInt(m.from.addr);
    out.set([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255, m.from.port >> 8, m.from.port & 255]);
    out.set(m.data, 6);
    return out;
  };

  let ops = {
    async socket({ type = 'tcp', proto = 'icmp', cooked = false, ethertype = 0x0003 }) {
      if (type === 'raw') {
        // Raw ICMP (ping/traceroute) is open to everyone, as if those tools were setuid root;
        // raw TCP/UDP/IP (nmap, packet crafting) needs root.
        if (proto !== 'icmp' && uid !== 0) throw netError('EPERM', 'socket');
        let stack = await localStack();
        let o = stack.rawOpen(proto, proto === 'raw');
        o.owner = owner;
        return add({ type: 'raw', obj: o, opts: {} });
      }
      if (type === 'packet') {
        if (uid !== 0) throw netError('EPERM', 'socket');
        let stack = await localStack();
        let o = stack.packetOpen({ cooked, ethertype });
        o.owner = owner;
        return add({ type: 'packet', obj: o, opts: {} });
      }
      if (type !== 'tcp' && type !== 'udp') throw netError('EPROTONOSUPPORT', 'socket');
      return add({ type: type === 'tcp' ? 'tcp' : 'udp-new', bind: null, opts: {} });
    },

    async bind({ sid, addr = '0.0.0.0', port = 0, ifindex, ethertype }) {
      let s = get(sid, 'bind');
      let stack = await localStack();
      if (s.type === 'packet') {
        let ifname = ifindex ? stack.ifByIndex(ifindex) : null;
        if (ifindex && !ifname) throw netError('ENODEV', 'bind');
        s.obj.bind(ifname, ethertype);
        return { addr: '0.0.0.0', port: 0 };
      }
      if (s.type === 'raw') return { addr, port: 0 };
      if (s.bind || s.type === 'udp') throw netError('EINVAL', 'bind');
      if (s.type === 'udp-new') {
        s.obj = stack.udpBind({ addr, port, uid, reuse: !!s.opts.reuse });
        s.obj.owner = owner;
        s.obj.broadcast = !!s.opts.broadcast;
        s.obj.device = s.opts.device || null;
        if (s.opts.ttl) s.obj.ttl = Number(s.opts.ttl) || null;
        s.type = 'udp';
        return addrOf(s.obj.local);
      }
      // TCP: check now (EACCES/EADDRNOTAVAIL), reserve at listen/connect.
      stack._checkBind(addr, Number(port) || 0, uid);
      if (port && stack.tcpPortInUse(Number(port), addr) && !s.opts.reuse) throw netError('EADDRINUSE', 'bind', addr, port);
      s.bind = { addr, port: Number(port) || 0 };
      return s.bind;
    },

    async listen({ sid, backlog = 511 }) {
      let s = get(sid, 'listen');
      if (s.type !== 'tcp') throw netError(s.type === 'listener' ? 'EINVAL' : 'EOPNOTSUPP', 'listen');
      let stack = await localStack();
      let l = stack.tcpListen({ addr: s.bind?.addr || '0.0.0.0', port: s.bind?.port || 0, backlog, uid });
      l.owner = owner;
      s.type = 'listener';
      s.obj = l;
      return addrOf(l.local);
    },

    async accept({ sid, nonblock = false, timeout = -1 }) {
      let s = get(sid, 'accept');
      if (s.type !== 'listener') throw netError('EINVAL', 'accept');
      let c = nonblock ? s.obj.take() : await s.obj.accept({ timeout });
      if (!c) throw netError('EAGAIN', 'accept');
      c.owner = owner;
      let csid = add({ type: 'conn', obj: c });
      return { sid: csid, local: addrOf(c.local), remote: addrOf(c.remote) };
    },

    async connect({ sid, addr, port, timeout = 21000, nonblock = false }) {
      let s = get(sid, 'connect');
      let stack = await localStack();
      if (s.type === 'raw') {
        s.obj.connect(addr);
        return { local: addrOf(s.obj.local), remote: addrOf(s.obj.remote) };
      }
      if (s.type === 'udp-new' || s.type === 'udp') {
        if (s.type === 'udp-new') await ops.bind({ sid, addr: '0.0.0.0', port: 0 });
        s.obj.connect(addr, port);
        return { local: addrOf(s.obj.local), remote: addrOf(s.obj.remote) };
      }
      if (s.type === 'conn') throw netError('EISCONN', 'connect', addr, port);
      if (s.type === 'connecting') throw netError(s.done ? 'EISCONN' : 'EALREADY', 'connect', addr, port);
      if (s.type !== 'tcp') throw netError('EINVAL', 'connect');
      let p = stack.tcpConnect({ addr, port, localAddr: s.bind?.addr, localPort: s.bind?.port, timeout, uid, onConn: (c) => ((c.owner = owner), (s.obj = c)) });
      s.type = 'connecting';
      let done = p.then(
        (c) => {
          s.type = 'conn';
          s.obj = c;
          if (s.subscribed) {
            s.subscribed = false;
            subscribe(sid, s);
          }
          return { local: addrOf(c.local), remote: addrOf(c.remote) };
        },
        (err) => {
          s.type = 'tcp';
          s.error = err;
          throw err;
        },
      );
      if (nonblock) {
        done.catch(() => {});
        s.pending = done;
        throw netError('EINPROGRESS', 'connect', addr, port);
      }
      return done;
    },

    /** Wait for a non-blocking connect: resolves like connect, or throws its error. */
    async finishConnect({ sid }) {
      let s = get(sid, 'connect');
      if (s.type === 'conn') return { local: addrOf(s.obj.local), remote: addrOf(s.obj.remote) };
      if (s.pending) return s.pending;
      if (s.error) throw s.error;
      throw netError('ENOTCONN', 'connect');
    },

    async send(args0) {
      let { sid, data, addr, port } = args0;
      let s = get(sid, 'send');
      let bytes = data instanceof Uint8Array ? data : typeof data === 'string' ? enc.encode(data) : new Uint8Array(data || []);
      if (s.type === 'udp-new') await ops.bind({ sid, addr: '0.0.0.0', port: 0 });
      if (s.type === 'udp' || s.type === 'raw') return s.obj.send(bytes, addr != null ? { addr, port: Number(port) || 0 } : null);
      if (s.type === 'packet') {
        let stack = await localStack();
        return s.obj.send(bytes, { ifname: args0.ifindex ? stack.ifByIndex(args0.ifindex) : null, mac: args0.mac, proto: args0.ethertype });
      }
      if (s.type !== 'conn') throw netError(s.type === 'connecting' ? 'EAGAIN' : 'ENOTCONN', 'send');
      return s.obj.write(bytes);
    },

    /** TCP: bytes (empty = EOF). UDP/raw: peer-prefixed datagram. Packet: 16-byte link header + frame. */
    async recv({ sid, max = 65536, nonblock = false, timeout = -1 }) {
      let s = get(sid, 'recv');
      if (s.type === 'packet') {
        let m = nonblock ? s.obj.take() : await s.obj.recv({ timeout });
        if (!m) throw netError('EAGAIN', 'recvfrom');
        let d = m.data.subarray(0, max);
        let out = new Uint8Array(16 + d.length);
        let dv = new DataView(out.buffer);
        dv.setUint32(0, m.ll.ifindex);
        dv.setUint16(4, m.ll.proto);
        out[6] = m.ll.pkttype;
        out[7] = 6;
        String(m.ll.mac || '00:00:00:00:00:00').split(':').forEach((h, i) => (out[8 + i] = parseInt(h, 16)));
        out.set(d, 16);
        return out;
      }
      if (s.type === 'udp' || s.type === 'raw') {
        let m = nonblock ? s.obj.take() : await s.obj.recv({ timeout });
        if (!m) throw netError('EAGAIN', 'recvfrom');
        return packFrom({ ...m, data: m.data.subarray(0, max) });
      }
      if (s.type === 'udp-new') throw netError('EAGAIN', 'recvfrom');
      if (s.type !== 'conn') throw netError('ENOTCONN', 'recv');
      if (nonblock) {
        let b = s.obj.take(max);
        if (!b) throw netError('EAGAIN', 'recv');
        return b;
      }
      return s.obj.read(max, { timeout });
    },

    async shutdown({ sid, how = 'wr' }) {
      let s = get(sid, 'shutdown');
      if (s.type !== 'conn') throw netError('ENOTCONN', 'shutdown');
      if (how === 'wr' || how === 'rdwr') s.obj.end();
      if (how === 'rd' || how === 'rdwr') s.obj.shutRd = true;
      return 0;
    },

    async close({ sid }) {
      let s = socks.get(Number(sid));
      if (!s) return 0;
      socks.delete(Number(sid));
      if (s.type === 'connecting') s.obj?.close?.();
      else if (s.obj) s.obj.close();
      return 0;
    },

    /** Node's socket.destroy(): RST for connections. */
    async destroy({ sid }) {
      let s = socks.get(Number(sid));
      if (!s) return 0;
      socks.delete(Number(sid));
      if (s.type === 'conn') s.obj.reset();
      else s.obj?.close?.();
      return 0;
    },

    async setopt({ sid, opt, value }) {
      let s = get(sid, 'setsockopt');
      s.opts[opt] = value;
      let o = s.obj;
      if (s.type === 'udp' && opt === 'broadcast') o.broadcast = !!value;
      if (opt === 'ttl' && o) o.ttl = Number(value) || null;
      if (opt === 'hdrincl' && s.type === 'raw') o.hdrincl = !!value;
      if (s.type === 'udp' && opt === 'device') o.device = value || null;
      return 0;
    },

    /** getsockopt(SO_ERROR): the pending error code (cleared), or null. */
    async sockerror({ sid }) {
      let s = get(sid, 'getsockopt');
      let e = s.error || (s.obj?.error && s.type !== 'conn' ? s.obj.error : null);
      s.error = null;
      return e ? e.code : null;
    },

    async getsockname({ sid }) {
      let s = get(sid, 'getsockname');
      return s.obj ? addrOf(s.obj.local) : s.bind || { addr: '0.0.0.0', port: 0 };
    },

    async getpeername({ sid }) {
      let s = get(sid, 'getpeername');
      if (!s.obj?.remote) throw netError('ENOTCONN', 'getpeername');
      return addrOf(s.obj.remote);
    },

    /** poll(2): fds [{ sid, events: { in, out } }] → [{ sid, in, out, hup, err }] once any is ready (or timeout ms). */
    async poll({ fds, timeout = -1 }) {
      let check = () => {
        let out = [];
        for (let f of fds) {
          let s = socks.get(Number(f.sid));
          if (!s) {
            out.push({ sid: f.sid, nval: true });
            continue;
          }
          let r = s.type === 'udp-new' || s.type === 'tcp' ? { in: false, out: true, hup: false, err: !!s.error } : s.type === 'connecting' ? { in: false, out: false, hup: false, err: false } : s.obj.poll();
          let hit = (f.events?.in && r.in) || (f.events?.out && r.out) || r.hup || r.err;
          if (hit) out.push({ sid: f.sid, ...r });
        }
        return out;
      };
      let ready = check();
      if (ready.length || timeout === 0) return ready;
      return new Promise((resolve) => {
        let timer = null;
        let offs = [];
        let finish = (v) => {
          clearTimeout(timer);
          for (let off of offs) off();
          resolve(v);
        };
        let wake = () => {
          let r = check();
          if (r.length) finish(r);
        };
        for (let f of fds) {
          let s = socks.get(Number(f.sid));
          let o = s?.obj;
          if (o?.waiters) {
            o.waiters.add(wake);
            offs.push(() => o.waiters.delete(wake));
          }
          if (s?.type === 'connecting' && s.pending) s.pending.then(wake, wake);
        }
        if (timeout > 0) timer = setTimeout(() => finish([]), timeout);
      });
    },

    async subscribe({ sid }) {
      let s = get(sid);
      subscribe(Number(sid), s);
      return 0;
    },

    /** getaddrinfo: IPv4 addresses for a name. */
    async lookup({ name }) {
      let r = await localResolver();
      return r.resolve4(name);
    },

    async reverse({ addr }) {
      let r = await localResolver();
      return r.reverse(addr);
    },

    /** One DNS query (dig/host/nslookup, node dns.resolve*): the decoded response. */
    async query({ name, type = 'A', server, timeout = 5000 }) {
      let stack = await localStack();
      if (!server) {
        let r = await localResolver();
        server = (await r.conf()).nameservers[0];
        if (!server) throw netError('ECONNREFUSED', 'query', name);
      }
      let res = await query(stack, server, name, type, { timeout, attempts: 2 });
      return { ...res, answers: res.answers.map(plain), authorities: res.authorities.map(plain), additionals: res.additionals.map(plain) };
    },

    async ifaces() {
      let stack = await localStack();
      let out = {};
      for (let i of stack.ifaces.values()) out[i.name] = i.addrs.map((a) => ({ address: a.ip, netmask: intToIp(a.prefix ? (0xffffffff << (32 - a.prefix)) >>> 0 : 0), family: 'IPv4', mac: i.mac, internal: !!i.loopback, cidr: `${a.ip}/${a.prefix}` }));
      return out;
    },

    /** Interfaces for SIOCGIF* (index 1 = lo, in stack order). */
    async ifinfo() {
      let stack = await localStack();
      let mask = (p) => intToIp(p ? (0xffffffff << (32 - p)) >>> 0 : 0);
      return [...stack.ifaces.values()].map((i, n) => {
        let a = i.addrs[0];
        let flags = (i.up ? 0x1 | 0x40 : 0) | (i.loopback ? 0x8 : 0x2 | 0x1000);
        let bcast = a && !i.loopback ? intToIp((ipToInt(a.ip) | ~(a.prefix ? (0xffffffff << (32 - a.prefix)) >>> 0 : 0)) >>> 0) : null;
        return { index: n + 1, name: i.name, flags, mtu: i.mtu, mac: i.mac, ip: a?.ip || null, netmask: a ? mask(a.prefix) : null, broadcast: bcast };
      });
    },

    async hostname() {
      return hostname();
    },
  };

  return {
    async call(op, args = {}) {
      let fn = ops[op.slice(4)];
      if (!fn) throw netError('ENOSYS', op);
      return fn(args);
    },
    dispose() {
      for (let [sid] of socks) ops.close({ sid }).catch(() => {});
      socks.clear();
    },
  };
}

let plain = (r) => ({ ...r, data: r.data instanceof Uint8Array ? Array.from(r.data) : r.data });
void decodeMessage;
