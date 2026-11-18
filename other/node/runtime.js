/**
 * Process-level pieces of the simulated node runtime: `process`, `console`,
 * timers and the "event loop" bookkeeping that decides when a run is done.
 *
 * Node exits when nothing keeps the loop alive. We approximate that with a
 * ref count: pending timers, fs callbacks, fetches, child processes and
 * watchers hold refs; when the entry module has settled and the count stays
 * at zero for one macrotask, the process exits.
 */
import { format, formatWithOptions, inspect } from './inspect.js';

export let NODE_VERSION = '22.12.0';

/** Thrown to unwind the stack after process.exit(); swallowed by the runtime. */
export class ProcessExit extends Error {
  constructor(code) {
    super('process.exit(' + code + ')');
    this.name = 'ProcessExit';
    this.exitCode = code;
  }
}

let enc = new TextEncoder();
let dec = new TextDecoder();

/**
 * @param {object} o
 * @param {string[]} o.argv full argv ([execPath, script, ...args])
 * @param {string[]} o.execArgv
 * @param {Record<string,string>} o.env
 * @param {() => string} o.getCwd  @param {(d: string) => void} o.setCwd
 * @param {(bytes: Uint8Array) => void} o.writeOut  @param {(bytes: Uint8Array) => void} o.writeErr
 * @param {Uint8Array} o.stdin  @param {boolean} o.stdinPiped
 * @param {{name,uid,gid,gids}} o.actor
 * @param {any} o.EventEmitter  @param {any} o.Readable  @param {any} o.Buffer
 * @param {AbortSignal} o.signal  interrupt (Ctrl-C) → SIGINT
 */
