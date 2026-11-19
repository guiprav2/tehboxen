/**
 * node's net, dgram, dns and http/https modules on the box's simulated
 * network (other/net/procnet.js syscalls): sockets reach other boxes through
 * the fabric, never the real Internet.
 *
 * https is HTTP over real TLS (other/node/tls.js: OpenSSL in wasm, over these sockets).
 */
import { Buffer } from 'https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm';
import eventsMod from 'https://cdn.jsdelivr.net/npm/events@3.3.0/+esm';
import * as streamMod from 'https://cdn.jsdelivr.net/npm/readable-stream@4.7.0/+esm';
import { createTls } from './tls.js';

let EventEmitter = eventsMod.EventEmitter || eventsMod;
let Duplex = streamMod.Duplex;
let Readable = streamMod.Readable;
let Writable = streamMod.Writable;
let isIPv4 = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(String(s)) && String(s).split('.').every((x) => Number(x) <= 255);
let isIP = (s) => (isIPv4(s) ? 4 : /^[0-9a-f:]+$/i.test(String(s)) && String(s).includes(':') ? 6 : 0);

/** Re-shape a syscall error like node's (message "connect ECONNREFUSED 1.2.3.4:80", address, port). */
function netErr(err, extra = {}) {
  let e = err instanceof Error ? err : Object.assign(new Error(err?.message || String(err)), err);
  Object.assign(e, extra);
  return e;
}

/**
 * @param {{ sys: { sync: Function, async: Function }, ref: () => () => void }} k
 */
