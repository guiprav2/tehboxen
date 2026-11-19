/**
 * Node core modules for the simulated node runtime — the same role as
 * browserify's builtins table (lib/builtins.js), but wired to the Tehboxen
 * VFS, shell and per-process runtime instead of browser shims.
 *
 * Networking (net/http/dns/tls/...) is deliberately not simulated yet: the
 * plan is fake servers compiled to WASM inside the VFS. Those modules load
 * but their functions throw ENOSYS so scripts fail with a clear message.
 */
import { Buffer } from 'https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm';
import eventsMod from 'https://cdn.jsdelivr.net/npm/events@3.3.0/+esm';
import * as streamMod from 'https://cdn.jsdelivr.net/npm/readable-stream@4.7.0/+esm';
import qs from 'https://cdn.jsdelivr.net/npm/querystring-es3@0.2.1/+esm';
import path from './path.js';
import { inspect, format, formatWithOptions } from './inspect.js';
import { NODE_VERSION, parseEnv } from './runtime.js';
import { createWasiModule } from './wasi.js';

export { Buffer };
export let EventEmitter = eventsMod.EventEmitter || eventsMod;

let enc = new TextEncoder();
let dec = new TextDecoder();

/** Core module names (as in `require('module').builtinModules`). */
export let BUILTIN_NAMES = [
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants',
  'crypto', 'dgram', 'diagnostics_channel', 'dns', 'dns/promises', 'domain', 'events', 'fs', 'fs/promises',
  'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'path/posix', 'path/win32',
  'perf_hooks', 'process', 'punycode', 'querystring', 'readline', 'readline/promises', 'repl', 'stream',
  'stream/consumers', 'stream/promises', 'stream/web', 'string_decoder', 'sys', 'timers', 'timers/promises',
  'tls', 'trace_events', 'tty', 'url', 'util', 'util/types', 'v8', 'vm', 'wasi', 'worker_threads', 'zlib',
];
/** Only reachable with the `node:` prefix, like real Node. */
let PREFIX_ONLY = new Set(['test', 'sqlite', 'sea', 'test/reporters']);

export function builtinName(id) {
  let s = String(id);
  let bare = s.startsWith('node:') ? s.slice(5) : s;
  if (BUILTIN_NAMES.includes(bare)) return bare;
  if (s.startsWith('node:') && PREFIX_ONLY.has(bare)) return bare;
  return null;
}

function enosys(what) {
  return () => {
    let err = new Error(`ENOSYS: ${what} is not simulated in Tehboxen yet`);
    err.code = 'ENOSYS';
    err.errno = -38;
    throw err;
  };
}
function stubModule(name, fns) {
  let m = {};
  for (let f of fns) m[f] = enosys(`${name}.${f}()`);
  return m;
}

/* ---------- events extras ---------- */
function eventsModule() {
  let E = EventEmitter;
  if (!E.on) {
    E.on = function on(emitter, event, options = {}) {
      let queue = [];
      let waiters = [];
      let error = null;
      let done = false;
      let handler = (...args) => {
        let w = waiters.shift();
        if (w) w.resolve({ value: args, done: false });
        else queue.push(args);
      };
      let errHandler = (err) => {
        error = err;
        let w = waiters.shift();
        if (w) w.reject(err);
      };
      emitter.on(event, handler);
      if (event !== 'error') emitter.on('error', errHandler);
      let cleanup = () => {
        done = true;
        emitter.removeListener(event, handler);
        emitter.removeListener('error', errHandler);
        for (let w of waiters.splice(0)) w.resolve({ value: undefined, done: true });
      };
      options.signal?.addEventListener('abort', cleanup);
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (error) return Promise.reject(error);
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
        },
        return() {
          cleanup();
          return Promise.resolve({ value: undefined, done: true });
        },
        throw(err) {
          cleanup();
          return Promise.reject(err);
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    };
  }
  E.EventEmitter = E;
  E.setMaxListeners ??= () => {};
  E.getEventListeners ??= (em, name) => em.listeners(name);
  E.errorMonitor ??= Symbol('events.errorMonitor');
  E.captureRejections ??= false;
  E.EventEmitterAsyncResource ??= E;
  E.addAbortListener ??= (signal, fn) => {
    signal.addEventListener('abort', fn, { once: true });
    return { [Symbol.dispose]: () => signal.removeEventListener('abort', fn) };
  };
  return E;
}

