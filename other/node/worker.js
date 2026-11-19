/**
 * A node process: runs inside a dedicated module Worker spawned by node.js.
 *
 * Talks to the page only through the syscall channel (channel.js): blocking
 * fs calls wait on a SharedArrayBuffer, everything else is messages. Parses
 * the CLI with commander (bundled from jsdelivr by vfs-browserify), bundles the
 * script from the VFS and runs the bundle as an AsyncFunction, so top-level
 * await works. Node's globals (process, Buffer, timers, …) are real worker
 * globals, so each process is fully isolated from the page and other processes.
 */
import path from './path.js';
import { createSyscalls, toError } from './channel.js';
import { bundle, ResolveError, loadBabel, createResolver, needsTransform, transformSync } from './browserify.js';
import { createWorkerFs } from './worker-fs.js';
import { createRuntime, ProcessExit, NODE_VERSION, parseEnv } from './runtime.js';
import { createBuiltins, builtinName, preloadBuiltins, Buffer, EventEmitter, streamMod, BUILTIN_NAMES } from './builtins.js';
import { inspect } from './inspect.js';

let AsyncFunction = (async () => {}).constructor;
let enc = new TextEncoder();

/* ---------- host libraries from jsdelivr (commander) ---------- */

async function cdnHost(name, version) {
  let res = await fetch(`https://data.jsdelivr.com/v1/packages/npm/${name}@${version}?structure=flat`);
  if (!res.ok) throw new Error(`jsdelivr listing failed for ${name}@${version}: ${res.status}`);
  let listing = await res.json();
  let root = `/cdn/node_modules/${name}`;
  let files = new Set(listing.files.map((f) => root + f.name));
  let dirs = new Set(['/', '/cdn', '/cdn/node_modules', root]);
  for (let f of files) {
    let parts = f.split('/');
    for (let i = 2; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  let texts = new Map();
  let fetchText = async (abs) => {
    if (!texts.has(abs)) {
      let r = await fetch(`https://cdn.jsdelivr.net/npm/${name}@${version}${abs.slice(root.length)}`);
      if (!r.ok) throw new Error(`fetch ${abs}: ${r.status}`);
      texts.set(abs, await r.text());
    }
    return texts.get(abs);
  };
  await fetchText(root + '/package.json');
  return {
    isFile: (p) => files.has(p),
    isDir: (p) => dirs.has(p),
    readTextSync: (p) => {
      if (!texts.has(p)) throw new Error('not prefetched: ' + p);
      return texts.get(p);
    },
    readText: fetchText,
  };
}

/**
 * Bundle an npm CommonJS package from the CDN; returns its exports given a
 * builtin resolver. The page caches the bundle body (init.libCache) so later
 * processes skip the CDN round trips; new bundles are posted back to it.
 */
let libCache = {};
async function cdnPackage(name, version, builtin) {
  let key = `${name}@${version}`;
  let body = libCache[key];
  if (!body) {
    let host = await cdnHost(name, version);
    let out = await bundle({
      host,
      isBuiltin: builtinName,
      entries: [{ file: '/cdn/[host].js', source: `module.exports = require(${JSON.stringify(name)});`, type: 'commonjs' }],
      cwd: '/cdn',
    });
    body = out.body;
    self.postMessage({ t: 'lib-cache', key, body });
  }
  return (await new AsyncFunction('__builtin', body)(builtin)).exports;
}

/* ---------- argument parsing ---------- */

let collect = (v, prev) => [...prev, v];

// commander captures `process` when it loads, so it gets one whose I/O is bound
// to the current run (cliIo); that lets a warm worker load commander ahead of time.
let cliIo = { out() {}, err() {}, env: {}, cwd: '/', argv: [] };
let cliProcess = Object.defineProperties(new EventEmitter(), Object.getOwnPropertyDescriptors({
  get argv() {
    return ['/usr/bin/node', ...cliIo.argv];
  },
  get env() {
    return cliIo.env;
  },
  platform: 'linux',
  stdout: { write: (s) => cliIo.out(String(s)), isTTY: false, columns: 80, hasColors: () => false },
  stderr: { write: (s) => cliIo.err(String(s)), isTTY: false, columns: 80, hasColors: () => false },
  exit: (c) => {
    throw new ProcessExit(c);
  },
  execArgv: [],
  cwd: () => cliIo.cwd,
  versions: { node: NODE_VERSION },
}));
let commanderPromise = null;
function loadCommander() {
  let mini = { events: EventEmitter, path, process: cliProcess, fs: {}, child_process: {} };
  commanderPromise ??= cdnPackage('commander', '14.0.2', (id) => mini[String(id).replace(/^node:/, '')]);
  return commanderPromise;
}

async function parseNodeArgs(argv, io) {
  cliIo = { ...io, argv };
  let { Command, Option } = await loadCommander();

  let program = new Command('node')
    .usage('[options] [ script.js ] [arguments]')
    .description('Run JavaScript on the Tehboxen simulated Node.js runtime.\nScripts are bundled from the VFS (CommonJS, ES modules, TypeScript) and run in a Worker with top-level await.')
    .version('v' + NODE_VERSION, '-v, --version', 'print Node.js version')
    .helpOption('-h, --help', 'print node command line options (currently set)')
    .option('-e, --eval <script>', 'evaluate script')
    .option('-p, --print <script>', 'evaluate script and print result')
    .option('-c, --check', 'syntax check script without executing')
    .option('-i, --interactive', 'always enter the REPL even if stdin does not appear to be a terminal')
    .option('-r, --require <module>', 'CommonJS module to preload (option can be repeated)', collect, [])
    .option('--import <module>', 'ES module to preload (option can be repeated)', collect, [])
    .option('-C, --conditions <condition>', 'additional user conditions for conditional exports and imports', collect, [])
    .addOption(new Option('--input-type <type>', 'set module type for string input').choices(['commonjs', 'module']))
    .addOption(new Option('--experimental-default-type <type>', 'set module system to use by default').choices(['commonjs', 'module']))
    .option('--env-file <path>', 'set environment variables from supplied file', collect, [])
    .option('--env-file-if-exists <path>', 'set environment variables from supplied file, if it exists', collect, [])
    .addOption(new Option('--unhandled-rejections <mode>', 'define unhandled rejections behavior').choices(['strict', 'warn', 'none', 'throw', 'warn-with-error-code']))
    .option('--no-warnings', 'silence all process warnings')
    .option('--disable-warning <code-or-type>', 'silence specific process warnings', collect, [])
    .option('--no-deprecation', 'silence deprecation warnings')
    .option('--trace-deprecation', 'show stack traces on deprecations')
    .option('--throw-deprecation', 'throw an exception on deprecations')
    .option('--pending-deprecation', 'emit pending deprecation warnings')
    .option('--trace-warnings', 'show stack traces on process warnings')
    .option('--trace-uncaught', 'show stack traces for the `throw` behind uncaught exceptions')
    .option('--trace-exit', 'show stack trace when an environment exits')
    .option('--preserve-symlinks', 'preserve symbolic links when resolving')
    .option('--preserve-symlinks-main', 'preserve symbolic links when resolving the main module')
    .option('--enable-source-maps', 'source map support for stack traces')
    .option('--abort-on-uncaught-exception', 'aborting instead of exiting causes a core file to be generated')
    .option('--title <title>', 'the process title to use on startup')
    .option('--stack-trace-limit <n>', 'V8: number of stack frames to capture', (v) => parseInt(v, 10))
    .option('--max-old-space-size <mb>', 'V8: max heap size (accepted, ignored)')
    .option('--stack-size <n>', 'V8: stack size (accepted, ignored)')
    .option('--expose-gc', 'V8: expose gc() (no-op in Tehboxen)')
    .option('--run <script>', 'run a script specified in package.json')
    .option('--watch', 'run in watch mode (not available yet)')
    .option('--test', 'launch test runner on startup (not available yet)')
    .option('--inspect [[host:]port]', 'activate inspector (not available)')
    .option('--inspect-brk [[host:]port]', 'activate inspector and break at start (not available)')
    .option('--experimental-strip-types', 'strip TypeScript types (always on in Tehboxen)')
    .option('--experimental-transform-types', 'transform TypeScript-only syntax (always on)')
    .option('--experimental-detect-module', 'detect module syntax (always on)')
    .option('--no-experimental-detect-module', 'disable module syntax detection (ignored)')
    .option('--experimental-require-module', 'allow require() of ES modules (always on)')
    .option('--experimental-vm-modules', 'accepted, ignored')
    .option('--zero-fill-buffers', 'automatically zero-fill all newly allocated Buffer instances')
    .option('--no-addons', 'disable loading native addons')
    .argument('[script]', 'script file to run; "-" reads it from stdin')
    .argument('[args...]', 'arguments passed to the script as process.argv')
    .passThroughOptions()
    .exitOverride()
    .configureOutput({
      writeOut: (s) => io.out(s),
      writeErr: (s) => io.err(s),
      outputError: () => {},
      getOutHelpWidth: () => 100,
      getErrHelpWidth: () => 100,
      getOutHasColors: () => false,
      getErrHasColors: () => false,
    });
  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof ProcessExit) return { exit: err.exitCode };
    if (err?.code === 'commander.helpDisplayed' || err?.code === 'commander.version') return { exit: 0 };
    if (err?.code === 'commander.unknownOption') {
      io.err(`node: bad option: ${/'([^']+)'/.exec(err.message)?.[1] || ''}\n`);
      return { exit: 9 };
    }
    if (err?.code?.startsWith?.('commander.')) {
      io.err('node: ' + String(err.message).replace(/^error: /, '') + '\n');
      return { exit: 9 };
    }
    throw err;
  }
  let [script, args = []] = program.processedArgs;
  return { opts: program.opts(), script, args };
}