export function createNetModules(k) {
  let handlers = new Map(); // sid → (ev) => void
  self.addEventListener('message', (ev) => {
    let m = ev.data;
    if (!m || m.t !== 'net-ev') return;
    handlers.get(m.sid)?.(m);
  });
  // A pending syscall keeps the process alive (like a pending libuv request).
  let call = async (op, args) => {
    let release = k.ref();
    try {
      return await k.sys.async('net.' + op, args);
    } finally {
      release();
    }
  };
  let lookup4 = async (host) => {
    if (!host || host === 'localhost') return '127.0.0.1';
    if (isIPv4(host)) return host;
    let ips = await call('lookup', { name: host });
    return ips[0];
  };

  /* ---------- net ---------- */

  class Socket extends Duplex {
    constructor(opts = {}) {
      super({ allowHalfOpen: !!opts.allowHalfOpen, decodeStrings: true });
      this._sid = opts._sid ?? null;
      this._pendingWrites = [];
      this.connecting = false;
      this.bytesRead = 0;
      this.bytesWritten = 0;
      this.remoteAddress = opts._remote?.addr;
      this.remotePort = opts._remote?.port;
      this.remoteFamily = this.remoteAddress ? 'IPv4' : undefined;
      this.localAddress = opts._local?.addr;
      this.localPort = opts._local?.port;
      this._release = null;
      this._timeoutMs = 0;
      this._timer = null;
      if (this._sid != null) this._attach();
    }
    get readyState() {
      if (this.connecting) return 'opening';
      if (this.readable && this.writable) return 'open';
      if (this.readable) return 'readOnly';
      if (this.writable) return 'writeOnly';
      return 'closed';
    }
    get pending() {
      return this._sid == null || this.connecting;
    }
    _attach() {
      this._release ??= k.ref();
      handlers.set(this._sid, (m) => this._onEvent(m));
      call('subscribe', { sid: this._sid }).catch((err) => this.destroy(netErr(err)));
    }
    _onEvent(m) {
      this._touch();
      if (m.ev === 'data') {
        let b = Buffer.from(m.data);
        this.bytesRead += b.length;
        this.push(b);
      } else if (m.ev === 'end') {
        this.push(null);
        if (!this.allowHalfOpen && this.writable) this.end();
      } else if (m.ev === 'error') this.destroy(netErr(m.error));
      else if (m.ev === 'close') {
        if (!this.destroyed && !this.readableEnded) this.push(null);
        // Our side is closed too once both directions finished.
        if (this.writableFinished || !this.writable) this.destroy();
      }
    }
    connect(...args) {
      let opts = normalizeConnectArgs(args);
      if (opts.cb) this.once('connect', opts.cb);
      this.connecting = true;
      (async () => {
        try {
          let addr = await lookup4(opts.host || 'localhost');
          this.emit('lookup', null, addr, 4, opts.host || 'localhost');
          let sid = await call('socket', { type: 'tcp' });
          this._sid = sid;
          if (opts.localAddress || opts.localPort) await call('bind', { sid, addr: opts.localAddress || '0.0.0.0', port: opts.localPort || 0 });
          let r = await call('connect', { sid, addr, port: Number(opts.port), timeout: opts.timeout ?? 21000 });
          this.connecting = false;
          this.localAddress = r.local.addr;
          this.localPort = r.local.port;
          this.remoteAddress = r.remote.addr;
          this.remotePort = r.remote.port;
          this.remoteFamily = 'IPv4';
          this._attach();
          for (let w of this._pendingWrites.splice(0)) this._write(w.chunk, w.enc, w.cb);
          if (this._pendingFinal) this._final(this._pendingFinal);
          this.emit('connect');
          this.emit('ready');
        } catch (err) {
          this.connecting = false;
          let e = netErr(err, err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN' ? {} : { address: opts.host, port: Number(opts.port) });
          this.destroy(e);
        }
      })();
      return this;
    }
    _write(chunk, enc, cb) {
      if (this._sid == null || this.connecting) return this._pendingWrites.push({ chunk, enc, cb });
      let b = typeof chunk === 'string' ? Buffer.from(chunk, enc) : chunk;
      this.bytesWritten += b.length;
      this._touch();
      call('send', { sid: this._sid, data: new Uint8Array(b) }).then(() => cb(), (err) => cb(netErr(err)));
    }
    _final(cb) {
      if (this._sid == null || this.connecting) {
        this._pendingFinal = cb;
        return;
      }
      call('shutdown', { sid: this._sid, how: 'wr' }).then(() => cb(), () => cb());
    }
    _read() {}
    _destroy(err, cb) {
      clearTimeout(this._timer);
      if (this._sid != null) {
        handlers.delete(this._sid);
        call(err ? 'destroy' : 'close', { sid: this._sid }).catch(() => {});
      }
      this._release?.();
      this._release = null;
      cb(err);
    }
    _touch() {
      if (!this._timeoutMs) return;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this.emit('timeout'), this._timeoutMs);
    }
    setTimeout(ms, cb) {
      this._timeoutMs = Number(ms) || 0;
      if (cb) this.once('timeout', cb);
      this._touch();
      if (!this._timeoutMs) clearTimeout(this._timer);
      return this;
    }
    setNoDelay() {
      return this;
    }
    setKeepAlive() {
      return this;
    }
    address() {
      return this.localAddress ? { address: this.localAddress, family: 'IPv4', port: this.localPort } : {};
    }
    ref() {
      this._release ??= k.ref();
      return this;
    }
    unref() {
      this._release?.();
      this._release = null;
      return this;
    }
    resetAndDestroy() {
      return this.destroy(Object.assign(new Error('ERR_SOCKET_CLOSED'), { code: 'ECONNRESET' }));
    }
  }

  function normalizeConnectArgs(args) {
    let cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    let o = typeof args[0] === 'object' && args[0] ? { ...args[0] } : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
    if (o.path) throw Object.assign(new Error('Unix domain sockets are not supported'), { code: 'ENOTSUP' });
    o.cb = cb;
    return o;
  }

  class Server extends EventEmitter {
    constructor(opts, onConn) {
      super();
      if (typeof opts === 'function') [opts, onConn] = [{}, opts];
      this._opts = opts || {};
      if (onConn) this.on('connection', onConn);
      this._sid = null;
      this._addr = null;
      this._conns = new Set();
      this.listening = false;
      this.maxConnections = undefined;
    }
    listen(...args) {
      let cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      let o = typeof args[0] === 'object' && args[0] ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined, backlog: typeof args[1] === 'number' ? args[1] : args[2] };
      if (cb) this.once('listening', cb);
      (async () => {
        try {
          let host = o.host && o.host !== '::' && o.host !== '0.0.0.0' ? await lookup4(o.host) : '0.0.0.0';
          let sid = await call('socket', { type: 'tcp' });
          await call('bind', { sid, addr: host, port: Number(o.port) || 0 });
          this._addr = await call('listen', { sid, backlog: o.backlog || 511 });
          this._sid = sid;
          this.listening = true;
          this._release = k.ref();
          handlers.set(sid, (m) => {
            if (m.ev !== 'connection') return;
            if (this.maxConnections != null && this._conns.size >= this.maxConnections) {
              call('destroy', { sid: m.csid }).catch(() => {});
              return;
            }
            let s = new Socket({ _sid: m.csid, _remote: m.remote, _local: m.local, allowHalfOpen: !!this._opts.allowHalfOpen });
            s.server = this;
            this._conns.add(s);
            s.on('close', () => {
              this._conns.delete(s);
              this._maybeClosed();
            });
            this.emit('connection', s);
          });
          await call('subscribe', { sid });
          this.emit('listening');
        } catch (err) {
          let e = netErr(err, { address: o.host || '0.0.0.0', port: Number(o.port) || 0 });
          e.message = `listen ${e.code} ${o.host ? o.host : '0.0.0.0'}:${o.port ?? 0}`;
          if (e.code === 'EACCES') e.message = `listen EACCES: permission denied ${o.host || '0.0.0.0'}:${o.port}`;
          if (e.code === 'EADDRINUSE') e.message = `listen EADDRINUSE: address already in use ${o.host || '0.0.0.0'}:${o.port}`;
          this.emit('error', e);
        }
      })();
      return this;
    }
    address() {
      return this._addr ? { address: this._addr.addr, family: 'IPv4', port: this._addr.port } : null;
    }
    close(cb) {
      if (cb) this.once('close', cb);
      if (this._sid != null) {
        handlers.delete(this._sid);
        call('close', { sid: this._sid }).catch(() => {});
        this._sid = null;
        this.listening = false;
        this._release?.();
        this._release = null;
      }
      this._closing = true;
      this._maybeClosed();
      return this;
    }
    _maybeClosed() {
      if (this._closing && !this._conns.size && !this._closed) {
        this._closed = true;
        queueMicrotask(() => this.emit('close'));
      }
    }
    getConnections(cb) {
      cb?.(null, this._conns.size);
    }
    ref() {
      if (this.listening) this._release ??= k.ref();
      return this;
    }
    unref() {
      this._release?.();
      this._release = null;
      return this;
    }
  }

  let net = {
    Socket,
    Stream: Socket,
    Server,
    createServer: (opts, cb) => new Server(opts, cb),
    connect: (...args) => {
      let o = normalizeConnectArgs([...args]);
      let s = new Socket(o);
      return s.connect(...args);
    },
    isIP,
    isIPv4,
    isIPv6: (s) => isIP(s) === 6,
    BlockList: class {
      addAddress() {}
      check() {
        return false;
      }
    },
    getDefaultAutoSelectFamily: () => false,
    setDefaultAutoSelectFamily() {},
  };
  net.createConnection = net.connect;

  /* ---------- dgram ---------- */

  class DgramSocket extends EventEmitter {
    constructor(opts, onMessage) {
      super();
      if (typeof opts === 'string') opts = { type: opts };
      if (opts?.type && opts.type !== 'udp4') throw Object.assign(new Error('IPv6 is not supported'), { code: 'ERR_SOCKET_BAD_TYPE' });
      if (onMessage) this.on('message', onMessage);
      this._opts = opts || {};
      this._sid = null;
      this._ready = null;
      this._addr = null;
      this._release = null;
      this._connected = null;
    }
    _ensure(port = 0, address = '0.0.0.0') {
      this._ready ??= (async () => {
        let sid = await call('socket', { type: 'udp' });
        this._sid = sid;
        if (this._opts.reuseAddr) await call('setopt', { sid, opt: 'reuse', value: true });
        let host = address && address !== '0.0.0.0' ? await lookup4(address) : '0.0.0.0';
        this._addr = await call('bind', { sid, addr: host, port: Number(port) || 0 });
        this._release = k.ref();
        handlers.set(sid, (m) => {
          if (m.ev === 'message') this.emit('message', Buffer.from(m.data), { address: m.from.addr, family: 'IPv4', port: m.from.port, size: m.data.length });
          else if (m.ev === 'error') this.emit('error', netErr(m.error));
        });
        await call('subscribe', { sid });
        this.emit('listening');
      })();
      this._ready.catch((err) => this.emit('error', netErr(err, { address, port })));
      return this._ready;
    }
    bind(...args) {
      let cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      let o = typeof args[0] === 'object' && args[0] ? args[0] : { port: args[0], address: args[1] };
      if (cb) this.once('listening', cb);
      this._ensure(o.port, o.address);
      return this;
    }
    send(msg, ...args) {
      let cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      let offset = 0;
      let length;
      if (typeof args[0] === 'number' && typeof args[1] === 'number' && args.length >= 3) [offset, length] = args.splice(0, 2);
      let [port, address] = args;
      let data = Array.isArray(msg) ? Buffer.concat(msg.map((m) => Buffer.from(m))) : Buffer.from(msg);
      if (length != null) data = data.subarray(offset, offset + length);
      (async () => {
        await this._ensure();
        let to = port != null ? { addr: await lookup4(address || 'localhost'), port } : {};
        await call('send', { sid: this._sid, data: new Uint8Array(data), addr: to.addr, port: to.port });
        cb?.(null, data.length);
      })().catch((err) => (cb ? cb(netErr(err)) : this.emit('error', netErr(err))));
    }
    connect(port, address, cb) {
      if (typeof address === 'function') [address, cb] = [undefined, address];
      (async () => {
        await this._ensure();
        let addr = await lookup4(address || 'localhost');
        await call('connect', { sid: this._sid, addr, port });
        this._connected = { address: addr, family: 'IPv4', port };
        this.emit('connect');
        cb?.();
      })().catch((err) => this.emit('error', netErr(err)));
    }
    disconnect() {
      this._connected = null;
    }
    remoteAddress() {
      if (!this._connected) throw Object.assign(new Error('Not connected'), { code: 'ERR_SOCKET_DGRAM_NOT_CONNECTED' });
      return this._connected;
    }
    address() {
      if (!this._addr) throw Object.assign(new Error('getsockname EBADF'), { code: 'EBADF' });
      return { address: this._addr.addr, family: 'IPv4', port: this._addr.port };
    }
    setBroadcast(flag) {
      this._ensure().then(() => call('setopt', { sid: this._sid, opt: 'broadcast', value: !!flag }));
    }
    setTTL() {}
    setMulticastTTL() {}
    setMulticastLoopback() {}
    addMembership() {}
    dropMembership() {}
    setRecvBufferSize() {}
    setSendBufferSize() {}
    close(cb) {
      if (cb) this.once('close', cb);
      if (this._sid != null) {
        handlers.delete(this._sid);
        call('close', { sid: this._sid }).catch(() => {});
      }
      this._release?.();
      this._release = null;
      queueMicrotask(() => this.emit('close'));
      return this;
    }
    ref() {
      if (this._sid != null) this._release ??= k.ref();
      return this;
    }
    unref() {
      this._release?.();
      this._release = null;
      return this;
    }
  }
  let dgram = { createSocket: (o, cb) => new DgramSocket(o, cb), Socket: DgramSocket };

  /* ---------- dns ---------- */

  let servers = null;
  let dnsErr = (syscall, code, host) => Object.assign(new Error(`${syscall} ${code} ${host}`), { code, errno: undefined, syscall, hostname: host });
  async function resolveType(host, type) {
    let res;
    try {
      res = await call('query', { name: host, type, server: servers?.[0] });
    } catch (err) {
      throw dnsErr(`query${type}`, err.code === 'ETIMEDOUT' ? 'ETIMEOUT' : err.code || 'ESERVFAIL', host);
    }
    if (res.rcode === 3) throw dnsErr(`query${type}`, 'ENOTFOUND', host);
    if (res.rcode !== 0) throw dnsErr(`query${type}`, res.rcode === 5 ? 'EREFUSED' : 'ESERVFAIL', host);
    let num = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, SRV: 33 }[type];
    let ans = res.answers.filter((a) => a.type === num);
    if (!ans.length && type !== 'SOA') throw dnsErr(`query${type}`, 'ENODATA', host);
    switch (type) {
      case 'MX':
        return ans.map((a) => ({ priority: a.data.preference, exchange: a.data.exchange }));
      case 'TXT':
        return ans.map((a) => a.data);
      case 'SRV':
        return ans.map((a) => ({ priority: a.data.priority, weight: a.data.weight, port: a.data.port, name: a.data.target }));
      case 'SOA': {
        let s = ans[0] || res.authorities.find((a) => a.type === 6);
        if (!s) throw dnsErr('querySoa', 'ENODATA', host);
        return { nsname: s.data.mname, hostmaster: s.data.rname, serial: s.data.serial, refresh: s.data.refresh, retry: s.data.retry, expire: s.data.expire, minttl: s.data.minimum };
      }
      default:
        return ans.map((a) => a.data);
    }
  }
  let promises = {
    async lookup(host, opts = {}) {
      if (typeof opts === 'number') opts = { family: opts };
      if (opts.family === 6) throw dnsErr('getaddrinfo', 'ENOTFOUND', host);
      let ips;
      if (!host || host === 'localhost') ips = ['127.0.0.1'];
      else if (isIPv4(host)) ips = [host];
      else {
        try {
          ips = await call('lookup', { name: host });
        } catch (err) {
          throw dnsErr('getaddrinfo', err.code || 'ENOTFOUND', host);
        }
      }
      return opts.all ? ips.map((address) => ({ address, family: 4 })) : { address: ips[0], family: 4 };
    },
    resolve: (host, type = 'A') => resolveType(host, String(type).toUpperCase()),
    resolve4: (host) => resolveType(host, 'A'),
    resolve6: (host) => Promise.reject(dnsErr('queryAaaa', 'ENODATA', host)),
    resolveAny: (host) => resolveType(host, 'A').then((a) => a.map((address) => ({ address, ttl: 300, type: 'A' }))),
    resolveCname: (h) => resolveType(h, 'CNAME'),
    resolveMx: (h) => resolveType(h, 'MX'),
    resolveNs: (h) => resolveType(h, 'NS'),
    resolveTxt: (h) => resolveType(h, 'TXT'),
    resolveSrv: (h) => resolveType(h, 'SRV'),
    resolveSoa: (h) => resolveType(h, 'SOA'),
    resolvePtr: (h) => resolveType(h, 'PTR'),
    reverse: async (ip) => {
      try {
        return await call('reverse', { addr: ip });
      } catch (err) {
        throw dnsErr('getHostByAddr', err.code || 'ENOTFOUND', ip);
      }
    },
    setServers: (list) => {
      servers = list.map((s) => String(s).replace(/:\d+$/, ''));
    },
    getServers: () => servers || [],
  };
  promises.Resolver = class {
    constructor() {
      Object.assign(this, promises);
    }
    cancel() {}
  };
  let cbify = (fn) =>
    function (...args) {
      let cb = args.pop();
      fn(...args).then(
        (v) => cb(null, v),
        (e) => cb(e),
      );
    };
  let dns = {
    promises,
    lookup(host, opts, cb) {
      if (typeof opts === 'function') [opts, cb] = [{}, opts];
      promises.lookup(host, opts).then(
        (r) => (Array.isArray(r) ? cb(null, r) : cb(null, r.address, r.family)),
        (e) => cb(e),
      );
    },
    setServers: promises.setServers,
    getServers: promises.getServers,
    ADDRCONFIG: 1024,
    V4MAPPED: 2048,
    ALL: 256,
    NODATA: 'ENODATA',
    NOTFOUND: 'ENOTFOUND',
    TIMEOUT: 'ETIMEOUT',
    SERVFAIL: 'ESERVFAIL',
    REFUSED: 'EREFUSED',
    CONNREFUSED: 'ECONNREFUSED',
  };
  for (let k2 of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolveSoa', 'resolvePtr', 'reverse']) dns[k2] = cbify(promises[k2]);
  dns.Resolver = class {
    constructor() {
      Object.assign(this, dns);
    }
    cancel() {}
  };

  /* ---------- http ---------- */
  let http = createHttp(net);
  let readFile = (p) => new TextDecoder().decode(new Uint8Array(k.sys.sync('readFile', { path: p })));
  let { tls, httpsTransport } = createTls({ net, readFile, ref: k.ref });
  let https = { ...createHttp(httpsTransport, 443), Agent: http.Agent, globalAgent: http.globalAgent };

  return { net, dgram, dns, 'dns/promises': promises, http, https, tls };
}