export function createRuntime(o) {
  let { EventEmitter, Readable, Buffer } = o;
  let refs = 0;
  let exited = false;
  let exitCode = 0;
  let idleWaiters = [];
  let exitWaiters = [];
  let realSetTimeout = globalThis.setTimeout.bind(globalThis);
  let realClearTimeout = globalThis.clearTimeout.bind(globalThis);
  let realSetInterval = globalThis.setInterval.bind(globalThis);
  let realClearInterval = globalThis.clearInterval.bind(globalThis);
  let realFetch = globalThis.fetch.bind(globalThis);
  let timers = new Set();
  let startedAt = performance.now();
  let fatal = null; // set by reportUncaught

  function ref() {
    refs++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      refs--;
      if (refs <= 0) checkIdle();
    };
  }
  function checkIdle() {
    // Let pending microtasks schedule new work, and let the browser deliver
    // 'unhandledrejection' (its own task) before deciding the loop is empty.
    realSetTimeout(() => {
      if (refs > 0 || exited) return;
      realSetTimeout(() => {
        if (refs > 0 || exited) return;
        for (let w of idleWaiters.splice(0)) w();
      }, 4);
    }, 0);
  }
  function whenIdle() {
    return new Promise((resolve) => {
      idleWaiters.push(resolve);
      if (refs <= 0) checkIdle();
    });
  }
  function whenExit() {
    return new Promise((resolve) => (exited ? resolve(exitCode) : exitWaiters.push(resolve)));
  }

  /* ---------- guarded callbacks ---------- */
  function guard(fn, args) {
    if (exited) return;
    try {
      let r = fn(...args);
      if (r && typeof r.then === 'function') r.then(null, (err) => onRejection(err));
    } catch (err) {
      reportUncaught(err);
    }
  }

  /* ---------- timers ---------- */
  class Timeout {
    constructor(fn, ms, args, repeat) {
      this._fn = fn;
      this._ms = Math.max(1, Number(ms) || 1);
      this._args = args;
      this._repeat = repeat;
      this._release = ref();
      this._refed = true;
      this._start();
      timers.add(this);
    }
    _start() {
      if (this._repeat) this._id = realSetInterval(() => guard(this._fn, this._args), this._ms);
      else
        this._id = realSetTimeout(() => {
          timers.delete(this);
          this._release();
          guard(this._fn, this._args);
        }, this._ms);
    }
    _clear() {
      if (this._repeat) realClearInterval(this._id);
      else realClearTimeout(this._id);
      timers.delete(this);
      this._release();
    }
    ref() {
      if (!this._refed && timers.has(this)) {
        this._release = ref();
        this._refed = true;
      }
      return this;
    }
    unref() {
      if (this._refed) {
        this._release();
        this._refed = false;
      }
      return this;
    }
    hasRef() {
      return this._refed;
    }
    refresh() {
      if (this._repeat) realClearInterval(this._id);
      else realClearTimeout(this._id);
      this._start();
      return this;
    }
    close() {
      this._clear();
      return this;
    }
    [Symbol.toPrimitive]() {
      return typeof this._id === 'number' ? this._id : 0;
    }
    [Symbol.dispose]() {
      this._clear();
    }
  }
  let byId = new Map();
  function setTimeout(fn, ms, ...args) {
    if (typeof fn !== 'function') throw Object.assign(new TypeError('The "callback" argument must be of type function. Received ' + typeof fn), { code: 'ERR_INVALID_ARG_TYPE' });
    let t = new Timeout(fn, ms, args, false);
    byId.set(+t, t);
    return t;
  }
  function setInterval(fn, ms, ...args) {
    let t = new Timeout(fn, ms, args, true);
    byId.set(+t, t);
    return t;
  }
  function clearTimeout(t) {
    if (t == null) return;
    if (typeof t === 'number' || typeof t === 'string') t = byId.get(Number(t));
    if (t instanceof Timeout) t._clear();
  }
  class Immediate {
    constructor(fn, args) {
      this._release = ref();
      this._cancelled = false;
      realSetTimeout(() => {
        this._release();
        if (!this._cancelled) guard(fn, args);
      }, 0);
    }
    ref() {
      return this;
    }
    unref() {
      this._release();
      return this;
    }
    hasRef() {
      return true;
    }
  }
  function setImmediate(fn, ...args) {
    return new Immediate(fn, args);
  }
  function clearImmediate(i) {
    if (i instanceof Immediate) {
      i._cancelled = true;
      i._release();
    }
  }

  /* ---------- streams for stdio ---------- */
  function makeWritable(write, fd) {
    let w = new EventEmitter();
    let tty = o.tty;
    Object.assign(w, {
      fd,
      writable: true,
      isTTY: !!tty,
      columns: tty?.columns ?? 80,
      rows: tty?.rows ?? 24,
      _isStdio: true,
      write(chunk, encoding, cb) {
        if (typeof encoding === 'function') ((cb = encoding), (encoding = undefined));
        if (exited) return false;
        let bytes = typeof chunk === 'string' ? (encoding && encoding !== 'utf8' && encoding !== 'utf-8' ? new Uint8Array(Buffer.from(chunk, encoding)) : enc.encode(chunk)) : chunk instanceof Uint8Array ? chunk : enc.encode(String(chunk));
        write(bytes);
        if (cb) queueMicrotask(() => cb());
        return true;
      },
      end(chunk, encoding, cb) {
        if (typeof chunk === 'function') ((cb = chunk), (chunk = undefined));
        if (chunk != null) this.write(chunk, encoding);
        if (cb) queueMicrotask(cb);
        queueMicrotask(() => this.emit('finish'));
        return this;
      },
      cork() {},
      uncork() {},
      setDefaultEncoding() {
        return this;
      },
      // xterm.js renders 24-bit color.
      hasColors: (count = 16) => !!tty && (typeof count === 'object' ? true : count <= 2 ** 24),
      getColorDepth: () => (tty ? 24 : 1),
      getWindowSize: () => [tty?.columns ?? 80, tty?.rows ?? 24],
      cursorTo: (x, y, cb) => (cb?.(), true),
      moveCursor: (dx, dy, cb) => (cb?.(), true),
      clearLine: (dir, cb) => (cb?.(), true),
      clearScreenDown: (cb) => (cb?.(), true),
      writableLength: 0,
      writableHighWaterMark: 16384,
      writableEnded: false,
      destroyed: false,
      destroy() {
        return this;
      },
    });
    return w;
  }
  let stdout = makeWritable(o.writeOut, 1);
  let stderr = makeWritable(o.writeErr, 2);

  let stdinStream = null;
  function getStdin() {
    if (stdinStream) return stdinStream;
    let pushed = false;
    let release = null;
    stdinStream = new Readable({
      read() {
        if (pushed) return;
        pushed = true;
        release ??= ref();
        realSetTimeout(() => {
          if (o.stdin.length) this.push(Buffer.from(o.stdin));
          this.push(null);
          release?.();
        }, 0);
      },
    });
    stdinStream.fd = 0;
    stdinStream.isTTY = !o.stdinPiped ? false : false;
    stdinStream.setRawMode = () => stdinStream;
    stdinStream.ref = () => stdinStream;
    stdinStream.unref = () => stdinStream;
    return stdinStream;
  }

  /* ---------- process ---------- */
  let envTarget = { ...o.env };
  let env = new Proxy(envTarget, {
    set(t, k, v) {
      t[k] = String(v);
      return true;
    },
    defineProperty(t, k, d) {
      t[k] = String(d.value);
      return true;
    },
  });
  let nodeVersions = {
    node: NODE_VERSION,
    acorn: '8.14.0',
    ada: '2.9.2',
    ares: '1.34.3',
    brotli: '1.1.0',
    cjs_module_lexer: '1.4.1',
    icu: '76.1',
    llhttp: '9.2.1',
    modules: '127',
    napi: '9',
    openssl: '3.0.15+quic',
    uv: '1.49.2',
    v8: '12.4.254.21-node.21',
    zlib: '1.3.0.1-motley',
    tehboxen: '1',
  };
  let warningsOff = !!o.noWarnings;
  let proc = new EventEmitter();
  // defineProperties, not Object.assign: accessors (exitCode, stdin) must stay live.
  Object.defineProperties(proc, Object.getOwnPropertyDescriptors({
    title: 'node',
    version: 'v' + NODE_VERSION,
    versions: nodeVersions,
    release: { name: 'node', lts: 'Jod', sourceUrl: '', headersUrl: '' },
    platform: 'linux',
    arch: 'x64',
    argv: o.argv,
    argv0: 'node',
    execArgv: o.execArgv,
    execPath: '/usr/bin/node',
    env,
    pid: o.pid,
    ppid: o.ppid,
    config: { variables: {} },
    features: { inspector: false, debug: false, uv: true, ipv6: true, tls_alpn: true, tls_sni: true, tls_ocsp: true, tls: true, cached_builtins: true, typescript: 'strip' },
    allowedNodeEnvironmentFlags: new Set(),
    moduleLoadList: [],
    sourceMapsEnabled: false,
    throwDeprecation: !!o.throwDeprecation,
    noDeprecation: !!o.noDeprecation,
    traceDeprecation: !!o.traceDeprecation,
    stdout,
    stderr,
    get stdin() {
      return getStdin();
    },
    get exitCode() {
      return exitCode || undefined;
    },
    set exitCode(v) {
      exitCode = v == null ? 0 : Number(v) | 0;
    },
    cwd: () => o.getCwd(),
    chdir: (d) => o.setCwd(d),
    umask: () => 0o022,
    getuid: () => Number(o.actor.uid),
    geteuid: () => Number(o.actor.uid),
    getgid: () => Number(o.actor.gid),
    getegid: () => Number(o.actor.gid),
    getgroups: () => [...new Set([Number(o.actor.gid), ...(o.actor.gids || []).map(Number)])],
    setuid() {
      throw Object.assign(new Error('EPERM, Operation not permitted'), { code: 'EPERM' });
    },
    hrtime: Object.assign(
      (prev) => {
        let t = performance.now();
        let s = Math.floor(t / 1000);
        let ns = Math.floor((t % 1000) * 1e6);
        if (prev) {
          let ds = s - prev[0];
          let dns = ns - prev[1];
          if (dns < 0) {
            ds--;
            dns += 1e9;
          }
          return [ds, dns];
        }
        return [s, ns];
      },
      { bigint: () => BigInt(Math.floor(performance.now() * 1e6)) },
    ),
    uptime: () => (performance.now() - startedAt) / 1000,
    memoryUsage: Object.assign(
      () => {
        let heap = performance.memory?.usedJSHeapSize || 8e6;
        return { rss: heap * 2, heapTotal: performance.memory?.totalJSHeapSize || heap * 1.5, heapUsed: heap, external: 1e6, arrayBuffers: 1e5 };
      },
      { rss: () => (performance.memory?.usedJSHeapSize || 8e6) * 2 },
    ),
    cpuUsage: () => ({ user: Math.floor((performance.now() - startedAt) * 1000), system: 0 }),
    resourceUsage: () => ({ userCPUTime: 0, systemCPUTime: 0, maxRSS: 0 }),
    nextTick(fn, ...args) {
      queueMicrotask(() => guard(fn, args));
    },
    emitWarning(warning, type, code) {
      if (typeof type === 'object' && type) ({ type, code } = type);
      let w = warning instanceof Error ? warning : Object.assign(new Error(String(warning)), { name: type || 'Warning', code });
      if (w.name === 'DeprecationWarning') {
        if (proc.noDeprecation) return;
        if (proc.throwDeprecation) throw w;
      }
      queueMicrotask(() => {
        proc.emit('warning', w);
        if (!warningsOff) proc.stderr.write(`(node:${proc.pid}) ${w.code ? `[${w.code}] ` : ''}${w.name}: ${w.message}\n`);
      });
    },
    exit(code) {
      if (code !== undefined) exitCode = Number(code) | 0;
      doExit();
      throw new ProcessExit(exitCode);
    },
    reallyExit(code) {
      proc.exit(code);
    },
    abort() {
      exitCode = 134;
      doExit();
      throw new ProcessExit(134);
    },
    kill(pid, signal = 'SIGTERM') {
      if (Number(pid) === proc.pid) {
        let sig = String(signal);
        if (proc.listenerCount(sig)) {
          queueMicrotask(() => proc.emit(sig, sig));
          return true;
        }
        exitCode = 128 + (sig === 'SIGINT' ? 2 : sig === 'SIGKILL' ? 9 : 15);
        doExit();
        throw new ProcessExit(exitCode);
      }
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH', errno: -3, syscall: 'kill' });
    },
    binding(name) {
      throw new Error('No such module: ' + name);
    },
    getBuiltinModule: (id) => o.getBuiltin?.(id),
    loadEnvFile(path = '.env') {
      let text = o.readText(path);
      for (let [k, v] of Object.entries(parseEnv(text))) if (!(k in envTarget)) env[k] = v;
    },
    setSourceMapsEnabled() {},
    report: { writeReport() {}, getReport: () => ({}) },
  }));

  function doExit() {
    if (exited) return;
    exited = true;
    for (let t of [...timers]) t._clear();
    try {
      proc.emit('exit', exitCode);
    } catch (err) {
      // An exit listener that throws still ends the process.
    }
    for (let w of exitWaiters.splice(0)) w(exitCode);
    for (let w of idleWaiters.splice(0)) w();
  }

  /* ---------- errors ---------- */
  function errorText(err) {
    if (err instanceof Error) {
      let stack = cleanStack(err, o.mapStack);
      let extra = Object.keys(err).filter((k) => !['stack', 'message'].includes(k));
      if (extra.length) return stack + ' ' + inspect(Object.fromEntries(extra.map((k) => [k, err[k]])));
      return stack;
    }
    return 'Uncaught ' + inspect(err);
  }
  function reportUncaught(err, origin = 'uncaughtException') {
    if (err instanceof ProcessExit || exited) return;
    if (proc.listenerCount('uncaughtException')) {
      try {
        proc.emit('uncaughtException', err, origin);
        return;
      } catch (e) {
        err = e;
      }
    }
    fatal = err;
    let file = o.entryFile || '[eval]';
    o.writeErr(enc.encode(`${file}\n\n${errorText(err)}\n\nNode.js v${NODE_VERSION}\n`));
    exitCode = err?.code === 'ERR_UNHANDLED_REJECTION' ? 1 : 1;
    doExit();
  }
  let rejectionMode = o.unhandledRejections || 'throw';
  function onRejection(reason, promise) {
    if (exited || reason instanceof ProcessExit) return;
    if (proc.listenerCount('unhandledRejection')) {
      proc.emit('unhandledRejection', reason, promise);
      return;
    }
    if (rejectionMode === 'none') return;
    if (rejectionMode === 'warn' || rejectionMode === 'warn-with-error-code') {
      proc.stderr.write(`(node:${proc.pid}) UnhandledPromiseRejectionWarning: ${errorText(reason)}\n`);
      if (rejectionMode === 'warn-with-error-code') exitCode = 1;
      return;
    }
    if (reason instanceof Error) reportUncaught(reason, 'unhandledRejection');
    else {
      let err = new Error(`This error originated either by throwing inside of an async function without a catch block, or by rejecting a promise which was not handled with .catch(). The promise rejected with the reason "${inspect(reason)}".`);
      err.code = 'ERR_UNHANDLED_REJECTION';
      reportUncaught(err, 'unhandledRejection');
    }
  }

  // Signals from the shell (Ctrl-C → SIGINT, kill → SIGTERM, …).
  let SIGNO = { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGUSR1: 10, SIGUSR2: 12, SIGTERM: 15 };
  function signal(sig = 'SIGINT') {
    if (exited) return;
    if (sig !== 'SIGKILL' && proc.listenerCount(sig)) {
      try {
        proc.emit(sig, sig);
      } catch (err) {
        reportUncaught(err);
      }
      return;
    }
    exitCode = 128 + (SIGNO[sig] || 2);
    doExit();
  }
  o.signal?.addEventListener('abort', () => signal('SIGINT'));

  /* ---------- console ---------- */
  let groupIndent = '';
  let counts = new Map();
  let timersLabel = new Map();
  let line = (stream, args) => {
    let text = formatWithOptions({ colors: false }, ...args);
    if (groupIndent) text = text.replace(/^/gm, groupIndent);
    stream.write(text + '\n');
  };
  let consoleObj = {
    log: (...a) => line(stdout, a),
    info: (...a) => line(stdout, a),
    debug: (...a) => line(stdout, a),
    warn: (...a) => line(stderr, a),
    error: (...a) => line(stderr, a),
    trace: (...a) => {
      let err = new Error(format(...a));
      err.name = 'Trace';
      line(stderr, [cleanStack(err, o.mapStack)]);
    },
    dir: (obj, opts) => line(stdout, [inspect(obj, { ...opts, customInspect: false })]),
    dirxml: (...a) => line(stdout, a),
    assert: (cond, ...a) => {
      if (!cond) line(stderr, ['Assertion failed' + (a.length ? ': ' + format(...a) : '')]);
    },
    count: (label = 'default') => {
      let n = (counts.get(label) || 0) + 1;
      counts.set(label, n);
      line(stdout, [`${label}: ${n}`]);
    },
    countReset: (label = 'default') => counts.set(label, 0),
    group: (...a) => {
      if (a.length) line(stdout, a);
      groupIndent += '  ';
    },
    groupCollapsed: (...a) => consoleObj.group(...a),
    groupEnd: () => {
      groupIndent = groupIndent.slice(2);
    },
    time: (label = 'default') => timersLabel.set(label, performance.now()),
    timeEnd: (label = 'default') => {
      let t = timersLabel.get(label);
      if (t == null) return;
      timersLabel.delete(label);
      line(stdout, [`${label}: ${fmtMs(performance.now() - t)}`]);
    },
    timeLog: (label = 'default', ...a) => {
      let t = timersLabel.get(label);
      if (t == null) return;
      line(stdout, [`${label}: ${fmtMs(performance.now() - t)}`, ...a]);
    },
    table: (data, cols) => line(stdout, [table(data, cols)]),
    clear: () => {},
    profile() {},
    profileEnd() {},
    timeStamp() {},
  };
  consoleObj.Console = class Console {
    constructor(out, err) {
      let o2 = out?.stdout ? out : { stdout: out, stderr: err || out };
      let w = (s) => (...a) => s.write(format(...a) + '\n');
      Object.assign(this, consoleObj, { log: w(o2.stdout), info: w(o2.stdout), error: w(o2.stderr), warn: w(o2.stderr) });
    }
  };

  /* ---------- globals visible to modules ---------- */
  function wrappedFetch(...args) {
    let release = ref();
    return realFetch(...args).finally(release);
  }
  let overrides = {
    process: proc,
    console: consoleObj,
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval: clearTimeout,
    setImmediate,
    clearImmediate,
    fetch: wrappedFetch,
  };
  let globalStore = Object.create(null);
  let globalObj = new Proxy(globalThis, {
    get(t, k) {
      if (k in overrides) return overrides[k];
      if (k in globalStore) return globalStore[k];
      if (k === 'global' || k === 'globalThis') return globalObj;
      let v = Reflect.get(t, k);
      return typeof v === 'function' && /^[a-z]/.test(String(k)) && !v.prototype ? v.bind(t) : v;
    },
    set(t, k, v) {
      if (k in overrides) overrides[k] = v;
      else globalStore[k] = v;
      return true;
    },
    has(t, k) {
      return k in overrides || k in globalStore || k in t;
    },
    deleteProperty(t, k) {
      delete globalStore[k];
      return true;
    },
  });

  return {
    process: proc,
    console: consoleObj,
    global: globalObj,
    overrides,
    timers: { setTimeout, clearTimeout, setInterval, clearInterval: clearTimeout, setImmediate, clearImmediate },
    ref,
    whenIdle,
    whenExit,
    reportUncaught,
    onRejection,
    signal,
    doExit,
    get exited() {
      return exited;
    },
    get pending() {
      return refs;
    },
    get exitCode() {
      return exitCode;
    },
    set exitCode(v) {
      exitCode = v;
    },
    get fatal() {
      return fatal;
    },
    errorText,
  };
}