function syntaxErrorText(err, file) {
  let msg = String(err.message || err);
  let loc = /\((\d+):(\d+)\)/.exec(msg);
  let head = loc ? `${file}:${loc[1]}` : file;
  let frame = msg.includes('\n') ? msg.slice(msg.indexOf('\n') + 1) : '';
  let first = msg.split('\n')[0].replace(/^[^:]*?:\s*/, '').replace(/\s*\(\d+:\d+\)$/, '');
  return `${head}\n${frame ? frame.replace(/\x1b\[[0-9;]*m/g, '') + '\n' : ''}\nSyntaxError: ${first}\n\nNode.js v${NODE_VERSION}\n`;
}

/* ---------- the process ---------- */

async function main(init) {
  if (init.libCache) libCache = { ...init.libCache, ...libCache };
  warm();
  // Hash / zip libraries load while the CLI is parsed and the script bundled.
  let preloading = preloadBuiltins();
  preloading.catch(() => {});
  let sys = createSyscalls(init.sab);
  let post = (msg, transfer) => self.postMessage(msg, transfer || []);
  let writeOut = (bytes) => post({ t: 'out', b: bytes.slice() });
  let writeErr = (bytes) => post({ t: 'err', b: bytes.slice() });
  let io = { out: (s) => writeOut(enc.encode(s)), err: (s) => writeErr(enc.encode(s)), env: init.env, cwd: init.cwd };
  let exit = (code) => post({ t: 'exit', code: Number(code) | 0 });

  // Toolchain commands (clang, wasm-ld, llvm-*) run here too, without the node CLI.
  if (init.tool) {
    let { runTool } = await import('./clang.js');
    let lastPct = -10;
    let fetchStart = performance.now();
    try {
      let code = await runTool({
        name: init.tool.name,
        args: init.tool.args,
        cwd: init.cwd,
        sys,
        path,
        stdout: writeOut,
        stderr: writeErr,
        stdin: () => init.stdin || new Uint8Array(0),
        cached: init.toolCache,
        onCacheable: (assets) => post({ t: 'tool-cache', assets }),
        cachedSysroots: init.toolCache?.sysroots,
        onCacheableSysroot: (key, tgz) => post({ t: 'tool-cache-sysroot', key, tgz }),
        progress: (done, total) => {
          let pct = Math.floor((100 * done) / total);
          // Only report real downloads (after a cached first run this finishes in about a second).
          if (performance.now() - fetchStart < 1500) return;
          if (pct >= lastPct + 10 || done === total) {
            lastPct = pct;
            io.err(`${init.tool.name}: fetching toolchain ${pct}% (${(done / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)\n`);
          }
        },
      });
      return exit(code);
    } catch (err) {
      io.err(`${init.tool.name}: ${err?.stack || err}\n`);
      return exit(70);
    }
  }

  let parsed;
  try {
    parsed = await parseNodeArgs(init.argv, io);
  } catch (err) {
    io.err(`node: ${err?.message || err}\n`);
    return exit(1);
  }
  if (parsed.exit != null) return exit(parsed.exit);
  let { opts, script } = parsed;
  let args = parsed.args;

  let source = opts.eval ?? opts.print;
  let isEval = source != null;
  if (isEval && script != null) args = [script, ...args];
  if (opts.print != null && opts.eval != null) source = opts.print;
  let unsupported = opts.test ? '--test' : opts.watch ? '--watch' : opts.interactive ? '-i' : null;
  if (unsupported) {
    io.err(`node: ${unsupported} is not available in Tehboxen yet\n`);
    return exit(9);
  }
  if (opts.inspect || opts.inspectBrk) io.err('Debugger is not available in Tehboxen; running without inspector.\n');

  let cwd = init.cwd || '/';
  let env = { ...init.env };
  let actor = init.actor;
  let procCwd = cwd;
  let rt = null;
  let releaseRef = () => () => {};

  let watchSeq = 0;
  let watchers = new Map();
  self.addEventListener('message', (ev) => {
    let m = ev.data || {};
    if (m.t === 'watch-ev') watchers.get(m.wid)?.(m.eventType, m.filename);
  });
  let nodeFs = createWorkerFs({
    sys,
    cwd: () => procCwd,
    Buffer,
    path,
    events: { EventEmitter },
    stream: streamMod,
    stdio: { stdin: () => stdinBytes, stdout: writeOut, stderr: writeErr },
    keepAlive: () => (rt ? rt.ref() : () => {}),
    watch: (p, fn) => {
      let wid = ++watchSeq;
      watchers.set(wid, fn);
      post({ t: 'watch', wid, path: p });
      return () => {
        watchers.delete(wid);
        post({ t: 'unwatch', wid });
      };
    },
  });
  void releaseRef;
  // process.env is a Proxy; send a plain copy (structured clone can't copy proxies).
  let execArgs = (cmd, o = {}) => ({ cmd, cwd: o.cwd ? path.resolve(procCwd, o.cwd) : procCwd, env: { ...(o.env || rt?.process.env || env) }, stdin: o.stdin ?? undefined });
  let execAsync = (cmd, o) => sys.async('exec', execArgs(cmd, o));
  let execSync = (cmd, o) => sys.sync('exec', execArgs(cmd, o));

  // --run: package.json scripts through the shell
  if (opts.run) {
    let dir = cwd;
    let pkg = null;
    for (;;) {
      try {
        pkg = JSON.parse(nodeFs.fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        break;
      } catch {}
      if (dir === '/') break;
      dir = path.dirname(dir);
    }
    let cmd = pkg?.scripts?.[opts.run];
    if (cmd == null) {
      io.err(`Missing script: "${opts.run}"\n\nAvailable scripts are:\n${Object.entries(pkg?.scripts || {}).map(([k, v]) => `  ${k}: ${v}\n`).join('')}`);
      return exit(1);
    }
    let r = await sys.async('exec', { cmd: [cmd, ...args].join(' '), cwd: dir, env });
    if (r.stdout) io.out(r.stdout);
    if (r.stderr) io.err(r.stderr);
    return exit(r.code);
  }

  let stdinBytes = init.stdin || new Uint8Array(0);
  if (!isEval && (script == null || script === '-')) {
    if (!init.stdinPiped && script !== '-') {
      io.err(`Welcome to Node.js v${NODE_VERSION} (Tehboxen).\nThe interactive REPL is not available yet: run a file (node app.js), use -e / -p, or pipe code (echo 'console.log(1)' | node).\n`);
      return exit(0);
    }
    source = new TextDecoder().decode(stdinBytes);
    stdinBytes = new Uint8Array(0);
  }

  try {
    await preloading;
  } catch (err) {
    io.err(`node: ${err?.message || err}\n`);
    return exit(1);
  }

  for (let [list, required] of [[opts.envFile, true], [opts.envFileIfExists, false]]) {
    for (let f of list || []) {
      try {
        for (let [k, v] of Object.entries(parseEnv(String(nodeFs.fs.readFileSync(path.resolve(cwd, f), 'utf8'))))) if (!(k in init.env)) env[k] = v;
      } catch {
        if (required) {
          io.err(`node: ${path.resolve(cwd, f)}: not found\n`);
          return exit(9);
        }
      }
    }
  }

  let entryFile = isEval ? path.join(cwd, '[eval]') : script === '-' || script == null ? path.join(cwd, '[stdin]') : path.resolve(cwd, script);
  let pendingSignal = null;
  self.addEventListener('message', (ev) => {
    if (ev.data?.t !== 'signal') return;
    if (rt) rt.signal(ev.data.sig);
    else pendingSignal = ev.data.sig;
  });
  let mapStack = null;
  rt = createRuntime({
    argv: ['/usr/bin/node', ...(isEval ? [] : [entryFile]), ...args],
    execArgv: init.argv.slice(0, Math.max(0, init.argv.length - args.length - (isEval || script == null ? 0 : 1))),
    env,
    getCwd: () => procCwd,
    setCwd: (d) => {
      let next = path.resolve(procCwd, String(d));
      let st = nodeFs.fs.statSync(next, { throwIfNoEntry: false });
      if (!st) throw Object.assign(new Error(`ENOENT: no such file or directory, chdir ${procCwd} -> '${d}'`), { code: 'ENOENT', errno: -2, syscall: 'chdir' });
      if (!st.isDirectory()) throw Object.assign(new Error(`ENOTDIR: not a directory, chdir ${procCwd} -> '${d}'`), { code: 'ENOTDIR', errno: -20, syscall: 'chdir' });
      procCwd = next;
    },
    writeOut,
    writeErr,
    stdin: stdinBytes,
    stdinPiped: init.stdinPiped,
    tty: init.tty,
    actor,
    EventEmitter,
    Readable: streamMod.Readable,
    Buffer,
    pid: init.pid,
    ppid: init.ppid,
    unhandledRejections: opts.unhandledRejections,
    noWarnings: opts.warnings === false,
    noDeprecation: opts.deprecation === false,
    throwDeprecation: !!opts.throwDeprecation,
    traceDeprecation: !!opts.traceDeprecation,
    entryFile,
    mapStack: (f) => (mapStack ? mapStack(f) : f),
    readText: (p) => String(nodeFs.fs.readFileSync(path.resolve(procCwd, p), 'utf8')),
  });
  // WebCrypto work keeps the process alive, like libuv's threadpool does for node:crypto
  // (an async main that awaits crypto.subtle would otherwise exit mid-flight).
  {
    let subtle = globalThis.crypto?.subtle;
    let methods = ['encrypt', 'decrypt', 'sign', 'verify', 'digest', 'generateKey', 'deriveKey', 'deriveBits', 'importKey', 'exportKey', 'wrapKey', 'unwrapKey'];
    if (subtle && !subtle.__tbRef) {
      for (let m of methods) {
        let orig = typeof subtle[m] === 'function' ? subtle[m].bind(subtle) : null;
        if (!orig) continue;
        Object.defineProperty(subtle, m, {
          configurable: true,
          value: (...a) => {
            let release = rt.ref();
            return Promise.resolve(orig(...a)).finally(release);
          },
        });
      }
      Object.defineProperty(subtle, '__tbRef', { value: true });
    }
  }
  if (opts.title) rt.process.title = opts.title;
  if (pendingSignal) rt.signal(pendingSignal);

  let fileHost = nodeFs.bundlerHost();
  let builtins;
  let moduleApi = () => {
    let Module = function Module(id = '') {
      this.id = id;
      this.exports = {};
    };
    Object.assign(Module, {
      builtinModules: BUILTIN_NAMES.slice(),
      isBuiltin: (s) => !!builtinName(s),
      createRequire: (filename) => {
        let from = String(filename instanceof URL ? decodeURIComponent(filename.pathname) : filename).replace(/^file:\/\//, '');
        let req = (spec) => {
          let b = builtinName(spec);
          if (b) return builtins(b);
          throw Object.assign(new Error(`Cannot find module '${spec}'\nRequire stack:\n- ${from}\n(Tehboxen: createRequire() loads builtins only)`), { code: 'MODULE_NOT_FOUND' });
        };
        req.resolve = (spec) => (builtinName(spec) ? spec : path.resolve(path.dirname(from), spec));
        req.cache = {};
        return req;
      },
      syncBuiltinESMExports() {},
      register() {},
      findSourceMap: () => undefined,
      enableCompileCache: () => ({ status: 3 }),
      constants: { compileCacheStatus: { FAILED: 0, ENABLED: 1, ALREADY_ENABLED: 2, DISABLED: 3 } },
      _extensions: {},
      _cache: {},
      wrap: (s) => `(function (exports, require, module, __filename, __dirname) { ${s}\n});`,
    });
    Module.Module = Module;
    return Module;
  };
  builtins = createBuiltins({ rt, nodeFs, actor, env, moduleApi, exec: execAsync, execSync, tty: init.tty, stdinTty: !!init.stdinTty, sys, stdio: { stdin: () => stdinBytes, stdout: writeOut, stderr: writeErr } });
  rt.process.getBuiltinModule = (id) => {
    let b = builtinName(id);
    return b ? builtins(b) : undefined;
  };
  let builtinFor = (spec) => {
    let b = builtinName(spec);
    return b ? builtins(b) : undefined;
  };

  // Node's globals are real worker globals.
  let o = rt.overrides;
  Object.assign(globalThis, {
    process: o.process,
    Buffer,
    global: globalThis,
    setTimeout: o.setTimeout,
    clearTimeout: o.clearTimeout,
    setInterval: o.setInterval,
    clearInterval: o.clearInterval,
    setImmediate: o.setImmediate,
    clearImmediate: o.clearImmediate,
    fetch: o.fetch,
    console: o.console,
  });
  if (opts.exposeGc) globalThis.gc = () => {};
  globalThis.__tehboxenProcess = rt.process;
  globalThis.__tehboxenNodeDebug = env.NODE_DEBUG || '';

  // Entry
  let entries;
  if (source != null) {
    let code = String(source);
    if (opts.print != null) {
      let isExpr = true;
      try {
        new AsyncFunction(`return (${code}\n)`);
      } catch {
        isExpr = false;
      }
      code = isExpr ? `return (${code}\n);` : `return eval(${JSON.stringify(code)});`;
    }
    entries = [{ file: entryFile, source: code, type: opts.inputType || opts.experimentalDefaultType || undefined }];
  } else {
    let found = fileHost.isFile(entryFile) ? entryFile : ['.js', '.mjs', '.cjs', '.ts', '.json'].map((e) => entryFile + e).find((f) => fileHost.isFile(f)) || (fileHost.isDir(entryFile) && fileHost.isFile(entryFile + '/index.js') ? entryFile + '/index.js' : null);
    if (!found) {
      io.err(`node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '${entryFile}'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n    at node:internal/main/run_main_module:28:49 {\n  code: 'MODULE_NOT_FOUND',\n  requireStack: []\n}\n\nNode.js v${NODE_VERSION}\n`);
      return exit(1);
    }
    try {
      nodeFs.fs.accessSync(found, 4);
    } catch (err) {
      io.err(`node:internal/fs/utils:356\n    throw err;\n    ^\n\nError: ${err.message}\n\nNode.js v${NODE_VERSION}\n`);
      return exit(1);
    }
    entryFile = opts.preserveSymlinksMain ? found : fileHost.realpath(found);
    entries = [{ file: entryFile }];
  }

  let bundled;
  try {
    bundled = await bundle({ host: fileHost, isBuiltin: builtinName, transformCache, entries, preload: opts.require, imports: opts.import, cwd: procCwd, conditions: opts.conditions, preserveSymlinks: !!opts.preserveSymlinks });
  } catch (err) {
    if (err?.code === 'ERR_SYNTAX') io.err(syntaxErrorText(err, err.file || entryFile));
    else if (err instanceof ResolveError) io.err(`node:internal/modules/run_main\n\nError: ${err.message}\n  code: '${err.code}'\n\nNode.js v${NODE_VERSION}\n`);
    else io.err(`node: ${err?.stack || err}\n`);
    return exit(1);
  }

  // Map "node:<entry>:LINE:COL" frames (bundle lines) back to module files.
  // new AsyncFunction(params, body) puts body line 1 on line 3 of its source.
  let bundleUrl = 'node:' + entryFile;
  mapStack = (frame) => {
    let i = frame.indexOf(bundleUrl + ':');
    if (i === -1) return frame;
    let m = /^(\d+):(\d+)/.exec(frame.slice(i + bundleUrl.length + 1));
    if (!m) return frame;
    let bodyLine = Number(m[1]) - 2;
    let hit = bundled.lineMap.find((r) => bodyLine >= r.start && bodyLine <= r.end);
    if (!hit) return null;
    let rest = frame.slice(i + bundleUrl.length + 1 + m[0].length);
    return frame.slice(0, i).replace(/at (async )?\d+ \($/, 'at $1Object.<anonymous> (') + `${hit.file}:${bodyLine - hit.start + 1}:${m[2]}` + rest;
  };

  let compiled;
  try {
    compiled = new AsyncFunction('__builtin', '__dynamic', bundled.body + `\n//# sourceURL=node:${entryFile}`);
  } catch (err) {
    io.err(syntaxErrorText(err, entryFile));
    return exit(1);
  }
  if (opts.check) return exit(0);

  if (Number.isFinite(opts.stackTraceLimit)) Error.stackTraceLimit = opts.stackTraceLimit;
  self.addEventListener('unhandledrejection', (ev) => {
    ev.preventDefault();
    rt.onRejection(ev.reason, ev.promise);
  });
  self.addEventListener('error', (ev) => {
    ev.preventDefault();
    if (!(ev.error instanceof ProcessExit)) rt.reportUncaught(ev.error);
  });

  let release = rt.ref();
  let printValue;
  try {
    let dynamic = createDynamicLoader({ fileHost: nodeFs.bundlerHost({ cache: false }), builtins, conditions: opts.conditions });
    let result = await Promise.race([compiled(builtinFor, dynamic), rt.whenExit().then(() => null)]);
    if (opts.print != null && result && !rt.exited) printValue = result.result;
  } catch (err) {
    if (!(err instanceof ProcessExit)) rt.reportUncaught(err);
  } finally {
    release();
  }
  if (opts.print != null && !rt.exited) io.out((typeof printValue === 'string' ? printValue : inspect(printValue)) + '\n');

  // Event loop: wait until idle; 'beforeExit' listeners may schedule more work.
  while (!rt.exited) {
    await Promise.race([rt.whenIdle(), rt.whenExit()]);
    if (rt.exited) break;
    if (rt.process.listenerCount('beforeExit')) {
      try {
        rt.process.emit('beforeExit', rt.exitCode);
      } catch (err) {
        if (!(err instanceof ProcessExit)) rt.reportUncaught(err);
      }
      await new Promise((r) => rt.timers.setTimeout(r, 0));
      if (rt.pending > 0 && !rt.exited) continue;
    }
    rt.doExit();
  }
  nodeFs.flushAll();
  exit(rt.exitCode);
}

/* ---------- runtime require() for files outside the bundle ---------- */

/**
 * CommonJS loader over the synchronous fs host: what Node does for every
 * require, used here only when a specifier wasn't visible to the bundler
 * (computed paths, files generated at runtime).
 */
function createDynamicLoader({ fileHost, builtins, conditions }) {
  let resolver = createResolver({ host: fileHost, isBuiltin: builtinName, conditions: conditions || [] });
  let cache = new Map();
  let dirname = (f) => f.slice(0, f.lastIndexOf('/')) || '/';
  function makeRequire(from) {
    let req = (spec) => {
      let r = resolver.resolve(String(spec), from);
      if (r.builtin) return builtins(r.builtin);
      return load(r.file);
    };
    req.resolve = (spec) => {
      let r = resolver.resolve(String(spec), from);
      return r.builtin || r.file;
    };
    req.resolve.paths = () => [];
    req.cache = Object.fromEntries(cache);
    return req;
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    let module = { id: file, filename: file, path: dirname(file), exports: {}, loaded: false, children: [], paths: [] };
    cache.set(file, module);
    try {
      let text = fileHost.readTextSync(file);
      if (file.endsWith('.json')) module.exports = JSON.parse(text);
      else {
        let code = needsTransform(file, text, /\.c[jt]s$/.test(file) ? 'commonjs' : null) ? transformSync(file, text) : text.replace(/^#!/, '//');
        let fn = new Function('exports', 'require', 'module', '__filename', '__dirname', `${code}\n//# sourceURL=${file}`);
        let req = makeRequire(file);
        module.require = req;
        fn.call(module.exports, module.exports, req, module, file, dirname(file));
      }
    } catch (err) {
      cache.delete(file);
      throw err;
    }
    module.loaded = true;
    return module.exports;
  }
  return {
    require: (spec, from) => makeRequire(from)(spec),
    resolve: (spec, from) => makeRequire(from).resolve(spec),
  };
}

/* ---------- transform cache (kept by the page, shared by all processes) ---------- */

let xcSeq = 0;
let xcWaiting = new Map();
let transformCache = {
  get(key) {
    let id = ++xcSeq;
    return new Promise((resolve) => {
      xcWaiting.set(id, resolve);
      self.postMessage({ t: 'xc-get', id, key });
    });
  },
  set(key, value) {
    self.postMessage({ t: 'xc-set', key, value });
  },
};

/* ---------- lifecycle: warm (preload) → init (run) ---------- */

// Everything except Babel, which only loads on a transform-cache miss.
let warming = null;
function warm() {
  warming ??= Promise.allSettled([preloadBuiltins(), loadCommander()]);
  return warming;
}

self.addEventListener('message', (ev) => {
  let m = ev.data || {};
  if (m.t === 'xc-res') {
    xcWaiting.get(m.id)?.(m.value || null);
    xcWaiting.delete(m.id);
  } else if (m.t === 'warm') {
    libCache = m.libCache || {};
    warm().then(() => {
      self.postMessage({ t: 'ready' });
      // Babel (~3 MB) only matters on a transform-cache miss; load it while the worker idles.
      loadBabel().catch(() => {});
    });
  } else if (m.t === 'init') {
    main(m).catch((err) => {
      self.postMessage({ t: 'err', b: enc.encode(`node: internal error: ${err?.stack || err}\n`) });
      self.postMessage({ t: 'exit', code: 70 });
    });
  }
});

export { toError };