/* ---------- util ---------- */
function utilModule() {
  let custom = Symbol.for('nodejs.util.promisify.custom');
  function promisify(fn) {
    if (typeof fn !== 'function') throw Object.assign(new TypeError('The "original" argument must be of type function'), { code: 'ERR_INVALID_ARG_TYPE' });
    if (fn[custom]) return fn[custom];
    let p = function (...args) {
      return new Promise((resolve, reject) => {
        fn.call(this, ...args, (err, ...values) => (err ? reject(err) : resolve(values.length > 1 ? values : values[0])));
      });
    };
    Object.setPrototypeOf(p, Object.getPrototypeOf(fn));
    return Object.defineProperties(p, Object.getOwnPropertyDescriptors(fn));
  }
  promisify.custom = custom;
  let tag = (v) => Object.prototype.toString.call(v).slice(8, -1);
  let types = {
    isPromise: (v) => v instanceof Promise,
    isDate: (v) => v instanceof Date,
    isRegExp: (v) => v instanceof RegExp,
    isMap: (v) => v instanceof Map,
    isSet: (v) => v instanceof Set,
    isWeakMap: (v) => v instanceof WeakMap,
    isWeakSet: (v) => v instanceof WeakSet,
    isNativeError: (v) => v instanceof Error,
    isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
    isUint8Array: (v) => v instanceof Uint8Array,
    isArrayBuffer: (v) => v instanceof ArrayBuffer,
    isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer),
    isArrayBufferView: (v) => ArrayBuffer.isView(v),
    isDataView: (v) => v instanceof DataView,
    isAsyncFunction: (v) => tag(v) === 'AsyncFunction',
    isGeneratorFunction: (v) => /GeneratorFunction$/.test(tag(v)),
    isGeneratorObject: (v) => tag(v) === 'Generator',
    isBoxedPrimitive: (v) => v instanceof Number || v instanceof String || v instanceof Boolean,
    isProxy: () => false,
    isSymbolObject: (v) => tag(v) === 'Symbol' && typeof v === 'object',
    isKeyObject: () => false,
    isCryptoKey: (v) => typeof CryptoKey !== 'undefined' && v instanceof CryptoKey,
  };
  function isDeepStrictEqual(a, b, seen = new Map()) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    if (seen.get(a) === b) return true;
    seen.set(a, b);
    if (a instanceof Date) return a.getTime() === b.getTime();
    if (a instanceof RegExp) return String(a) === String(b);
    if (ArrayBuffer.isView(a)) return a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
    if (a instanceof Map) {
      if (a.size !== b.size) return false;
      for (let [k, v] of a) if (!b.has(k) || !isDeepStrictEqual(v, b.get(k), seen)) return false;
      return true;
    }
    if (a instanceof Set) {
      if (a.size !== b.size) return false;
      for (let v of a) if (!b.has(v)) return false;
      return true;
    }
    let ka = Reflect.ownKeys(a).filter((k) => Object.prototype.propertyIsEnumerable.call(a, k));
    let kb = Reflect.ownKeys(b).filter((k) => Object.prototype.propertyIsEnumerable.call(b, k));
    if (ka.length !== kb.length) return false;
    for (let k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !isDeepStrictEqual(a[k], b[k], seen)) return false;
    return true;
  }
  let debugEnv = () => String(globalThis.__tehboxenNodeDebug || '');
  let STYLE = { reset: [0, 0], bold: [1, 22], dim: [2, 22], italic: [3, 23], underline: [4, 24], inverse: [7, 27], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], magenta: [35, 39], cyan: [36, 39], white: [37, 39], gray: [90, 39], grey: [90, 39] };
  return {
    inspect,
    format,
    formatWithOptions,
    promisify,
    callbackify: (fn) => (...args) => {
      let cb = args.pop();
      fn(...args).then((v) => cb(null, v), (e) => cb(e || new Error('Promise was rejected with falsy value')));
    },
    inherits(ctor, superCtor) {
      Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true });
      Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
    },
    deprecate(fn, msg, code) {
      let warned = false;
      return function (...args) {
        if (!warned) {
          warned = true;
          globalThis.__tehboxenProcess?.emitWarning(msg, 'DeprecationWarning', code);
        }
        return new.target ? Reflect.construct(fn, args, new.target) : fn.apply(this, args);
      };
    },
    debuglog(section) {
      let on = new RegExp(`(^|,)\\s*(${section}|\\*)\\s*(,|$)`, 'i').test(debugEnv());
      let fn = (...a) => {
        if (on) globalThis.__tehboxenProcess?.stderr.write(`${String(section).toUpperCase()} ${globalThis.__tehboxenProcess?.pid}: ${format(...a)}\n`);
      };
      fn.enabled = on;
      return fn;
    },
    types,
    isDeepStrictEqual,
    isArray: Array.isArray,
    isBoolean: (v) => typeof v === 'boolean',
    isNull: (v) => v === null,
    isNumber: (v) => typeof v === 'number',
    isString: (v) => typeof v === 'string',
    isUndefined: (v) => v === undefined,
    isObject: (v) => v !== null && typeof v === 'object',
    isFunction: (v) => typeof v === 'function',
    isPrimitive: (v) => v === null || (typeof v !== 'object' && typeof v !== 'function'),
    isError: (v) => v instanceof Error,
    isDate: types.isDate,
    isRegExp: types.isRegExp,
    TextEncoder,
    TextDecoder,
    stripVTControlCharacters: (s) => String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''),
    styleText(styles, text) {
      let out = String(text);
      for (let s of [].concat(styles)) {
        let st = STYLE[s];
        if (st) out = `\x1b[${st[0]}m${out}\x1b[${st[1]}m`;
      }
      return out;
    },
    toUSVString: (s) => String(s).toWellFormed?.() ?? String(s),
    getSystemErrorName: (n) => ({ '-2': 'ENOENT', '-13': 'EACCES', '-17': 'EEXIST' })[n] || 'Unknown system error ' + n,
    aborted: (signal) => new Promise((r) => (signal.aborted ? r() : signal.addEventListener('abort', () => r(), { once: true }))),
    parseEnv,
    parseArgs,
  };
}

/** util.parseArgs (Node 18.3+), the commonly used subset. */
function parseArgs(config = {}) {
  let { args = (globalThis.__tehboxenProcess?.argv || []).slice(2), options = {}, strict = true, allowPositionals = !strict, tokens: wantTokens = false } = config;
  let values = Object.create(null);
  let positionals = [];
  let tokens = [];
  let shorts = {};
  for (let [name, o] of Object.entries(options)) if (o.short) shorts[o.short] = name;
  let err = (msg, code) => Object.assign(new TypeError(msg), { code });
  let store = (name, value, raw, index) => {
    let o = options[name];
    if (!o) {
      if (strict) throw err(`Unknown option '${raw}'`, 'ERR_PARSE_ARGS_UNKNOWN_OPTION');
      values[name] = value ?? true;
      return;
    }
    if (o.type === 'string' && value === undefined) throw err(`Option '${raw} <value>' argument missing`, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
    if (o.type === 'boolean' && value !== undefined && strict) throw err(`Option '${raw}' does not take an argument`, 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE');
    let v = o.type === 'boolean' ? true : value;
    if (o.multiple) (values[name] ??= []).push(v);
    else values[name] = v;
    tokens.push({ kind: 'option', name, rawName: raw, index, value: o.type === 'boolean' ? undefined : value, inlineValue: undefined });
  };
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (a === '--') {
      tokens.push({ kind: 'option-terminator', index: i });
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let [raw, inline] = a.includes('=') ? [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)] : [a, undefined];
      let name = raw.slice(2);
      let o = options[name];
      let value = inline;
      if (o?.type === 'string' && value === undefined && i + 1 < args.length) value = args[++i];
      store(name, value, raw, i);
    } else if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        let ch = a[j];
        let name = shorts[ch] ?? ch;
        let o = options[name];
        if (o?.type === 'string') {
          let value = a.slice(j + 1) || args[++i];
          store(name, value, '-' + ch, i);
          break;
        }
        store(name, undefined, '-' + ch, i);
      }
    } else {
      if (!allowPositionals) throw err(`Unexpected argument '${a}'. This command does not take positional arguments`, 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL');
      positionals.push(a);
      tokens.push({ kind: 'positional', index: i, value: a });
    }
  }
  for (let [name, o] of Object.entries(options)) if (values[name] === undefined && o.default !== undefined) values[name] = o.default;
  return wantTokens ? { values, positionals, tokens } : { values, positionals };
}