/* ---------- HTTP/1.1 over net ---------- */

let STATUS_CODES = { 100: 'Continue', 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 206: 'Partial Content', 301: 'Moved Permanently', 302: 'Found', 303: 'See Other', 304: 'Not Modified', 307: 'Temporary Redirect', 308: 'Permanent Redirect', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 408: 'Request Timeout', 409: 'Conflict', 413: 'Payload Too Large', 418: "I'm a Teapot", 429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };
let METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'CONNECT', 'TRACE'];

/** Incremental HTTP/1.x message parser: feed(buf) → calls onHead(head) and body chunks/onEnd. */
class HttpParser {
  constructor(kind, { onHead, onBody, onEnd, onError }) {
    this.kind = kind; // 'request' | 'response'
    this.buf = Buffer.alloc(0);
    this.state = 'head';
    Object.assign(this, { onHead, onBody, onEnd, onError });
  }
  feed(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this.state === 'head') {
        let i = this.buf.indexOf('\r\n\r\n');
        if (i === -1) {
          if (this.buf.length > 64 * 1024) this.onError(new Error('Header overflow'));
          return;
        }
        let lines = this.buf.subarray(0, i).toString('latin1').split('\r\n');
        this.buf = this.buf.subarray(i + 4);
        let first = lines.shift();
        let head = { headers: {}, rawHeaders: [] };
        if (this.kind === 'request') {
          let m = /^([A-Z]+) (\S+) HTTP\/(\d\.\d)$/.exec(first);
          if (!m) return this.onError(Object.assign(new Error('Parse Error: Invalid method'), { code: 'HPE_INVALID_METHOD' }));
          [, head.method, head.url, head.httpVersion] = m;
        } else {
          let m = /^HTTP\/(\d\.\d) (\d{3})(?: (.*))?$/.exec(first);
          if (!m) return this.onError(Object.assign(new Error('Parse Error: Invalid response status'), { code: 'HPE_INVALID_STATUS' }));
          head.httpVersion = m[1];
          head.statusCode = Number(m[2]);
          head.statusMessage = m[3] || '';
        }
        for (let l of lines) {
          let c = l.indexOf(':');
          if (c <= 0) continue;
          let name = l.slice(0, c).trim();
          let value = l.slice(c + 1).trim();
          head.rawHeaders.push(name, value);
          let key = name.toLowerCase();
          if (key === 'set-cookie') (head.headers[key] ||= []).push(value);
          else head.headers[key] = key in head.headers ? head.headers[key] + ', ' + value : value;
        }
        let te = String(head.headers['transfer-encoding'] || '').toLowerCase();
        this.remaining = te.includes('chunked') ? -1 : head.headers['content-length'] != null ? Number(head.headers['content-length']) : this.kind === 'request' || this.noBody?.(head) ? 0 : Infinity;
        if (this.kind === 'response' && (head.statusCode === 204 || head.statusCode === 304 || (head.statusCode >= 100 && head.statusCode < 200) || this.noBody?.(head))) this.remaining = 0;
        this.state = this.remaining === -1 ? 'chunk-size' : 'body';
        this.onHead(head);
        if (this.state === 'body' && this.remaining === 0) {
          this.state = 'head';
          this.onEnd();
        }
        continue;
      }
      if (this.state === 'body') {
        if (!this.buf.length) return;
        let n = Math.min(this.buf.length, this.remaining);
        this.onBody(this.buf.subarray(0, n));
        this.buf = this.buf.subarray(n);
        this.remaining -= n;
        if (this.remaining === 0) {
          this.state = 'head';
          this.onEnd();
          continue;
        }
        return;
      }
      if (this.state === 'chunk-size') {
        let i = this.buf.indexOf('\r\n');
        if (i === -1) return;
        let size = parseInt(this.buf.subarray(0, i).toString('latin1'), 16);
        this.buf = this.buf.subarray(i + 2);
        if (!(size >= 0)) return this.onError(new Error('Parse Error: Invalid character in chunk size'));
        if (size === 0) this.state = 'trailer';
        else {
          this.remaining = size;
          this.state = 'chunk';
        }
        continue;
      }
      if (this.state === 'chunk') {
        if (this.buf.length < this.remaining + 2) {
          if (this.buf.length > this.remaining) {
            // wait for CRLF
            return;
          }
          if (this.buf.length) {
            this.onBody(this.buf);
            this.remaining -= this.buf.length;
            this.buf = Buffer.alloc(0);
          }
          return;
        }
        this.onBody(this.buf.subarray(0, this.remaining));
        this.buf = this.buf.subarray(this.remaining + 2);
        this.state = 'chunk-size';
        continue;
      }
      if (this.state === 'trailer') {
        let i = this.buf.indexOf('\r\n');
        if (i === -1) return;
        let line = this.buf.subarray(0, i);
        this.buf = this.buf.subarray(i + 2);
        if (!line.length) {
          this.state = 'head';
          this.onEnd();
        }
        continue;
      }
      return;
    }
  }
  /** Connection closed: ends a read-until-close body. */
  close() {
    if (this.state === 'body' && this.remaining === Infinity) {
      this.state = 'head';
      this.onEnd();
    }
  }
}