function fmtMs(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(3) + 's';
  return ms.toFixed(3) + 'ms';
}

/**
 * Make stacks look like Node's: drop frames from the runtime itself (page
 * modules, bundle prelude) and map bundle lines back to source files.
 */
export function cleanStack(err, mapStack) {
  let stack = String(err?.stack || `${err?.name || 'Error'}: ${err?.message}`);
  let lines = stack.split('\n');
  let firstFrame = lines.findIndex((l) => /^\s+at /.test(l));
  let head = firstFrame === -1 ? lines : lines.slice(0, firstFrame);
  let frames = firstFrame === -1 ? [] : lines.slice(firstFrame);
  let out = [];
  for (let l of frames) {
    if (/https?:\/\//.test(l)) continue; // page / CDN code (shell, runtime, libraries)
    if (/^\s+at (async )?(evaluate|load|prepare|makeRequire|require|eval|anonymous) \(node:/.test(l)) continue; // prelude
    if (/^\s+at (async )?(new Promise|Array\.forEach) \(<anonymous>\)/.test(l)) continue;
    let mapped = mapStack ? mapStack(l) : l;
    if (mapped) out.push(mapped);
  }
  return [...head, ...out].join('\n');
}

export function parseEnv(text) {
  let out = {};
  for (let raw of String(text || '').split(/\r?\n/)) {
    let l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    let m = /^(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(l);
    if (!m) continue;
    let v = m[2];
    if (/^"/.test(v)) v = v.replace(/^"((?:[^"\\]|\\.)*)".*$/, '$1').replace(/\\n/g, '\n');
    else if (/^'/.test(v)) v = v.replace(/^'([^']*)'.*$/, '$1');
    else v = v.replace(/\s+#.*$/, '').trim();
    out[m[1]] = v;
  }
  return out;
}

function table(data, cols) {
  if (data == null || typeof data !== 'object') return inspect(data);
  let rows = data instanceof Map ? [...data] : Object.entries(data);
  let keys = new Set();
  let hasValues = false;
  for (let [, v] of rows) {
    if (v && typeof v === 'object') for (let k of Object.keys(v)) keys.add(k);
    else hasValues = true;
  }
  let headers = ['(index)', ...(cols || [...keys])];
  if (hasValues) headers.push('Values');
  let cell = (v) => (v === undefined ? '' : typeof v === 'string' ? `'${v}'` : inspect(v, { depth: 0, breakLength: Infinity }));
  let body = rows.map(([k, v]) => {
    let r = [String(k)];
    for (let c of cols || [...keys]) r.push(v && typeof v === 'object' ? cell(v[c]) : '');
    if (hasValues) r.push(v && typeof v === 'object' ? '' : cell(v));
    return r;
  });
  let widths = headers.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)) + 2);
  let pad = (s, w) => {
    let left = Math.floor((w - s.length) / 2);
    return ' '.repeat(left) + s + ' '.repeat(w - s.length - left);
  };
  let sep = (l, m, r) => l + widths.map((w) => '─'.repeat(w)).join(m) + r;
  return [
    sep('┌', '┬', '┐'),
    '│' + headers.map((h, i) => pad(h, widths[i])).join('│') + '│',
    sep('├', '┼', '┤'),
    ...body.map((r) => '│' + r.map((c, i) => pad(c, widths[i])).join('│') + '│'),
    sep('└', '┴', '┘'),
  ].join('\n');
}

export { dec as textDecoder, enc as textEncoder };
