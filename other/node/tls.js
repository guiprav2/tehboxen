/**
 * node:tls (and the transport under node:https) for the node runtime: real TLS 1.2/1.3 from
 * OpenSSL's libssl (toolchain/tls/tlsshim.wasm, built by ports/tlsshim) over the simulated
 * network's TCP sockets. The wasm side only ever sees memory BIOs; this file moves
 * ciphertext between them and a net.Socket, and plaintext between them and a Duplex.
 *
 * Trust: `ca` if given, else the box's /etc/ssl/certs/ca-certificates.crt (the world's
 * bundle). Clients verify the chain and the host name unless rejectUnauthorized: false.
 */
import { Buffer } from 'https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm';
import * as streamMod from 'https://cdn.jsdelivr.net/npm/readable-stream@4.7.0/+esm';

let { Duplex } = streamMod;
let SHIM_URL = new URL('../../toolchain/tls/tlsshim.wasm', import.meta.url);
let DEFAULT_CA = '/etc/ssl/certs/ca-certificates.crt';

/* ---------- the wasm engine (one per worker) ---------- */

let modulePromise = null;
let engineReady = null;

async function loadEngine() {
  modulePromise ??= WebAssembly.compileStreaming(fetch(SHIM_URL)).catch(async () => WebAssembly.compile(await (await fetch(SHIM_URL)).arrayBuffer()));
  let mod = await modulePromise;
  let inst;
  let mem = () => new Uint8Array(inst.exports.memory.buffer);
  let dv = () => new DataView(inst.exports.memory.buffer);
  let ENOSYS = 52;
  let wasi = {
    random_get(ptr, len) {
      let m = mem();
      for (let o = 0; o < len; o += 65536) crypto.getRandomValues(m.subarray(ptr + o, ptr + Math.min(len, o + 65536)));
      return 0;
    },
    clock_time_get(id, _prec, out) {
      let ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round(performance.now() * 1e6));
      dv().setBigUint64(out, ns, true);
      return 0;
    },
    environ_sizes_get(c, s) {
      dv().setUint32(c, 0, true);
      dv().setUint32(s, 0, true);
      return 0;
    },
    environ_get: () => 0,
    fd_write(fd, iovs, n, out) {
      let total = 0;
      for (let i = 0; i < n; i++) total += dv().getUint32(iovs + i * 8 + 4, true);
      dv().setUint32(out, total, true);
      return 0;
    },
    fd_prestat_get: () => 8, // EBADF: no preopens
    proc_exit(code) {
      throw new Error(`tlsshim exited (${code})`);
    },
  };
  let imports = {};
  for (let i of WebAssembly.Module.imports(mod)) {
    imports[i.module] ??= {};
    imports[i.module][i.name] = (i.module === 'wasi_snapshot_preview1' && wasi[i.name]) || (() => (i.name === 'getcwd' || i.name === 'tty_mode' ? -1 : ENOSYS));
  }
  inst = await WebAssembly.instantiate(mod, imports);
  inst.exports._initialize?.();
  let x = inst.exports;
  let cstr = (p) => {
    let m = mem();
    let e = p;
    while (m[e]) e++;
    return new TextDecoder().decode(m.subarray(p, e));
  };
  /** Copy bytes/string into wasm memory (NUL-terminated); caller frees. */
  let put = (data) => {
    let b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    let p = x.tb_malloc(b.length + 1);
    let m = mem();
    m.set(b, p);
    m[p + b.length] = 0;
    return [p, b.length];
  };
  let withBuf = (data, fn) => {
    let [p, n] = put(data);
    try {
      return fn(p, n);
    } finally {
      x.tb_free(p);
    }
  };
  let scratch = x.tb_malloc(65536);
  return {
    error: () => cstr(x.tbtls_error()),
    ctxNew: (server) => x.tbtls_ctx_new(server ? 1 : 0),
    ctxFree: (c) => x.tbtls_ctx_free(c),
    ctxCert: (c, pem) => withBuf(pem, (p, n) => x.tbtls_ctx_cert(c, p, n)),
    ctxKey: (c, pem) => withBuf(pem, (p, n) => x.tbtls_ctx_key(c, p, n)),
    ctxCa: (c, pem) => withBuf(pem, (p, n) => x.tbtls_ctx_ca(c, p, n)),
    ctxVerify: (c, mode) => x.tbtls_ctx_verify(c, mode),
    ctxAlpn: (c, server, protos) => {
      let wire = [];
      for (let s of protos) {
        let b = new TextEncoder().encode(s);
        wire.push(b.length, ...b);
      }
      return withBuf(new Uint8Array(wire), (p, n) => x.tbtls_ctx_alpn(c, server ? 1 : 0, p, n));
    },
    connNew: (c, server, host, verifyHost) => withBuf(host || '', (p) => x.tbtls_new(c, server ? 1 : 0, p, verifyHost ? 1 : 0)),
    handshake: (t) => x.tbtls_handshake(t),
    feed(t, bytes) {
      for (let o = 0; o < bytes.length; o += 65536) {
        let part = bytes.subarray(o, o + 65536);
        mem().set(part, scratch);
        x.tbtls_feed(t, scratch, part.length);
      }
    },
    takeOut(t) {
      let chunks = [];
      while (x.tbtls_out_pending(t) > 0) {
        let n = x.tbtls_out_take(t, scratch, 65536);
        if (n <= 0) break;
        chunks.push(Buffer.from(mem().slice(scratch, scratch + n)));
      }
      return chunks.length ? Buffer.concat(chunks) : null;
    },
    /** Plaintext: Buffer, 'want', 'closed' or 'error'. */
    read(t) {
      let n = x.tbtls_read(t, scratch, 65536);
      if (n > 0) return Buffer.from(mem().slice(scratch, scratch + n));
      return n === -2 ? 'want' : n === 0 ? 'closed' : 'error';
    },
    write(t, bytes) {
      let o = 0;
      while (o < bytes.length) {
        let part = bytes.subarray(o, o + 16384);
        mem().set(part, scratch);
        let n = x.tbtls_write(t, scratch, part.length);
        if (n <= 0) return n === -2 ? o : -1;
        o += n;
      }
      return o;
    },
    shutdown: (t) => x.tbtls_shutdown(t),
    free: (t) => x.tbtls_free(t),
    verifyResult: (t) => x.tbtls_verify_result(t),
    verifyString: (code) => cstr(x.tbtls_verify_string(code)),
    info: (t) => cstr(x.tbtls_info(t)).split('\t'),
  };
}