class IncomingMessage extends Readable {
  constructor(socket) {
    super();
    this.socket = this.connection = socket;
    this.headers = {};
    this.rawHeaders = [];
    this.trailers = {};
    this.complete = false;
  }
  _read() {}
  setTimeout(ms, cb) {
    this.socket.setTimeout(ms, cb);
    return this;
  }
}

class OutgoingMessage extends Writable {
  constructor() {
    // Finishing a request/response must not destroy it (that would close the socket before the reply).
    super({ autoDestroy: false });
    this._headers = new Map(); // lower → [name, value]
    this.headersSent = false;
    this._chunked = false;
    this.finished = false;
  }
  setHeader(name, value) {
    this._headers.set(String(name).toLowerCase(), [name, value]);
    return this;
  }
  getHeader(name) {
    return this._headers.get(String(name).toLowerCase())?.[1];
  }
  getHeaders() {
    return Object.fromEntries([...this._headers].map(([k, [, v]]) => [k, v]));
  }
  getHeaderNames() {
    return [...this._headers.keys()];
  }
  hasHeader(name) {
    return this._headers.has(String(name).toLowerCase());
  }
  removeHeader(name) {
    this._headers.delete(String(name).toLowerCase());
  }
  flushHeaders() {
    this._sendHead();
  }
  _headerBlock(first) {
    let lines = [first];
    for (let [, [name, value]] of this._headers) for (let v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    return lines.join('\r\n') + '\r\n\r\n';
  }
  _write(chunk, enc, cb) {
    let b = typeof chunk === 'string' ? Buffer.from(chunk, enc) : Buffer.from(chunk);
    this._sendHead(b.length);
    if (this._noBody || !b.length) return cb();
    if (this._chunked) this._sock.write(b.length.toString(16) + '\r\n');
    this._sock.write(b);
    if (this._chunked) this._sock.write('\r\n');
    cb();
  }
  _final(cb) {
    this._sendHead(0, true);
    if (this._chunked && !this._noBody) this._sock.write('0\r\n\r\n');
    this.finished = true;
    this._done?.();
    cb();
  }
}

function createHttp(net, defaultPort = 80) {
  class ServerResponse extends OutgoingMessage {
    constructor(req, sock, server) {
      super();
      this.req = req;
      this._sock = this.socket = this.connection = sock;
      this.statusCode = 200;
      this.statusMessage = undefined;
      this.sendDate = true;
      this._noBody = req.method === 'HEAD';
      this._server = server;
    }
    writeHead(code, msg, headers) {
      if (typeof msg === 'object') [msg, headers] = [undefined, msg];
      this.statusCode = code;
      if (msg) this.statusMessage = msg;
      if (Array.isArray(headers)) for (let i = 0; i < headers.length; i += 2) this.setHeader(headers[i], headers[i + 1]);
      else for (let [k, v] of Object.entries(headers || {})) this.setHeader(k, v);
      return this;
    }
    _sendHead(firstLen = 0, ending = false) {
      if (this.headersSent) return;
      this.headersSent = true;
      if (this.sendDate && !this.hasHeader('date')) this.setHeader('Date', new Date().toUTCString());
      let keep = this.req.headers.connection?.toLowerCase() !== 'close' && this.req.httpVersion === '1.1' && !this._server._closing;
      if (!this.hasHeader('connection')) this.setHeader('Connection', keep ? 'keep-alive' : 'close');
      if (keep && !this.hasHeader('keep-alive')) this.setHeader('Keep-Alive', 'timeout=5');
      if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') && this.statusCode !== 204 && this.statusCode !== 304) {
        if (ending) this.setHeader('Content-Length', firstLen);
        else {
          this.setHeader('Transfer-Encoding', 'chunked');
          this._chunked = true;
        }
      }
      this._keep = keep && String(this.getHeader('connection')).toLowerCase() !== 'close';
      this._sock.write(this._headerBlock(`HTTP/1.1 ${this.statusCode} ${this.statusMessage || STATUS_CODES[this.statusCode] || 'Unknown'}`));
    }
    end(data, enc, cb) {
      if (typeof data === 'function') [data, cb] = [undefined, data];
      if (data != null && !this.headersSent && !this.hasHeader('content-length')) {
        let b = typeof data === 'string' ? Buffer.from(data, enc) : Buffer.from(data);
        this.setHeader('Content-Length', b.length);
        data = b;
      }
      return super.end(data, enc, cb);
    }
  }