/* ---------- assert ---------- */
function assertModule(util) {
  class AssertionError extends Error {
    constructor(options = {}) {
      super(options.message || `${inspect(options.actual)} ${options.operator} ${inspect(options.expected)}`);
      this.name = 'AssertionError';
      this.code = 'ERR_ASSERTION';
      this.actual = options.actual;
      this.expected = options.expected;
      this.operator = options.operator;
      this.generatedMessage = !options.message;
    }
  }
  let fail = (actual, expected, message, operator, defaultMsg) => {
    if (message instanceof Error) throw message;
    throw new AssertionError({ actual, expected, operator, message: message ?? defaultMsg });
  };
  let looseEq = (a, b) => a == b || (a !== a && b !== b);
  function looseDeep(a, b) {
    if (looseEq(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    let ka = Object.keys(a);
    let kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => looseDeep(a[k], b[k]));
  }
  function matchesError(err, expected) {
    if (expected === undefined) return true;
    if (typeof expected === 'function') {
      if (expected.prototype !== undefined && err instanceof expected) return true;
      if (Error.isPrototypeOf(expected) || expected === Error) return false;
      return expected.call({}, err) === true;
    }
    if (expected instanceof RegExp) return expected.test(String(err));
    if (typeof expected === 'object') return Object.keys(expected).every((k) => (expected[k] instanceof RegExp ? expected[k].test(err[k]) : util.isDeepStrictEqual(err[k], expected[k])));
    return true;
  }
  let assert = (value, message) => assert.ok(value, message);
  Object.assign(assert, {
    AssertionError,
    ok: (v, m) => v || fail(v, true, m, '==', `The expression evaluated to a falsy value:\n\n  assert.ok(${inspect(v)})\n`),
    equal: (a, b, m) => looseEq(a, b) || fail(a, b, m, '=='),
    notEqual: (a, b, m) => !looseEq(a, b) || fail(a, b, m, '!='),
    strictEqual: (a, b, m) => Object.is(a, b) || fail(a, b, m, 'strictEqual', `Expected values to be strictly equal:\n\n${inspect(a)} !== ${inspect(b)}\n`),
    notStrictEqual: (a, b, m) => !Object.is(a, b) || fail(a, b, m, 'notStrictEqual', `Expected "actual" to be strictly unequal to: ${inspect(b)}`),
    deepEqual: (a, b, m) => looseDeep(a, b) || fail(a, b, m, 'deepEqual'),
    notDeepEqual: (a, b, m) => !looseDeep(a, b) || fail(a, b, m, 'notDeepEqual'),
    deepStrictEqual: (a, b, m) => util.isDeepStrictEqual(a, b) || fail(a, b, m, 'deepStrictEqual', `Expected values to be strictly deep-equal:\n${inspect(a)}\n\nshould equal\n\n${inspect(b)}`),
    notDeepStrictEqual: (a, b, m) => !util.isDeepStrictEqual(a, b) || fail(a, b, m, 'notDeepStrictEqual'),
    fail: (m = 'Failed') => fail(undefined, undefined, m, 'fail'),
    ifError: (v) => {
      if (v !== null && v !== undefined) throw v;
    },
    match: (s, re, m) => re.test(s) || fail(s, re, m, 'match', `The input did not match the regular expression ${re}. Input:\n\n${inspect(s)}\n`),
    doesNotMatch: (s, re, m) => !re.test(s) || fail(s, re, m, 'doesNotMatch'),
    throws(fn, expected, message) {
      if (typeof expected === 'string') ((message = expected), (expected = undefined));
      try {
        fn();
      } catch (err) {
        if (!matchesError(err, expected)) throw err;
        return;
      }
      fail(undefined, expected, message, 'throws', 'Missing expected exception.');
    },
    doesNotThrow(fn, message) {
      try {
        fn();
      } catch (err) {
        fail(err, undefined, message, 'doesNotThrow', `Got unwanted exception.\nActual message: "${err?.message}"`);
      }
    },
    async rejects(p, expected, message) {
      if (typeof expected === 'string') ((message = expected), (expected = undefined));
      try {
        await (typeof p === 'function' ? p() : p);
      } catch (err) {
        if (!matchesError(err, expected)) throw err;
        return;
      }
      fail(undefined, expected, message, 'rejects', 'Missing expected rejection.');
    },
    async doesNotReject(p, message) {
      try {
        await (typeof p === 'function' ? p() : p);
      } catch (err) {
        fail(err, undefined, message, 'doesNotReject', `Got unwanted rejection.\nActual message: "${err?.message}"`);
      }
    },
  });
  assert.strict = Object.assign((v, m) => assert.ok(v, m), assert, {
    equal: assert.strictEqual,
    notEqual: assert.notStrictEqual,
    deepEqual: assert.deepStrictEqual,
    notDeepEqual: assert.notDeepStrictEqual,
  });
  assert.strict.strict = assert.strict;
  return assert;
}

/* ---------- string_decoder ---------- */
class StringDecoder {
  constructor(encoding = 'utf8') {
    this.encoding = String(encoding).toLowerCase().replace('-', '');
    this._td = this.encoding === 'utf8' ? new TextDecoder('utf-8') : this.encoding === 'utf16le' || this.encoding === 'ucs2' ? new TextDecoder('utf-16le') : null;
  }
  write(buf) {
    if (typeof buf === 'string') return buf;
    if (this._td) return this._td.decode(buf, { stream: true });
    return Buffer.from(buf).toString(this.encoding);
  }
  end(buf) {
    let out = buf ? this.write(buf) : '';
    if (this._td) out += this._td.decode();
    return out;
  }
}

/* ---------- url ---------- */
function urlModule() {
  let fileURLToPath = (u) => {
    let url = typeof u === 'string' ? new URL(u) : u;
    if (url.protocol !== 'file:') throw Object.assign(new TypeError('The URL must be of scheme file'), { code: 'ERR_INVALID_URL_SCHEME' });
    return decodeURIComponent(url.pathname);
  };
  let pathToFileURL = (p) => new URL('file://' + encodeURI(path.resolve(String(p))).replace(/\?/g, '%3F').replace(/#/g, '%23'));
  function parse(str, parseQuery) {
    let u;
    try {
      u = new URL(str);
    } catch {
      u = null;
    }
    if (!u) {
      let [pathname, query = null] = String(str).split('?');
      return { protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null, hash: null, search: query ? '?' + query : null, query: parseQuery ? qs.parse(query || '') : query, pathname, path: str, href: str };
    }
    return {
      protocol: u.protocol,
      slashes: true,
      auth: u.username ? decodeURIComponent(u.username) + (u.password ? ':' + decodeURIComponent(u.password) : '') : null,
      host: u.host,
      port: u.port || null,
      hostname: u.hostname,
      hash: u.hash || null,
      search: u.search || null,
      query: parseQuery ? Object.fromEntries(u.searchParams) : u.search ? u.search.slice(1) : null,
      pathname: u.pathname,
      path: u.pathname + u.search,
      href: u.href,
    };
  }
  function formatUrl(o) {
    if (o instanceof URL) return o.href;
    if (typeof o === 'string') return o;
    let proto = o.protocol ? (o.protocol.endsWith(':') ? o.protocol : o.protocol + ':') : '';
    let host = o.host || (o.hostname ? o.hostname + (o.port ? ':' + o.port : '') : '');
    let search = o.search || (o.query && typeof o.query === 'object' ? '?' + qs.stringify(o.query) : o.query ? '?' + o.query : '');
    return `${proto}${host || o.slashes ? '//' : ''}${o.auth ? o.auth + '@' : ''}${host}${o.pathname || ''}${search}${o.hash || ''}`;
  }
  return {
    URL,
    URLSearchParams,
    fileURLToPath,
    pathToFileURL,
    parse,
    format: formatUrl,
    resolve: (from, to) => {
      let r = new URL(to, new URL(from, 'resolve://'));
      return r.protocol === 'resolve:' ? r.pathname + r.search + r.hash : r.href;
    },
    domainToASCII: (d) => new URL('http://' + d).hostname,
    domainToUnicode: (d) => d,
    urlToHttpOptions: (u) => ({ protocol: u.protocol, hostname: u.hostname, hash: u.hash, search: u.search, pathname: u.pathname, path: u.pathname + u.search, href: u.href, port: u.port ? Number(u.port) : undefined }),
  };
}

/* ---------- crypto (sync hashes via @noble/hashes) ---------- */
let nobleCache = null;
async function loadNoble() {
  if (nobleCache) return nobleCache;
  let [sha2, legacy, hmacM, pbkdf2M, scryptM, sha3] = await Promise.all([
    import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/sha2/+esm'),
    import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/legacy/+esm'),
    import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/hmac/+esm'),
    import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/pbkdf2/+esm'),
    import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/scrypt/+esm'),
    import('https://cdn.jsdelivr.net/npm/@noble/hashes@1.8.0/sha3/+esm'),
  ]);
  nobleCache = {
    algos: {
      md5: legacy.md5,
      sha1: legacy.sha1,
      ripemd160: legacy.ripemd160,
      rmd160: legacy.ripemd160,
      sha224: sha2.sha224,
      sha256: sha2.sha256,
      sha384: sha2.sha384,
      sha512: sha2.sha512,
      'sha512-256': sha2.sha512_256,
      'sha3-256': sha3.sha3_256,
      'sha3-512': sha3.sha3_512,
    },
    hmac: hmacM.hmac,
    pbkdf2: pbkdf2M.pbkdf2,
    scrypt: scryptM.scrypt,
  };
  return nobleCache;
}

function cryptoModule(noble, rt) {
  let algoOf = (name) => {
    let a = noble.algos[String(name).toLowerCase().replace(/^rsa-/, '')];
    if (!a) throw Object.assign(new Error('Digest method not supported'), { code: 'ERR_CRYPTO_INVALID_DIGEST' });
    return a;
  };
  let toBytes = (data, encoding) => (typeof data === 'string' ? new Uint8Array(Buffer.from(data, encoding || 'utf8')) : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data));
  let out = (bytes, encoding) => {
    let b = Buffer.from(bytes);
    return encoding ? b.toString(encoding) : b;
  };
  class Hash {
    constructor(alg, inner) {
      this._h = inner || algoOf(alg).create();
      this._alg = alg;
    }
    update(data, encoding) {
      this._h.update(toBytes(data, encoding));
      return this;
    }
    digest(encoding) {
      return out(this._h.digest(), encoding);
    }
    copy() {
      return new Hash(this._alg, this._h.clone());
    }
  }
  class Hmac {
    constructor(alg, key) {
      this._h = noble.hmac.create(algoOf(alg), toBytes(key?.export ? key.export() : key));
    }
    update(data, encoding) {
      this._h.update(toBytes(data, encoding));
      return this;
    }
    digest(encoding) {
      return out(this._h.digest(), encoding);
    }
  }
  let randomBytes = (n, cb) => {
    let b = Buffer.alloc(n);
    for (let i = 0; i < n; i += 65536) crypto.getRandomValues(new Uint8Array(b.buffer, b.byteOffset + i, Math.min(65536, n - i)));
    if (cb) {
      let release = rt.ref();
      queueMicrotask(() => {
        release();
        cb(null, b);
      });
      return;
    }
    return b;
  };
  let pbkdf2Sync = (password, salt, iterations, keylen, digest) => Buffer.from(noble.pbkdf2(algoOf(digest), toBytes(password), toBytes(salt), { c: iterations, dkLen: keylen }));
  let scryptSync = (password, salt, keylen, options = {}) => Buffer.from(noble.scrypt(toBytes(password), toBytes(salt), { N: options.N ?? options.cost ?? 16384, r: options.r ?? options.blockSize ?? 8, p: options.p ?? options.parallelization ?? 1, dkLen: keylen }));
  let later = (fn, cb) => {
    let release = rt.ref();
    setTimeout(() => {
      release();
      let r;
      try {
        r = fn();
      } catch (e) {
        return cb(e);
      }
      cb(null, r);
    }, 0);
  };
  return {
    createHash: (alg, opts) => new Hash(alg),
    hash: (alg, data, encoding = 'hex') => new Hash(alg).update(data).digest(encoding),
    createHmac: (alg, key) => new Hmac(alg, key),
    getHashes: () => Object.keys(noble.algos),
    getCiphers: () => [],
    getCurves: () => [],
    randomBytes,
    pseudoRandomBytes: randomBytes,
    randomFillSync: (buf, offset = 0, size) => {
      let view = new Uint8Array(buf.buffer || buf, (buf.byteOffset || 0) + offset, size ?? (buf.byteLength - offset));
      crypto.getRandomValues(view);
      return buf;
    },
    randomFill(buf, ...rest) {
      let cb = rest.pop();
      later(() => this.randomFillSync(buf, ...rest), cb);
    },
    randomUUID: () => crypto.randomUUID(),
    randomInt(min, max, cb) {
      if (max === undefined || typeof max === 'function') ((cb = max), (max = min), (min = 0));
      let range = max - min;
      let v = min + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * range);
      if (cb) return later(() => v, cb);
      return v;
    },
    getRandomValues: (a) => crypto.getRandomValues(a),
    timingSafeEqual(a, b) {
      if (a.byteLength !== b.byteLength) throw Object.assign(new RangeError('Input buffers must have the same byte length'), { code: 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH' });
      let x = 0;
      for (let i = 0; i < a.byteLength; i++) x |= a[i] ^ b[i];
      return x === 0;
    },
    pbkdf2Sync,
    pbkdf2: (pw, salt, it, len, digest, cb) => later(() => pbkdf2Sync(pw, salt, it, len, digest), cb),
    scryptSync,
    scrypt: (pw, salt, len, opts, cb) => {
      if (typeof opts === 'function') ((cb = opts), (opts = {}));
      later(() => scryptSync(pw, salt, len, opts), cb);
    },
    createCipheriv: enosys('crypto.createCipheriv()'),
    createDecipheriv: enosys('crypto.createDecipheriv()'),
    generateKeyPairSync: enosys('crypto.generateKeyPairSync()'),
    generateKeyPair: enosys('crypto.generateKeyPair()'),
    createSign: enosys('crypto.createSign()'),
    createVerify: enosys('crypto.createVerify()'),
    createPublicKey: enosys('crypto.createPublicKey()'),
    createPrivateKey: enosys('crypto.createPrivateKey()'),
    createSecretKey: (key) => ({ type: 'secret', export: () => Buffer.from(key) }),
    webcrypto: globalThis.crypto,
    subtle: globalThis.crypto.subtle,
    constants: {},
  };
}

/* ---------- zlib (fflate) ---------- */
let fflateCache = null;
async function loadFflate() {
  fflateCache ??= await import('https://cdn.jsdelivr.net/npm/fflate@0.8.2/+esm');
  return fflateCache;
}
function zlibModule(ff, rt) {
  let bytes = (d) => (typeof d === 'string' ? new TextEncoder().encode(d) : new Uint8Array(d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d));
  let wrap = (fn) => (data, opts) => Buffer.from(fn(bytes(data), opts?.level != null ? { level: opts.level } : undefined));
  let syncs = {
    gzipSync: wrap(ff.gzipSync),
    gunzipSync: wrap(ff.gunzipSync),
    deflateSync: wrap(ff.zlibSync),
    inflateSync: wrap(ff.unzlibSync),
    deflateRawSync: wrap(ff.deflateSync),
    inflateRawSync: wrap(ff.inflateSync),
    unzipSync: wrap(ff.decompressSync),
  };
  let m = { ...syncs, constants: { Z_NO_FLUSH: 0, Z_FINISH: 4, Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 } };
  for (let [name, fn] of Object.entries(syncs)) {
    let base = name.slice(0, -4);
    m[base] = (data, opts, cb) => {
      if (typeof opts === 'function') ((cb = opts), (opts = {}));
      let release = rt.ref();
      setTimeout(() => {
        release();
        let r;
        try {
          r = fn(data, opts);
        } catch (e) {
          return cb(e);
        }
        cb(null, r);
      }, 0);
    };
  }
  for (let n of ['brotliCompressSync', 'brotliDecompressSync', 'brotliCompress', 'brotliDecompress', 'createGzip', 'createGunzip', 'createDeflate', 'createInflate', 'createBrotliCompress', 'createBrotliDecompress']) m[n] = enosys('zlib.' + n + '()');
  m.crc32 = (data, value = 0) => {
    let table = crcTable();
    let crc = (value ^ -1) >>> 0;
    for (let b of bytes(data)) crc = (crc >>> 8) ^ table[(crc ^ b) & 0xff];
    return (crc ^ -1) >>> 0;
  };
  return m;
}
let _crc;
function crcTable() {
  if (_crc) return _crc;
  _crc = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    _crc[n] = c >>> 0;
  }
  return _crc;
}

/* ---------- readline ---------- */
function readlineModule(rt) {
  class Interface extends EventEmitter {
    constructor(opts = {}, output) {
      super();
      if (opts.on) opts = { input: opts, output };
      this.input = opts.input;
      this.output = opts.output;
      this.terminal = false;
      this.line = '';
      this.closed = false;
      this._prompt = opts.prompt ?? '> ';
      this._buf = '';
      this._lines = [];
      this._questions = [];
      this._ended = false;
      this._release = rt.ref();
      let onData = (chunk) => {
        this._buf += typeof chunk === 'string' ? chunk : dec.decode(chunk, { stream: true });
        let parts = this._buf.split(/\r?\n/);
        this._buf = parts.pop();
        for (let l of parts) this._emitLine(l);
      };
      let onEnd = () => {
        if (this._buf) this._emitLine(this._buf);
        this._buf = '';
        this._ended = true;
        this.close();
      };
      this._detach = () => {
        this.input?.removeListener?.('data', onData);
        this.input?.removeListener?.('end', onEnd);
      };
      if (this.input?.on) {
        this.input.on('data', onData);
        this.input.on('end', onEnd);
        this.input.resume?.();
      } else queueMicrotask(onEnd);
    }
    _emitLine(l) {
      let q = this._questions.shift();
      if (q) return q(l);
      this.emit('line', l);
    }
    setPrompt(p) {
      this._prompt = p;
    }
    getPrompt() {
      return this._prompt;
    }
    prompt() {
      this.output?.write?.(this._prompt);
    }
    question(query, opts, cb) {
      if (typeof opts === 'function') cb = opts;
      if (this.closed) throw Object.assign(new Error('readline was closed'), { code: 'ERR_USE_AFTER_CLOSE' });
      this.output?.write?.(query);
      this._questions.push(cb);
    }
    write(data) {
      if (typeof data === 'string') this._emitLine(data.replace(/\r?\n$/, ''));
    }
    pause() {
      this.emit('pause');
      return this;
    }
    resume() {
      this.emit('resume');
      return this;
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      this._detach();
      this._release();
      this.emit('close');
    }
    getCursorPos() {
      return { rows: 0, cols: 0 };
    }
    [Symbol.asyncIterator]() {
      let lines = [];
      let waiters = [];
      let done = false;
      this.on('line', (l) => {
        let w = waiters.shift();
        if (w) w({ value: l, done: false });
        else lines.push(l);
      });
      this.on('close', () => {
        done = true;
        for (let w of waiters.splice(0)) w({ value: undefined, done: true });
      });
      return {
        next: () => (lines.length ? Promise.resolve({ value: lines.shift(), done: false }) : done ? Promise.resolve({ value: undefined, done: true }) : new Promise((r) => waiters.push(r))),
        return: () => {
          this.close();
          return Promise.resolve({ value: undefined, done: true });
        },
        [Symbol.asyncIterator]() {
          return this;
        },
      };
    }
    [Symbol.dispose]() {
      this.close();
    }
  }
  let createInterface = (o, out) => new Interface(o, out);
  let tty = {
    clearLine: (s, d, cb) => (cb?.(), true),
    clearScreenDown: (s, cb) => (cb?.(), true),
    cursorTo: (s, x, y, cb) => ((typeof y === 'function' ? y : cb)?.(), true),
    moveCursor: (s, dx, dy, cb) => (cb?.(), true),
    emitKeypressEvents: () => {},
  };
  let promises = {
    Interface: class extends Interface {
      question(query, opts = {}) {
        return new Promise((resolve, reject) => {
          if (opts.signal?.aborted) return reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
          super.question(query, resolve);
        });
      }
    },
    createInterface: (o, out) => new promises.Interface(o, out),
    Readline: class {
      clearLine() { return this; }
      cursorTo() { return this; }
      moveCursor() { return this; }
      commit() { return Promise.resolve(); }
    },
  };
  return { Interface, createInterface, promises, ...tty };
}

/* ---------- child_process (through the Tehboxen shell) ---------- */
function childProcessModule(ctx) {
  let { rt } = ctx;
  let quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`);
  let toCmd = (file, args) => [file, ...(args || [])].map(quote).join(' ');
  let pidSeq = rt.process.pid + 1;
  class ChildProcess extends EventEmitter {
    constructor(cmd, opts = {}) {
      super();
      this.pid = pidSeq++;
      this.spawnfile = cmd.split(' ')[0];
      this.spawnargs = [cmd];
      this.exitCode = null;
      this.signalCode = null;
      this.killed = false;
      this.connected = false;
      this.stdout = new streamMod.Readable({ read() {} });
      this.stderr = new streamMod.Readable({ read() {} });
      let input = [];
      this.stdin = new streamMod.Writable({
        write(chunk, enc2, cb) {
          input.push(typeof chunk === 'string' ? chunk : dec.decode(chunk));
          cb();
        },
      });
      let release = rt.ref();
      let started = false;
      let start = () => {
        if (started) return;
        started = true;
        ctx
          .exec(cmd, { cwd: opts.cwd, env: opts.env, stdin: input.join('') + (opts.input != null ? String(opts.input) : '') })
          .then((r) => {
            if (this.killed) return;
            if (r.stdout) this.stdout.push(Buffer.from(r.stdout));
            if (r.stderr) this.stderr.push(Buffer.from(r.stderr));
            this.stdout.push(null);
            this.stderr.push(null);
            this.exitCode = r.code;
            setTimeout(() => {
              this.emit('exit', r.code, null);
              this.emit('close', r.code, null);
            }, 0);
          })
          .catch((err) => this.emit('error', err))
          .finally(release);
      };
      // Give the caller a tick to write stdin before the command runs.
      this.stdin.on('finish', start);
      setTimeout(start, 0);
      queueMicrotask(() => this.emit('spawn'));
    }
    kill(sig = 'SIGTERM') {
      this.killed = true;
      this.signalCode = sig;
      queueMicrotask(() => {
        this.emit('exit', null, sig);
        this.emit('close', null, sig);
      });
      return true;
    }
    ref() {}
    unref() {}
    disconnect() {}
  }
  function spawn(file, args, opts) {
    if (!Array.isArray(args)) ((opts = args), (args = []));
    opts ??= {};
    let cmd = opts.shell ? [file, ...args].join(' ') : toCmd(file, args);
    return new ChildProcess(cmd, opts);
  }
  function exec(cmd, opts, cb) {
    if (typeof opts === 'function') ((cb = opts), (opts = {}));
    opts ??= {};
    let child = new ChildProcess(cmd, opts);
    let out = [];
    let err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('close', (code) => {
      let enc2 = opts.encoding === 'buffer' ? null : opts.encoding || 'utf8';
      let so = Buffer.concat(out);
      let se = Buffer.concat(err);
      let stdout = enc2 ? so.toString(enc2) : so;
      let stderr = enc2 ? se.toString(enc2) : se;
      let error = null;
      if (code) {
        error = new Error(`Command failed: ${cmd}\n${stderr}`);
        error.code = code;
        error.cmd = cmd;
        error.killed = false;
        error.signal = null;
        error.stdout = stdout;
        error.stderr = stderr;
      }
      cb?.(error, stdout, stderr);
    });
    return child;
  }
  function execFile(file, args, opts, cb) {
    if (typeof args === 'function') ((cb = args), (args = []), (opts = {}));
    else if (!Array.isArray(args)) ((cb = opts), (opts = args), (args = []));
    if (typeof opts === 'function') ((cb = opts), (opts = {}));
    return exec(toCmd(file, args), opts, cb);
  }
  // Blocking variants: the worker waits on the syscall channel while the shell runs.
  let runSync = (cmd, opts = {}) => {
    let r = ctx.execSync(cmd, { cwd: opts.cwd, env: opts.env, stdin: opts.input != null ? String(opts.input) : undefined });
    let encoding = opts.encoding && opts.encoding !== 'buffer' ? opts.encoding : null;
    let stdout = encoding ? Buffer.from(r.stdout).toString(encoding) : Buffer.from(r.stdout);
    let stderr = encoding ? Buffer.from(r.stderr).toString(encoding) : Buffer.from(r.stderr);
    return { status: r.code, stdout, stderr };
  };
  let failSync = (cmd, r, opts) => {
    let err = new Error(`Command failed: ${cmd}${r.stderr.length ? '\n' + r.stderr : ''}`);
    Object.assign(err, { status: r.status, signal: null, stdout: r.stdout, stderr: r.stderr, output: [null, r.stdout, r.stderr], pid: pidSeq++ });
    return err;
  };
  function execSync(cmd, opts = {}) {
    let r = runSync(cmd, opts);
    // Default stdio: stderr is inherited by the parent.
    let errMode = Array.isArray(opts.stdio) ? opts.stdio[2] : opts.stdio;
    if (errMode == null || errMode === 'inherit') rt.process.stderr.write(r.stderr);
    if (opts.stdio === 'inherit') rt.process.stdout.write(r.stdout);
    if (r.status) throw failSync(cmd, r, opts);
    return r.stdout;
  }
  function execFileSync(file, args, opts) {
    if (!Array.isArray(args)) ((opts = args), (args = []));
    let cmd = toCmd(file, args);
    let r = runSync(cmd, opts || {});
    if (r.status) throw failSync(cmd, r, opts);
    return r.stdout;
  }
  function spawnSync(file, args, opts) {
    if (!Array.isArray(args)) ((opts = args), (args = []));
    opts ??= {};
    let cmd = opts.shell ? [file, ...args].join(' ') : toCmd(file, args);
    let r = runSync(cmd, opts);
    if (opts.stdio === 'inherit') {
      rt.process.stdout.write(r.stdout);
      rt.process.stderr.write(r.stderr);
    }
    return { pid: pidSeq++, status: r.status, signal: null, stdout: r.stdout, stderr: r.stderr, output: [null, r.stdout, r.stderr] };
  }
  exec[Symbol.for('nodejs.util.promisify.custom')] = (cmd, opts) =>
    new Promise((resolve, reject) => exec(cmd, opts, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr }))));
  execFile[Symbol.for('nodejs.util.promisify.custom')] = (file, args, opts) =>
    new Promise((resolve, reject) => execFile(file, args, opts, (e, stdout, stderr) => (e ? reject(Object.assign(e, { stdout, stderr })) : resolve({ stdout, stderr }))));
  return {
    ChildProcess,
    spawn,
    exec,
    execFile,
    fork: enosys('child_process.fork()'),
    execSync,
    execFileSync,
    spawnSync,
  };
}

/* ---------- os ---------- */
function osModule(ctx) {
  let { actor, env } = ctx;
  let startedAt = Date.now() - 3600_000 * 7;
  return {
    EOL: '\n',
    devNull: '/dev/null',
    arch: () => 'x64',
    platform: () => 'linux',
    type: () => 'Linux',
    release: () => '6.8.0-tehboxen',
    version: () => '#1 SMP PREEMPT_DYNAMIC Tehboxen',
    machine: () => 'x86_64',
    hostname: () => env.HOSTNAME || 'tehboxen',
    homedir: () => '/' + String(actor.home || '').replace(/^\/+/, ''),
    tmpdir: () => '/tmp',
    endianness: () => 'LE',
    uptime: () => Math.floor((Date.now() - startedAt) / 1000),
    loadavg: () => [0.42, 0.37, 0.31],
    totalmem: () => 16 * 1024 ** 3,
    freemem: () => 9 * 1024 ** 3,
    availableParallelism: () => navigator.hardwareConcurrency || 4,
    cpus: () =>
      Array.from({ length: navigator.hardwareConcurrency || 4 }, () => ({
        model: 'Tehboxen Virtual CPU @ 3.20GHz',
        speed: 3200,
        times: { user: 100000, nice: 0, sys: 50000, idle: 1000000, irq: 0 },
      })),
    userInfo: () => ({ uid: Number(actor.uid), gid: Number(actor.gid), username: actor.name, homedir: '/' + String(actor.home || '').replace(/^\/+/, ''), shell: actor.shell || '/bin/boxsh' }),
    networkInterfaces: () => ({
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
      eth0: [{ address: '10.13.37.' + (10 + (Number(actor.uid) % 200)), netmask: '255.255.255.0', family: 'IPv4', mac: '02:42:0a:0d:25:0a', internal: false, cidr: '10.13.37.0/24' }],
    }),
    getPriority: () => 0,
    setPriority: () => {},
    constants: {
      signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15, SIGUSR1: 10, SIGUSR2: 12, SIGPIPE: 13, SIGCHLD: 17 },
      errno: { ENOENT: 2, EACCES: 13, EEXIST: 17 },
      priority: {},
    },
  };
}

/* ---------- vm ---------- */
function vmModule() {
  let run = (code, ctx) => {
    if (!ctx) return (0, eval)(code);
    let fn = new Function('__ctx', '__code', 'with (__ctx) { return eval(__code); }');
    return fn(ctx, code);
  };
  class Script {
    constructor(code) {
      this.code = String(code);
    }
    runInThisContext() {
      return run(this.code);
    }
    runInNewContext(ctx = {}) {
      return run(this.code, ctx);
    }
    runInContext(ctx) {
      return run(this.code, ctx);
    }
  }
  return {
    Script,
    createContext: (o = {}) => o,
    isContext: (o) => o != null && typeof o === 'object',
    runInThisContext: (c) => run(c),
    runInNewContext: (c, ctx = {}) => run(c, ctx),
    runInContext: (c, ctx) => run(c, ctx),
    compileFunction: (code, params = []) => new Function(...params, code),
  };
}

/* ---------- async_hooks ---------- */
function asyncHooksModule() {
  class AsyncLocalStorage {
    constructor() {
      this._store = undefined;
    }
    getStore() {
      return this._store;
    }
    run(store, fn, ...args) {
      let prev = this._store;
      this._store = store;
      try {
        let r = fn(...args);
        if (r && typeof r.finally === 'function') return r.finally(() => (this._store = prev));
        this._store = prev;
        return r;
      } catch (e) {
        this._store = prev;
        throw e;
      }
    }
    enterWith(store) {
      this._store = store;
    }
    exit(fn, ...args) {
      return this.run(undefined, fn, ...args);
    }
    disable() {
      this._store = undefined;
    }
    static bind(fn) {
      return fn;
    }
    static snapshot() {
      return (fn, ...args) => fn(...args);
    }
  }
  class AsyncResource {
    constructor(type) {
      this.type = type;
    }
    runInAsyncScope(fn, thisArg, ...args) {
      return fn.apply(thisArg, args);
    }
    bind(fn) {
      return fn.bind(this);
    }
    emitDestroy() {
      return this;
    }
    asyncId() {
      return 1;
    }
    triggerAsyncId() {
      return 0;
    }
    static bind(fn) {
      return fn;
    }
  }
  return {
    AsyncLocalStorage,
    AsyncResource,
    createHook: () => ({ enable() { return this; }, disable() { return this; } }),
    executionAsyncId: () => 1,
    triggerAsyncId: () => 0,
    executionAsyncResource: () => ({}),
  };
}

/* ---------- table ---------- */

/**
 * Preload async pieces (hash/zip libs) once; cheap after the first run.
 * @returns {Promise<void>}
 */
export async function preloadBuiltins() {
  await Promise.all([loadNoble(), loadFflate()]);
}

/**
 * Build the per-process builtin resolver.
 * @param {object} ctx { rt, nodeFs, actor, env, exec, moduleApi }
 * @returns {(name: string) => any}
 */
export function createBuiltins(ctx) {
  let cache = new Map();
  let { rt, nodeFs } = ctx;
  let util;
  let factories = {
    events: () => eventsModule(),
    util: () => (util ??= utilModule()),
    'util/types': () => get('util').types,
    sys: () => get('util'),
    buffer: () => ({
      Buffer,
      SlowBuffer: Buffer,
      Blob,
      File: globalThis.File,
      atob,
      btoa,
      constants: { MAX_LENGTH: 2 ** 32 - 1, MAX_STRING_LENGTH: 2 ** 29 - 24 },
      kMaxLength: 2 ** 32 - 1,
      kStringMaxLength: 2 ** 29 - 24,
      INSPECT_MAX_BYTES: 50,
      isUtf8: (b) => {
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(b);
          return true;
        } catch {
          return false;
        }
      },
      isAscii: (b) => b.every((x) => x < 128),
      transcode: (b, from, to) => Buffer.from(Buffer.from(b).toString(from), to),
    }),
    path: () => path,
    'path/posix': () => path,
    'path/win32': () => path,
    fs: () => nodeFs.fs,
    'fs/promises': () => nodeFs.promises,
    process: () => rt.process,
    console: () => rt.console,
    timers: () => ({ ...rt.timers, promises: get('timers/promises') }),
    'timers/promises': () => ({
      setTimeout: (ms, value, opts = {}) =>
        new Promise((resolve, reject) => {
          let t = rt.timers.setTimeout(() => resolve(value), ms);
          if (opts.ref === false) t.unref();
          opts.signal?.addEventListener('abort', () => {
            rt.timers.clearTimeout(t);
            reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError', code: 'ABORT_ERR' }));
          });
        }),
      setImmediate: (value) => new Promise((resolve) => rt.timers.setImmediate(() => resolve(value))),
      setInterval: async function* (ms, value, opts = {}) {
        let pending = 0;
        let wake;
        let t = rt.timers.setInterval(() => {
          pending++;
          wake?.();
        }, ms);
        try {
          while (!opts.signal?.aborted) {
            if (!pending) await new Promise((r) => (wake = r));
            pending--;
            yield value;
          }
        } finally {
          rt.timers.clearTimeout(t);
        }
      },
      scheduler: { wait: (ms) => new Promise((r) => rt.timers.setTimeout(r, ms)), yield: () => new Promise((r) => rt.timers.setImmediate(r)) },
    }),
    stream: () => {
      let S = streamMod.Stream || streamMod.default?.Stream || class Stream extends EventEmitter {};
      Object.assign(S, streamMod, { Stream: S, promises: get('stream/promises') });
      return S;
    },
    'stream/promises': () => ({
      pipeline: (...s) => new Promise((resolve, reject) => streamMod.pipeline(...s, (e) => (e ? reject(e) : resolve()))),
      finished: (s, o) => new Promise((resolve, reject) => streamMod.finished(s, o || {}, (e) => (e ? reject(e) : resolve()))),
    }),
    'stream/web': () => ({ ReadableStream, WritableStream, TransformStream, TextEncoderStream, TextDecoderStream, ByteLengthQueuingStrategy, CountQueuingStrategy }),
    'stream/consumers': () => {
      let collect = async (s) => {
        let chunks = [];
        for await (let c of s) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c));
        return Buffer.concat(chunks);
      };
      return { buffer: collect, text: async (s) => (await collect(s)).toString(), json: async (s) => JSON.parse((await collect(s)).toString()), arrayBuffer: async (s) => (await collect(s)).buffer, blob: async (s) => new Blob([await collect(s)]) };
    },
    string_decoder: () => ({ StringDecoder }),
    querystring: () => qs,
    url: () => urlModule(),
    punycode: () => ({ toASCII: (d) => new URL('http://' + d).hostname, toUnicode: (d) => d, encode: (s) => s, decode: (s) => s }),
    assert: () => assertModule(get('util')),
    'assert/strict': () => get('assert').strict,
    os: () => osModule(ctx),
    crypto: () => cryptoModule(nobleCache, rt),
    zlib: () => zlibModule(fflateCache, rt),
    readline: () => readlineModule(rt),
    'readline/promises': () => get('readline').promises,
    child_process: () => childProcessModule(ctx),
    vm: () => vmModule(),
    async_hooks: () => asyncHooksModule(),
    perf_hooks: () => ({
      performance: globalThis.performance,
      PerformanceObserver: class {
        observe() {}
        disconnect() {}
      },
      monitorEventLoopDelay: () => ({ enable() {}, disable() {}, percentile: () => 0, min: 0, max: 0, mean: 0 }),
      createHistogram: () => ({ record() {}, percentile: () => 0 }),
    }),
    tty: () => {
      // fd 1/2 are the Terminal when output isn't piped or redirected; stdin is never a TTY (no REPL yet).
      let isatty = (fd) => !!ctx.tty && (Number(fd) === 1 || Number(fd) === 2);
      class WriteStream {
        constructor(fd) {
          return Number(fd) === 2 ? rt.process.stderr : rt.process.stdout;
        }
      }
      class ReadStream {
        constructor() {
          return rt.process.stdin;
        }
      }
      return { isatty, WriteStream, ReadStream };
    },
    constants: () => ({ ...nodeFs.fs.constants, ...get('os').constants.signals }),
    module: () => ctx.moduleApi(),
    worker_threads: () => ({ isMainThread: true, parentPort: null, workerData: null, threadId: 0, Worker: enosys('worker_threads.Worker'), MessageChannel, MessagePort, BroadcastChannel, markAsUntransferable() {} }),
    diagnostics_channel: () => {
      let mk = (name) => ({ name, hasSubscribers: false, publish() {}, subscribe() {}, unsubscribe() {}, bindStore() {}, runStores: (d, fn, t, ...a) => fn.apply(t, a) });
      return { channel: mk, hasSubscribers: () => false, subscribe() {}, unsubscribe() {}, tracingChannel: (n) => ({ start: mk(n), end: mk(n), asyncStart: mk(n), asyncEnd: mk(n), error: mk(n), traceSync: (fn, c, t, ...a) => fn.apply(t, a), tracePromise: (fn, c, t, ...a) => fn.apply(t, a), traceCallback: (fn, p, c, t, ...a) => fn.apply(t, a) }) };
    },
    v8: () => ({ getHeapStatistics: () => ({ total_heap_size: 3e7, used_heap_size: 2e7, heap_size_limit: 4e9 }), serialize: (v) => Buffer.from(JSON.stringify(v)), deserialize: (b) => JSON.parse(Buffer.from(b).toString()), setFlagsFromString() {}, cachedDataVersionTag: () => 0 }),
    inspector: () => ({ open: enosys('inspector.open()'), close() {}, url: () => undefined, Session: class { connect() {} post() {} disconnect() {} } }),
    domain: () => ({ create: () => Object.assign(new EventEmitter(), { run: (fn) => fn(), add() {}, remove() {}, bind: (f) => f, intercept: (f) => f, dispose() {} }) }),
    trace_events: () => ({ createTracing: () => ({ enable() {}, disable() {} }), getEnabledCategories: () => '' }),
    repl: () => ({ start: enosys('repl.start()') }),
    wasi: () => createWasiModule({ sys: ctx.sys, path, stdio: ctx.stdio, cwd: () => rt.process.cwd(), exit: (c) => rt.process.exit(c), ref: () => rt.ref(), tty: { stdin: !!ctx.stdinTty, stdout: !!ctx.tty }, ids: () => [Number(ctx.actor?.uid) || 0, Number(ctx.actor?.gid) || 0] }),
    net: () => ({ ...stubModule('net', ['createServer', 'createConnection', 'connect']), Socket: enosys('net.Socket'), Server: enosys('net.Server'), isIP: (s) => (/^(\d{1,3}\.){3}\d{1,3}$/.test(s) ? 4 : s.includes(':') ? 6 : 0), isIPv4: (s) => /^(\d{1,3}\.){3}\d{1,3}$/.test(s), isIPv6: (s) => s.includes(':') }),
    http: () => ({ ...stubModule('http', ['createServer', 'request', 'get']), STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable' }, METHODS: ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'], Agent: class {}, globalAgent: {} }),
    https: () => ({ ...stubModule('https', ['createServer', 'request', 'get']), Agent: class {}, globalAgent: {} }),
    http2: () => stubModule('http2', ['createServer', 'createSecureServer', 'connect']),
    tls: () => stubModule('tls', ['createServer', 'connect', 'createSecureContext']),
    dgram: () => stubModule('dgram', ['createSocket']),
    dns: () => ({ ...stubModule('dns', ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse', 'resolveTxt', 'resolveMx']), promises: get('dns/promises') }),
    'dns/promises': () => stubModule('dns.promises', ['lookup', 'resolve', 'resolve4', 'resolve6', 'reverse']),
    cluster: () => ({ isPrimary: true, isMaster: true, isWorker: false, fork: enosys('cluster.fork()'), on() {}, workers: {} }),
    test: () => ({ test: enosys('node:test'), describe: enosys('node:test describe'), it: enosys('node:test it') }),
    sqlite: () => ({ DatabaseSync: enosys('node:sqlite DatabaseSync') }),
    sea: () => ({ isSea: () => false }),
    'test/reporters': () => ({}),
  };
  function get(name) {
    if (cache.has(name)) return cache.get(name);
    let f = factories[name];
    if (!f) return undefined;
    let m = f();
    cache.set(name, m);
    return m;
  }
  return get;
}

export { NODE_VERSION, streamMod };