let engine = () => (engineReady ??= loadEngine());

/* Node's error codes for OpenSSL's X509_V_ERR_* (the ones a CA hierarchy produces). */
let VERIFY_CODES = {
  2: 'UNABLE_TO_GET_ISSUER_CERT',
  10: 'CERT_HAS_EXPIRED',
  9: 'CERT_NOT_YET_VALID',
  18: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  19: 'SELF_SIGNED_CERT_IN_CHAIN',
  20: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  21: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  62: 'ERR_TLS_CERT_ALTNAME_INVALID',
  64: 'ERR_TLS_CERT_ALTNAME_INVALID',
};

let isIp = (h) => /^\d+\.\d+\.\d+\.\d+$/.test(h || '') || String(h || '').includes(':');
let pemOf = (v) => (v == null ? null : Array.isArray(v) ? v.map(pemOf).join('\n') : Buffer.isBuffer(v) || v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : String(v));

export function createTls({ net, readFile, ref }) {
  /** A secure context: { ctx, server } in the engine (contexts are reused across connections). */
  class SecureContext {
    constructor(opts = {}, server = false) {
      this.opts = opts;
      this.server = server;
      this.ready = engine().then((E) => {
        let c = E.ctxNew(server);
        if (!c) throw new Error('tls: ' + E.error());
        let cert = pemOf(opts.cert);
        let key = pemOf(opts.key);
        if (cert && E.ctxCert(c, cert) < 0) throw Object.assign(new Error('tls: certificate: ' + E.error()), { code: 'ERR_OSSL_PEM' });
        if (key && E.ctxKey(c, key) < 0) throw Object.assign(new Error('tls: private key: ' + E.error()), { code: 'ERR_OSSL_PEM' });
        let ca = pemOf(opts.ca);
        if (ca == null && (!server || opts.requestCert)) {
          try {
            ca = readFile(DEFAULT_CA);
          } catch {
            ca = '';
          }
        }
        if (ca) E.ctxCa(c, ca);
        if (opts.ALPNProtocols?.length) E.ctxAlpn(c, server, opts.ALPNProtocols.map(String));
        // Verification results are checked after the handshake (Node semantics: rejectUnauthorized
        // decides), so the handshake itself never fails on the chain — except a server that
        // requires client certificates.
        E.ctxVerify(c, server ? (opts.requestCert ? (opts.rejectUnauthorized !== false ? 2 : 1) : 0) : 1);
        this.ctx = c;
        this.E = E;
        return this;
      });
      this.ready.catch(() => {});
    }
  }

  let defaultClientCtx = null;
  let clientCtx = (o) => {
    if (o.secureContext) return o.secureContext;
    if (o.ca || o.cert || o.key || o.ALPNProtocols) return new SecureContext(o, false);
    return (defaultClientCtx ??= new SecureContext({}, false));
  };

  class TLSSocket extends Duplex {
    constructor(socket, opts = {}) {
      super({ allowHalfOpen: false, decodeStrings: true });
      this._raw = socket || new net.Socket();
      this._opts = opts;
      this._server = !!opts.isServer;
      this._ctx = opts.secureContext || (this._server ? null : clientCtx(opts));
      this._conn = null;
      this._E = null;
      this._secure = false;
      this._pendingIn = [];
      this._pendingWrites = [];
      this._release = ref();
      this.encrypted = true;
      this.authorized = false;
      this.authorizationError = null;
      this.servername = opts.servername || (!this._server && !isIp(opts.host) ? opts.host : undefined);
      this.alpnProtocol = false;
      let raw = this._raw;
      raw.on('data', (d) => this._onCipher(d));
      raw.on('end', () => {
        if (!this._secure) return this.destroy(Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }));
        this.push(null);
      });
      raw.on('close', () => this.destroy());
      raw.on('error', (err) => this.destroy(err));
      raw.on('timeout', () => this.emit('timeout'));
      if (raw.connecting === false && raw.remoteAddress) this._start();
      else raw.once('connect', () => this._start());
    }
    get remoteAddress() {
      return this._raw.remoteAddress;
    }
    get remotePort() {
      return this._raw.remotePort;
    }
    get remoteFamily() {
      return this._raw.remoteFamily;
    }
    get localAddress() {
      return this._raw.localAddress;
    }
    get localPort() {
      return this._raw.localPort;
    }
    get connecting() {
      return !this._secure;
    }
    get bytesWritten() {
      return this._raw.bytesWritten;
    }
    address() {
      return this._raw.address?.();
    }
    setTimeout(ms, cb) {
      this._raw.setTimeout(ms);
      if (cb) this.once('timeout', cb);
      return this;
    }
    setNoDelay() {
      return this;
    }
    setKeepAlive() {
      return this;
    }
    ref() {
      this._raw.ref?.();
      return this;
    }
    unref() {
      this._raw.unref?.();
      return this;
    }

    async _start() {
      try {
        let sc = await this._ctx.ready;
        if (this.destroyed) return;
        this._E = sc.E;
        let verifyHost = !this._server && this._opts.rejectUnauthorized !== false && !this._opts.checkServerIdentity;
        this._conn = this._E.connNew(sc.ctx, this._server, this._server ? '' : this._opts.servername || this._opts.host || '', verifyHost);
        if (!this._conn) throw new Error('tls: ' + this._E.error());
        for (let d of this._pendingIn.splice(0)) this._E.feed(this._conn, d);
        this._pump();
      } catch (err) {
        this.destroy(err);
      }
    }

    _onCipher(d) {
      if (!this._conn) return this._pendingIn.push(new Uint8Array(d));
      this._E.feed(this._conn, new Uint8Array(d));
      this._pump();
    }

    _flushOut() {
      let out = this._conn && this._E.takeOut(this._conn);
      if (out && !this._raw.destroyed) this._raw.write(out);
    }

    _pump() {
      if (!this._conn || this.destroyed) return;
      let E = this._E;
      if (!this._secure) {
        let r = E.handshake(this._conn);
        this._flushOut();
        if (r < 0) {
          let code = E.verifyResult(this._conn);
          let err = code ? Object.assign(new Error(E.verifyString(code)), { code: VERIFY_CODES[code] || 'ERR_TLS_HANDSHAKE' }) : Object.assign(new Error(E.error()), { code: 'ERR_SSL_HANDSHAKE_FAILURE' });
          return this.destroy(err);
        }
        if (r === 0) return;
        this._secure = true;
        let info = E.info(this._conn);
        this._info = info;
        this.alpnProtocol = info[2] || false;
        let code = E.verifyResult(this._conn);
        if (!this._server || this._opts.requestCert) {
          this.authorized = code === 0;
          if (code) this.authorizationError = VERIFY_CODES[code] || E.verifyString(code);
        }
        if (!this._server && this._opts.checkServerIdentity && code === 0) {
          let bad = this._opts.checkServerIdentity(this.servername || this._opts.host, this.getPeerCertificate());
          if (bad) return this.destroy(bad);
        }
        if (!this._server && !this.authorized && this._opts.rejectUnauthorized !== false) {
          let err = Object.assign(new Error(code === 62 || code === 64 ? `Hostname/IP does not match certificate's altnames: Host: ${this.servername || this._opts.host}. is not in the cert's altnames: ${info[7] || 'none'}` : E.verifyString(code)), { code: VERIFY_CODES[code] || 'ERR_TLS_CERT' });
          return this.destroy(err);
        }
        for (let w of this._pendingWrites.splice(0)) this._writeNow(w.chunk, w.cb);
        this.emit(this._server ? 'secure' : 'secureConnect');
        if (!this._server) this.emit('connect');
      }
      for (;;) {
        let r = E.read(this._conn);
        if (r === 'want') break;
        if (r === 'closed') {
          this.push(null);
          break;
        }
        if (r === 'error') {
          this.destroy(Object.assign(new Error(E.error()), { code: 'ERR_SSL_READ' }));
          break;
        }
        this.push(r);
      }
      this._flushOut();
    }

    _writeNow(chunk, cb) {
      let n = this._E.write(this._conn, new Uint8Array(chunk));
      this._flushOut();
      if (n < 0) return cb(Object.assign(new Error(this._E.error()), { code: 'ERR_SSL_WRITE' }));
      cb();
    }

    _write(chunk, enc, cb) {
      if (!this._secure) return this._pendingWrites.push({ chunk, cb });
      this._writeNow(chunk, cb);
    }

    _read() {}

    _final(cb) {
      if (this._conn && this._secure) {
        this._E.shutdown(this._conn);
        this._flushOut();
      }
      this._raw.end();
      cb();
    }

    _destroy(err, cb) {
      if (this._conn) {
        this._E.free(this._conn);
        this._conn = null;
      }
      this._release?.();
      this._release = null;
      if (!this._raw.destroyed) this._raw.destroy();
      cb(err);
    }

    getProtocol() {
      return this._info?.[0] || null;
    }
    getCipher() {
      return this._info ? { name: this._info[1], standardName: this._info[1], version: this._info[0] } : null;
    }
    getPeerCertificate() {
      let i = this._info;
      if (!i || !i[3]) return {};
      return { subject: { CN: i[3] }, issuer: { CN: i[4], O: i[5] }, valid_to: i[6], subjectaltname: i[7], serialNumber: i[8] };
    }
    isSessionReused() {
      return false;
    }
  }

  let connect = (...args) => {
    let cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
    let o = typeof args[0] === 'object' && args[0] ? { ...args[0] } : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost', ...(typeof args[1] === 'object' ? args[1] : args[2] || {}) };
    o.host ??= o.hostname || 'localhost';
    let raw = o.socket || net.connect({ host: o.host, port: Number(o.port) || 443, localAddress: o.localAddress, timeout: o.timeout });
    let t = new TLSSocket(raw, o);
    if (cb) t.once('secureConnect', cb);
    return t;
  };

  class Server extends net.Server {
    constructor(opts, listener) {
      if (typeof opts === 'function') [opts, listener] = [{}, opts];
      super(opts);
      this._tlsOpts = opts || {};
      this._ctx = new SecureContext(this._tlsOpts, true);
      if (listener) this.on('secureConnection', listener);
    }
    setSecureContext(opts) {
      this._tlsOpts = { ...this._tlsOpts, ...opts };
      this._ctx = new SecureContext(this._tlsOpts, true);
    }
    /** Raw TCP connections become TLS sockets; 'connection' listeners see the secure socket. */
    emit(ev, ...a) {
      if (ev === 'connection' && a[0] && !(a[0] instanceof TLSSocket)) {
        let t = new TLSSocket(a[0], { ...this._tlsOpts, isServer: true, secureContext: this._ctx });
        t.server = this;
        t.once('secure', () => {
          super.emit('secureConnection', t);
          super.emit('connection', t);
        });
        t.on('error', (err) => {
          if (!t._secure) super.emit('tlsClientError', err, t);
        });
        return true;
      }
      return super.emit(ev, ...a);
    }
  }

  let tls = {
    TLSSocket,
    Server,
    SecureContext,
    connect,
    createServer: (opts, listener) => new Server(opts, listener),
    createSecureContext: (opts = {}) => new SecureContext(opts, false),
    checkServerIdentity: () => undefined,
    rootCertificates: [],
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    DEFAULT_ECDH_CURVE: 'auto',
    getCiphers: () => ['tls_aes_256_gcm_sha384', 'tls_chacha20_poly1305_sha256', 'tls_aes_128_gcm_sha256', 'ecdhe-ecdsa-aes256-gcm-sha384', 'ecdhe-rsa-aes256-gcm-sha384'],
  };

  /** What createHttp() needs as its "net" for https: TLS connections and a TLS server. */
  let httpsTransport = {
    Server,
    Socket: TLSSocket,
    connect: (o) => connect({ ...o, servername: o.servername ?? (isIp(o.host) ? undefined : o.host) }),
  };
  return { tls, httpsTransport };
}