  class Server extends net.Server {
    constructor(opts, handler) {
      if (typeof opts === 'function') [opts, handler] = [{}, opts];
      super(opts);
      if (handler) this.on('request', handler);
      this.timeout = 0;
      this.keepAliveTimeout = 5000;
      this.headersTimeout = 60000;
      this.requestTimeout = 300000;
      this.on('connection', (sock) => this._serve(sock));
    }
    _serve(sock) {
      let queue = [];
      let busy = false;
      let current = null;
      let next = () => {
        if (busy || !queue.length) return;
        busy = true;
        let { req, res } = queue.shift();
        res._done = () => {
          busy = false;
          if (!res._keep) sock.end();
          else next();
        };
        this.emit('request', req, res);
      };
      let parser = new HttpParser('request', {
        onHead: (h) => {
          let req = new IncomingMessage(sock);
          Object.assign(req, h);
          req.httpVersionMajor = Number(h.httpVersion[0]);
          req.httpVersionMinor = Number(h.httpVersion[2]);
          current = req;
          let res = new ServerResponse(req, sock, this);
          if (String(h.headers.expect || '').toLowerCase() === '100-continue') sock.write('HTTP/1.1 100 Continue\r\n\r\n');
          queue.push({ req, res });
          next();
        },
        onBody: (b) => current?.push(Buffer.from(b)),
        onEnd: () => {
          if (current) {
            current.complete = true;
            current.push(null);
          }
        },
        onError: (err) => {
          this.emit('clientError', err, sock);
          if (!this.listenerCount('clientError')) {
            sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          }
        },
      });
      sock.on('data', (d) => parser.feed(d));
      sock.on('end', () => parser.close());
      sock.on('error', () => {});
    }
    setTimeout(ms, cb) {
      this.timeout = ms;
      if (cb) this.on('timeout', cb);
      return this;
    }
    closeAllConnections() {
      for (let s of this._conns) s.destroy();
    }
    closeIdleConnections() {}
  }

  class ClientRequest extends OutgoingMessage {
    constructor(opts, cb) {
      super();
      this.method = String(opts.method || 'GET').toUpperCase();
      this.path = opts.path || '/';
      this.host = opts.hostname || opts.host || 'localhost';
      this.port = Number(opts.port) || defaultPort;
      this._noBody = false;
      for (let [k, v] of Object.entries(opts.headers || {})) this.setHeader(k, v);
      if (!this.hasHeader('host')) this.setHeader('Host', this.port === defaultPort ? this.host : `${this.host}:${this.port}`);
      if (!this.hasHeader('connection')) this.setHeader('Connection', 'close');
      if (cb) this.once('response', cb);
      // TLS options ride along for https (ignored by plain net.connect).
      let tlsOpts = {};
      for (let k2 of ['ca', 'cert', 'key', 'rejectUnauthorized', 'servername', 'checkServerIdentity', 'ALPNProtocols', 'secureContext']) if (opts[k2] !== undefined) tlsOpts[k2] = opts[k2];
      if (opts.agent?.options) for (let k2 of ['ca', 'rejectUnauthorized']) if (tlsOpts[k2] === undefined && opts.agent.options[k2] !== undefined) tlsOpts[k2] = opts.agent.options[k2];
      let sock = net.connect({ ...tlsOpts, host: this.host, port: this.port, localAddress: opts.localAddress, timeout: opts.timeout });
      this._sock = this.socket = this.connection = sock;
      sock.on('connect', () => this.emit('socket', sock));
      sock.on('error', (err) => this.emit('error', err));
      let res = null;
      let parser = new HttpParser('response', {
        onHead: (h) => {
          if (h.statusCode === 100) return;
          res = new IncomingMessage(sock);
          Object.assign(res, h);
          this.res = res;
          this.emit('response', res);
        },
        onBody: (b) => res?.push(Buffer.from(b)),
        onEnd: () => {
          if (!res) return;
          res.complete = true;
          res.push(null);
          sock.end();
        },
        onError: (err) => this.emit('error', err),
      });
      parser.noBody = () => this.method === 'HEAD';
      sock.on('data', (d) => parser.feed(d));
      sock.on('end', () => {
        parser.close();
        if (!res) this.emit('error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));
      });
    }
    _sendHead(firstLen = 0, ending = false) {
      if (this.headersSent) return;
      this.headersSent = true;
      if (!this.hasHeader('content-length') && !this.hasHeader('transfer-encoding') && !['GET', 'HEAD', 'DELETE', 'OPTIONS', 'CONNECT'].includes(this.method)) {
        if (ending) this.setHeader('Content-Length', firstLen);
        else {
          this.setHeader('Transfer-Encoding', 'chunked');
          this._chunked = true;
        }
      }
      this._sock.write(this._headerBlock(`${this.method} ${this.path} HTTP/1.1`));
    }
    end(data, enc, cb) {
      if (typeof data === 'function') [data, cb] = [undefined, data];
      if (data != null && !this.headersSent && !this.hasHeader('content-length')) {
        let b = typeof data === 'string' ? Buffer.from(data, enc) : Buffer.from(data);
        this.setHeader('Content-Length', b.length);
        data = b;
      }
      return super.end(data, enc, cb);
    }
    abort() {
      this.destroy();
    }
    setTimeout(ms, cb) {
      this._sock.setTimeout(ms, cb);
      return this;
    }
    setNoDelay() {}
    setSocketKeepAlive() {}
    _destroy(err, cb) {
      this._sock.destroy();
      cb(err);
    }
  }

  let toOpts = (input, options, cb) => {
    if (typeof options === 'function') [options, cb] = [{}, options];
    let o = {};
    if (typeof input === 'string' || input instanceof URL) {
      let u = new URL(String(input));
      o = { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, auth: u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : undefined };
    } else if (input) [o, cb] = [{ ...input }, typeof options === 'function' ? options : cb];
    o = { ...o, ...(typeof options === 'object' ? options : {}) };
    if (o.auth) o.headers = { Authorization: 'Basic ' + Buffer.from(o.auth).toString('base64'), ...(o.headers || {}) };
    return { o, cb };
  };

  class Agent extends EventEmitter {
    constructor(opts) {
      super();
      this.options = opts || {};
      this.maxSockets = Infinity;
    }
    destroy() {}
  }

  return {
    STATUS_CODES,
    METHODS,
    Server,
    ServerResponse,
    IncomingMessage,
    ClientRequest,
    OutgoingMessage,
    Agent,
    globalAgent: new Agent(),
    maxHeaderSize: 16384,
    createServer: (opts, handler) => new Server(opts, handler),
    request(input, options, cb) {
      let { o, cb: c } = toOpts(input, options, cb);
      return new ClientRequest(o, c);
    },
    get(input, options, cb) {
      let { o, cb: c } = toOpts(input, options, cb);
      let req = new ClientRequest({ ...o, method: 'GET' }, c);
      req.end();
      return req;
    },
    validateHeaderName() {},
    validateHeaderValue() {},
  };
}
