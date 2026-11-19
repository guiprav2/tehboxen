import { PLAYER, PLAYER_HOME } from './session.js';
import { minimatch } from 'https://cdn.jsdelivr.net/npm/minimatch@10.2.6/+esm';
import { parse as parseBash } from 'https://cdn.jsdelivr.net/npm/unbash@5.0.0/+esm';
import {
  assertAccess,
  formatMode,
  parseModeSpec,
  resolveUserRef,
  resolveGroupRef,
  actorFromUser,
  groupsForUser,
  isRoot,
  getStat,
  setStat,
  ensureStat,
  listUsers,
  getUser,
  saveUser,
  removeUser,
  listGroups,
  getGroup,
  saveGroup,
  removeGroup,
  nextUid,
  nextGid,
  DEFAULT_FILE_MODE,
  DEFAULT_DIR_MODE,
  PLAYER_UID,
} from './vfs-auth.js';
import { sizeOf as vfsSizeOf, readlink as vfsReadlink, isSymlink as vfsIsSymlink, resolveLinkTarget } from './vfs.js';
import { getIndex as getLiveIndex } from './node/host.js';
import { hostname as netHostname } from './net/local.js';
import { NET_COMMANDS } from './net/commands.js';

// Async project shell. Paths are project-relative. Every directory keeps a
// `.keep` file, including directories that also contain other files.
let globOpts = { dot: false };

/** Default home directory inside the VFS (no leading slash). */
export let SHELL_HOME = PLAYER_HOME;

/** Process ids: one sequence for every shell, job and node process on the page. */
let pidSeq = 1000 + Math.floor(Math.random() * 20000);
export function allocPid() {
  return ++pidSeq;
}

let SIGNALS = { HUP: 1, INT: 2, QUIT: 3, KILL: 9, USR1: 10, USR2: 12, TERM: 15, CONT: 18, STOP: 19 };

/** Runs a WASI preview1 .wasm with `/` and `.` preopened (like `wasmtime --dir / --dir .`). */
let WASM_RUNNER = `
const { WASI } = require('node:wasi');
const fs = require('node:fs');
// argv: the module file, then argv[0] as invoked (busybox picks its applet from it), then the arguments.
const [file, argv0, ...args] = process.argv.slice(1);
const bytes = fs.readFileSync(file);
const mod = await WebAssembly.compile(bytes);
// wasi-libc resolves absolute paths by the longest preopen prefix, "/" and "." tying (the later wins).
// Tehboxen-built programs chdir to the real cwd at startup, so "/" must win; others keep "." for relative paths.
// The cwd is also preopened under its absolute name, so absolute paths inside it resolve either way.
const cwd = process.cwd();
const tehboxen = WebAssembly.Module.imports(mod).some((i) => i.module === 'tehboxen');
const preopens = tehboxen ? { '.': cwd, '/': '/' } : { '/': '/', '.': cwd };
if (cwd !== '/') preopens[cwd] = cwd;
// On a terminal, programs without TIOCGWINSZ (vim, less…) size themselves from LINES/COLUMNS.
const env = { ...process.env };
if (process.stdout.isTTY) {
  env.COLUMNS ??= String(process.stdout.columns || 80);
  env.LINES ??= String(process.stdout.rows || 24);
}
// Not sandboxed: "../x" works from any directory (wasi-libc picks the cwd preopen for it); the
// user's file permissions are the boundary, as for any process.
const wasi = new WASI({ version: 'preview1', args: [argv0, ...args], env, preopens, sandbox: false });
if (WebAssembly.Module.imports(mod).some((i) => i.module === 'wasi' && i.name === 'thread-spawn')) {
  process.exitCode = await wasi.startThreads(mod, bytes);
} else {
  const instance = await WebAssembly.instantiate(mod, wasi.getImportObject());
  process.exitCode = wasi.start(instance);
}
`;

/** Toolchain commands served by YoWASP Clang/LLD (other/node/clang.js). */
let TOOLCHAIN = new Set(['clang', 'clang++', 'cc', 'c++', 'gcc', 'g++', 'wasm-ld', 'ld.lld', 'ld', 'ar', 'llvm-ar', 'ranlib', 'llvm-ranlib', 'nm', 'llvm-nm', 'objdump', 'llvm-objdump', 'objcopy', 'llvm-objcopy', 'strip', 'llvm-strip', 'size', 'llvm-size', 'addr2line', 'llvm-addr2line', 'llvm-symbolizer', 'c++filt', 'llvm-cxxfilt', 'llvm-dwarfdump', 'llvm-readobj']);

/** break / continue / return unwind loops and functions. */
class LoopControl extends Error {
  constructor(kind, n = 1) {
    super(kind);
    this.kind = kind; // 'break' | 'continue'
    this.n = n;
  }
}
class FuncReturn extends Error {
  constructor(code) {
    super('return');
    this.code = code;
  }
}

/** Thrown by `exit` to unwind the running script. */
class ShellExit extends Error {
  constructor(code) {
    super('exit ' + code);
    this.exitCode = code;
  }
}

export function createShell(fs, { wfCursor = 'master', wfOptions, home = SHELL_HOME, pid, ppid, interactive = false, argv0 = null } = {}) {
  let cwd = '';
  let HOME = String(home || '').replace(/^\/+|\/+$/g, '') || SHELL_HOME;
  let lastStatus = 0;
  let shellPid = pid ?? allocPid();
  let parentPid = ppid ?? 1;
  // A job's subshell hands its own pid to the first process it starts, so `cmd & echo $!` matches process.pid.
  let reservedPid = pid != null ? pid : null;
  let takePid = () => {
    let p = reservedPid ?? allocPid();
    reservedPid = null;
    return p;
  };
  let jobs = new Map();
  let jobSeq = 0;
  let lastBgPid = '';
  let bgSink = null;
  let notices = [];
  let positional = [];
  let tempExported = new Set(); // prefix assignments exported for one command
  let functions = new Map(); // name → body node
  let loopDepth = 0;
  let localScopes = []; // per function call: Map name → previous value (undefined = unset)
  let lastArg = '';
  let startedAt = Date.now();
  let currentScript = '';
  let exported = new Set([
    'HOME',
    'USER',
    'UID',
    'EUID',
    'GID',
    'SHELL',
    'PATH',
    'PWD',
    'HOSTNAME',
    'PS1',
    'MOTD',
    'TERM',
    'COLORTERM',
  ]);
  let env = {
    HOME: '/' + HOME,
    USER: PLAYER,
    UID: String(PLAYER_UID),
    EUID: String(PLAYER_UID),
    GID: String(PLAYER_UID),
    SHELL: '/bin/boxsh',
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    PWD: '/',
    HOSTNAME: netHostname(),
    // Green user@host (#50fa7b), cyan path (#8be9fd)
    PS1: '\\[\\e[38;2;80;250;123m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[38;2;139;233;253m\\]\\w\\[\\e[0m\\]$ ',
    MOTD: '',
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  // Live output for long-running commands (node): set by the Terminal while a
  // line runs; only used when the command's stdout reaches the terminal
  // (last pipeline stage, no stdout redirect).
  let liveSink = null;
  let groupStdin = null;
  let runAbort = null;
  let stageCtx = { tail: true, redirected: false };
  let optErrexit = false;
  let optNounset = false;
  let optNoclobber = false;
  let optXtrace = false;
  let optPipefail = false;
  let optNoglob = false;

  // Defaults to the logged-in player (uid 1000); loadRc refreshes from VFS users db.
  let actor = {
    name: PLAYER,
    uid: PLAYER_UID,
    gid: PLAYER_UID,
    gids: [PLAYER_UID],
    home: HOME,
    shell: '/bin/boxsh',
  };
  let umaskVal = 0o022;

  function syncActorEnv() {
    env.USER = actor.name;
    env.UID = String(actor.uid);
    env.EUID = String(actor.uid);
    env.GID = String(actor.gid);
    HOME = String(actor.home || '').replace(/^\/+|\/+$/g, '') || SHELL_HOME;
    actor.home = HOME;
    env.HOME = HOME ? '/' + HOME : '/';
    env.SHELL = actor.shell || '/bin/boxsh';
  }

  function syncPwd() {
    env.PWD = cwd ? '/' + cwd : '/';
    env.HOME = HOME ? '/' + HOME : '/';
  }

  function parentOf(path) {
    let p = String(path || '');
    if (!p) return '';
    let i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
  }

  async function vfsGetStat(path) {
    if (typeof fs.getStat === 'function') return fs.getStat(path);
    return getStat(path);
  }

  async function vfsSetStat(path, patch) {
    if (typeof fs.setStat === 'function') return fs.setStat(path, patch);
    return setStat(path, patch);
  }

  async function vfsEnsureStat(path, kind, owner) {
    if (typeof fs.ensureStat === 'function') return fs.ensureStat(path, kind, owner);
    return ensureStat(path, kind, owner);
  }

  async function vfsSize(path) {
    if (typeof fs.sizeOf === 'function') return fs.sizeOf(path);
    return vfsSizeOf(path);
  }

  function fileMode() {
    return (DEFAULT_FILE_MODE & ~umaskVal) & 0o777;
  }

  function dirMode() {
    return (DEFAULT_DIR_MODE & ~umaskVal) & 0o777;
  }

  function requireRootCmd(cmd) {
    if (!isRoot(actor.uid)) throw shellError(`${cmd}: Permission denied`, 1);
  }

  /** Check execute (traverse) on each directory from root through dirPath. */
  async function requireTraverse(dirPath) {
    if (isRoot(actor.uid)) return;
    let parts = String(dirPath || '').split('/').filter(Boolean);
    let acc = [];
    for (let part of parts) {
      acc.push(part);
      await assertAccess(acc.join('/'), 'x', actor);
    }
  }

  async function requireRead(path) {
    if (isRoot(actor.uid)) return;
    await requireTraverse(parentOf(path));
    await assertAccess(path, 'r', actor);
  }

  async function requireExec(path) {
    if (isRoot(actor.uid)) return;
    await requireTraverse(parentOf(path));
    await assertAccess(path, 'x', actor);
  }

  async function requireWrite(path) {
    if (isRoot(actor.uid)) return;
    await requireTraverse(parentOf(path));
    await assertAccess(path, 'w', actor);
  }

  /** Create or overwrite: w on file if it exists, else w(+x) on parent. */
  async function requireWriteCreate(path) {
    if (isRoot(actor.uid)) return;
    let parent = parentOf(path);
    await requireTraverse(parent);
    let st = await vfsGetStat(path);
    let exists = !!st;
    if (!exists && typeof fs.list === 'function') {
      // fall through — existence also checked by callers via index when needed
    }
    if (st) {
      await assertAccess(path, 'w', actor);
      return;
    }
    if (parent) {
      await assertAccess(parent, 'w', actor);
      await assertAccess(parent, 'x', actor);
    }
  }

  /** Unlink / rmdir: write on parent directory. */
  async function requireUnlink(path) {
    if (isRoot(actor.uid)) return;
    let parent = parentOf(path);
    await requireTraverse(parent);
    if (parent) await assertAccess(parent, 'w', actor);
  }

  async function requireList(dirPath) {
    if (isRoot(actor.uid)) return;
    await requireTraverse(parentOf(dirPath));
    if (dirPath) await assertAccess(dirPath, 'r', actor);
  }

  async function requireOwnerOrRoot(path, cmd) {
    if (isRoot(actor.uid)) return;
    let st = await vfsGetStat(path);
    if (!st) throw shellError(`${cmd}: cannot access '${path}': No such file or directory`, 1);
    if (Number(st.uid) !== Number(actor.uid)) {
      throw shellError(`${cmd}: changing permissions of '${path}': Operation not permitted`, 1);
    }
  }

  async function pathExists(index, path) {
    if (!path) return true;
    if (await isDir(index, path)) return true;
    if (await existsFile(index, path)) return true;
    return false;
  }

  function setVar(name, value, markExport) {
    let key = String(name || '');
    if (!key) return;
    let str = value == null ? '' : String(value);
    if (key === 'HOME') {
      HOME = str.replace(/^\/+|\/+$/g, '') || SHELL_HOME;
      env.HOME = HOME ? '/' + HOME : '/';
    } else {
      env[key] = str;
    }
    if (markExport) exported.add(key);
    if (key === 'PWD') {
      // Allow PWD tweaks but keep cwd as source of truth on next sync.
    }
  }

  async function run(script) {
    let text = String(script || '');
    let ast = parseBash(text);
    if (ast.errors?.length) {
      lastStatus = 2;
      return { code: 2, stdout: '', stderr: ast.errors.map(err => 'syntax error: ' + err.message).join('\n') + '\n' };
    }
    let index = makeIndex(fs);
    let prevScript = currentScript;
    currentScript = text;
    // On a terminal, `a; b` shows a's output before b runs (b may stream live, like pkg or node).
    let streaming = liveSink && ast.commands?.length > 1;
    let flush = (r) => {
      if (r?.stdout) liveSink.out(r.stdout);
      if (r?.stderr) liveSink.err(r.stderr);
    };
    try {
      if (!streaming) return await evalStatements(index, ast.commands);
      let code = 0;
      for (let statement of ast.commands) {
        let one = await evalStatements(index, [statement]);
        flush(one);
        code = one.code;
        if (optErrexit && code) break;
      }
      return { code, stdout: '', stderr: '' };
    } catch (err) {
      if (err instanceof ShellExit) {
        lastStatus = err.exitCode;
        if (streaming) {
          flush(err);
          return { code: err.exitCode, stdout: '', stderr: '', exit: true };
        }
        return { code: err.exitCode, stdout: err.stdout || '', stderr: err.stderr || '', exit: true };
      }
      throw err;
    } finally {
      currentScript = prevScript;
    }
  }

  async function loadRc() {
    // Pick up migrated uid/gid/groups from the VFS user db.
    let named = await actorFromUser(actor.name);
    if (named) {
      actor = named;
      syncActorEnv();
    }
    syncPwd();
    let index = makeIndex(fs);
    let path = HOME + '/.boxshrc';
    let text = await readFile(index, path);
    if (text == null) return { code: 0, stdout: '', stderr: '' };
    return run(String(text));
  }

  async function evalStatements(index, statements) {
    let stdout = '';
    let stderr = '';
    let code = 0;
    for (let statement of statements || []) {
      let one;
      try {
        one = statement.background ? startJob(statement) : await evalStatement(index, statement);
      } catch (err) {
        if (err instanceof ShellExit || err instanceof LoopControl || err instanceof FuncReturn) {
          err.stdout = stdout + (err.stdout || '');
          err.stderr = stderr + (err.stderr || '');
        }
        throw err;
      }
      stdout += one.stdout;
      stderr += one.stderr;
      code = one.code;
      lastStatus = code;
      syncPwd();
      if (optErrexit && code) break;
    }
    return { code, stdout, stderr };
  }

  /** `cmd &`: run the statement in a subshell (bash semantics) without waiting. */
  function startJob(statement) {
    let text = currentScript.slice(statement.pos, statement.end).replace(/&\s*$/, '').trim();
    let jobPid = allocPid();
    let id = ++jobSeq;
    let job = { id, pid: jobPid, text, state: 'Running', code: null, output: '', sub: null, promise: null };
    jobs.set(id, job);
    lastBgPid = String(jobPid);
    let emit = (chunk) => {
      if (!chunk) return;
      if (bgSink) bgSink(chunk);
      else job.output += chunk;
    };
    job.promise = (async () => {
      let sub = createShell(fs, { wfCursor, wfOptions, home: HOME, pid: jobPid, ppid: shellPid });
      job.sub = sub;
      await sub.become(actor.name);
      for (let [k, v] of Object.entries(exportedEnv())) sub.setVar(k, v, true);
      await sub.run('cd ' + shellQuote(cwd ? '/' + cwd : '/'));
      let r = await sub.withLive({ out: emit, err: emit }, () => sub.run(text));
      emit((r.stdout || '') + (r.stderr || ''));
      return r.code;
    })()
      .catch((err) => {
        emit(String(err?.message || err) + '\n');
        return 1;
      })
      .then((code) => {
        job.code = code;
        if (job.state === 'Running') job.state = code ? `Exit ${code}` : 'Done';
        notices.push(job);
        return code;
      });
    return { code: 0, stdout: '', stderr: interactive ? `[${id}] ${jobPid}\n` : '' };
  }

  function jobLine(job, mark = ' ') {
    return `[${job.id}]${mark}  ${job.state.padEnd(24)}${job.text}${job.state === 'Running' ? ' &' : ''}`;
  }

  function findJob(ref) {
    let r = String(ref ?? '');
    if (r === '' || r === '%%' || r === '%+' || r === '%') return [...jobs.values()].pop() || null;
    if (r.startsWith('%')) return jobs.get(Number(r.slice(1))) || null;
    return [...jobs.values()].find((j) => String(j.pid) === r) || null;
  }

  async function cmdJobs(args) {
    let pidsOnly = args.includes('-p');
    let list = [...jobs.values()];
    let out = list.map((j, i) => (pidsOnly ? String(j.pid) : jobLine(j, i === list.length - 1 ? '+' : i === list.length - 2 ? '-' : ' '))).join('\n');
    for (let j of list) if (j.state !== 'Running') jobs.delete(j.id);
    notices = notices.filter((j) => j.state === 'Running');
    return ok(out ? out + '\n' : '');
  }

  async function cmdWait(args) {
    let refs = args.filter((a) => a !== '-n');
    if (!refs.length) {
      for (let j of [...jobs.values()]) await j.promise;
      let out = '';
      for (let j of [...jobs.values()]) {
        out += j.output;
        j.output = '';
        jobs.delete(j.id);
      }
      notices = [];
      return { code: 0, stdout: out, stderr: '' };
    }
    let code = 0;
    let out = '';
    let err = '';
    for (let ref of refs) {
      let job = findJob(ref);
      if (!job) {
        err += `wait: pid ${ref} is not a child of this shell\n`;
        code = 127;
        continue;
      }
      code = await job.promise;
      out += job.output;
      job.output = '';
      jobs.delete(job.id);
      notices = notices.filter((j) => j !== job);
    }
    return { code, stdout: out, stderr: err };
  }

  async function cmdFg(args) {
    let job = findJob(args[0]);
    if (!job) throw shellError(`fg: ${args[0] || 'current'}: no such job`, 1);
    let head = job.text + '\n';
    let code = await job.promise;
    let out = job.output;
    jobs.delete(job.id);
    notices = notices.filter((j) => j !== job);
    return { code, stdout: head + out, stderr: '' };
  }

  function cmdKill(args) {
    let sig = 'TERM';
    let targets = [];
    for (let i = 0; i < args.length; i++) {
      let a = String(args[i]);
      if (a === '-l' || a === '-L') return ok(Object.entries(SIGNALS).map(([n, v]) => `${String(v).padStart(2)}) SIG${n}`).join('\n') + '\n');
      if (a === '-s' || a === '-n') {
        sig = String(args[++i] || '').replace(/^SIG/, '');
        continue;
      }
      if (/^-\w+$/.test(a)) {
        let v = a.slice(1).replace(/^SIG/, '');
        sig = /^\d+$/.test(v) ? Object.keys(SIGNALS).find((k) => SIGNALS[k] === Number(v)) || v : v;
        continue;
      }
      targets.push(a);
    }
    if (!(sig in SIGNALS)) throw shellError(`kill: ${sig}: invalid signal specification`, 1);
    if (!targets.length) throw shellError('kill: usage: kill [-s sigspec | -signum | -sigspec] pid | jobspec ... or kill -l', 2);
    let err = '';
    let code = 0;
    for (let t of targets) {
      let job = findJob(t);
      if (!job) {
        err += `kill: (${t}) - No such process\n`;
        code = 1;
        continue;
      }
      if (job.state !== 'Running') continue;
      if (sig === 'KILL' || sig === 'TERM' || sig === 'INT' || sig === 'HUP') job.state = sig === 'KILL' ? 'Killed' : sig === 'INT' ? 'Interrupt' : sig === 'HUP' ? 'Hangup' : 'Terminated';
      job.sub?.interrupt('SIG' + sig);
    }
    return { code, stdout: '', stderr: err };
  }

  async function evalStatement(index, statement) {
    let node = statement.command;
    if (node.type === 'AndOr') return evalAndOr(index, node);
    return evalPipelineNode(index, node, null);
  }

  async function evalAndOr(index, node) {
    let stdout = '';
    let stderr = '';
    let code = 0;
    for (let i = 0; i < node.commands.length; i++) {
      if (i > 0) {
        let op = node.operators[i - 1];
        if (op === '&&' && code) break;
        if (op === '||' && !code) break;
      }
      let one = await evalPipelineNode(index, node.commands[i], null);
      stdout += one.stdout;
      stderr += one.stderr;
      code = one.code;
    }
    return { code, stdout, stderr };
  }

  async function evalPipelineNode(index, node, stdin) {
    if (!node) return { code: 0, stdout: '', stderr: '' };
    // Inside `{ …; } < input` / `( … ) < input`, commands read the group's stdin.
    // (Each command sees all of it: there is no shared read offset yet.)
    if (stdin == null) stdin = groupStdin;
    if (node.type === 'Pipeline') return evalPipeline(index, node, stdin);
    if (node.type === 'Negation') {
      let inner = await evalPipelineNode(index, node.command, stdin);
      inner.code = inner.code ? 0 : 1;
      return inner;
    }
    if (node.type === 'Command') return evalSimple(index, node, stdin);
    if (node.type === 'Redirected') {
      try {
        return await routeCommand(index, node.redirects, stdin, (input) => evalPipelineNode(index, node.command, input ?? null));
      } catch (err) {
        if (err instanceof ShellExit || err instanceof LoopControl || err instanceof FuncReturn) throw err;
        let message = (err && err.message) || String(err);
        if (!message.endsWith('\n')) message += '\n';
        return { code: err && err.code || 1, stdout: '', stderr: message };
      }
    }
    if (node.type === 'Subshell' || node.type === 'BraceGroup') {
      let prev = groupStdin;
      groupStdin = stdin;
      try {
        return await evalStatements(index, node.body.commands);
      } finally {
        groupStdin = prev;
      }
    }
    if (node.type === 'If') return evalIf(index, node, stdin);
    if (node.type === 'For') return evalFor(index, node, stdin);
    if (node.type === 'ArithmeticFor') return evalArithFor(index, node, stdin);
    if (node.type === 'While') return evalWhile(index, node, stdin);
    if (node.type === 'Case') return evalCase(index, node, stdin);
    if (node.type === 'Function') {
      functions.set(expandWord(node.name), node.body);
      return ok('');
    }
    if (node.type === 'TestCommand') return evalTestCommand(node);
    return { code: 1, stdout: '', stderr: `unsupported shell syntax: ${node.type}\n` };
  }

  /* ---------- compound commands ---------- */

  /** Run a CompoundList with `stdin` as the group input (like `{ …; } < f`). */
  async function evalList(index, list, stdin) {
    let prev = groupStdin;
    if (stdin != null) groupStdin = stdin;
    try {
      return await evalStatements(index, list?.commands || []);
    } finally {
      groupStdin = prev;
    }
  }

  let joinRes = (acc, r) => {
    acc.stdout += r.stdout || '';
    acc.stderr += r.stderr || '';
    acc.code = r.code;
    return acc;
  };

  async function evalIf(index, node, stdin) {
    let acc = { code: 0, stdout: '', stderr: '' };
    let cond = await evalList(index, node.clause, stdin);
    joinRes(acc, cond);
    if (!cond.code) return joinRes(acc, await evalList(index, node.then, stdin));
    if (node.else) {
      let r = node.else.type === 'If' ? await evalIf(index, node.else, stdin) : await evalList(index, node.else, stdin);
      return joinRes(acc, r);
    }
    acc.code = 0;
    return acc;
  }

  /** Run a loop body, translating break/continue. Returns 'break' | 'continue' | null. */
  async function loopBody(index, body, stdin, acc) {
    loopDepth++;
    try {
      joinRes(acc, await evalList(index, body, stdin));
      return null;
    } catch (err) {
      if (!(err instanceof LoopControl)) throw err;
      acc.stdout += err.stdout || '';
      acc.stderr += err.stderr || '';
      err.stdout = err.stderr = '';
      if (err.n > 1) {
        err.n--;
        throw err;
      }
      return err.kind;
    } finally {
      loopDepth--;
    }
  }

  /** Expand a word list like bash: unquoted expansions split on whitespace, globs match files. */
  async function expandWordList(index, words) {
    let out = [];
    for (let w of words || []) {
      let value = expandWord(w);
      let parts = w.parts || [];
      let unquotedExpansion = parts.some((p) => ['SimpleExpansion', 'ParameterExpansion', 'CommandExpansion', 'ArithmeticExpansion'].includes(p.type));
      let fields = unquotedExpansion ? value.split(/[ \t\n]+/).filter(Boolean) : [value];
      let quoted = parts.some((p) => p.type === 'DoubleQuoted' || p.type === 'SingleQuoted');
      for (let f of fields) {
        if (!quoted && !optNoglob && hasGlob(f)) {
          let abs = f.startsWith('/');
          let hits = (await expand(index, cwd, f, HOME)).filter((m) => m !== resolvePath(cwd, f, HOME));
          if (hits.length) {
            for (let h of hits) out.push(abs ? '/' + h : cwd && h.startsWith(cwd + '/') ? h.slice(cwd.length + 1) : h);
            continue;
          }
        }
        out.push(f);
      }
    }
    return out;
  }

  async function evalFor(index, node, stdin) {
    let acc = { code: 0, stdout: '', stderr: '' };
    let name = expandWord(node.name);
    let items = node.wordlist ? await expandWordList(index, node.wordlist) : [...positional];
    for (let item of items) {
      setVar(name, item, false);
      if ((await loopBody(index, node.body, stdin, acc)) === 'break') break;
    }
    return acc;
  }

  async function evalWhile(index, node, stdin) {
    let acc = { code: 0, stdout: '', stderr: '' };
    // `while read x; do …; done < file`: one cursor shared by every `read` in the loop.
    let input = stdin instanceof Uint8Array ? { cursor: true, text: new TextDecoder().decode(stdin), pos: 0 } : stdin != null && typeof stdin !== 'object' ? { cursor: true, text: String(stdin), pos: 0 } : stdin;
    let ran = false;
    for (let guard = 0; guard < 1e6; guard++) {
      let cond = await evalList(index, node.clause, input);
      acc.stdout += cond.stdout || '';
      acc.stderr += cond.stderr || '';
      let truthy = node.kind === 'until' ? !!cond.code : !cond.code;
      if (!truthy) break;
      ran = true;
      if ((await loopBody(index, node.body, input, acc)) === 'break') break;
      if (guard % 64 === 63) await new Promise((r) => setTimeout(r, 0));
    }
    if (!ran) acc.code = 0;
    return acc;
  }

  async function evalArithFor(index, node, stdin) {
    let acc = { code: 0, stdout: '', stderr: '' };
    let arith = (n) => (n ? evalArith(n) : 1);
    if (node.initialize) arith(node.initialize);
    for (let guard = 0; guard < 1e6 && (!node.test || arith(node.test)); guard++) {
      if ((await loopBody(index, node.body, stdin, acc)) === 'break') break;
      if (node.update) arith(node.update);
      if (guard % 64 === 63) await new Promise((r) => setTimeout(r, 0));
    }
    return acc;
  }

  /** Arithmetic AST (for ((…)) clauses). */
  function evalArith(n) {
    let num = (v) => Number(v) || 0;
    let varOf = (w) => (w.type === 'ArithmeticWord' && /^[A-Za-z_]\w*$/.test(w.value) ? w.value : null);
    switch (n.type) {
      case 'ArithmeticWord':
        return /^-?\d+$/.test(n.value) ? Number(n.value) : num(env[n.value]);
      case 'ArithmeticGroup':
      case 'ArithmeticParen':
        return evalArith(n.expression || n.body);
      case 'ArithmeticUnary': {
        let v = varOf(n.operand);
        let cur = evalArith(n.operand);
        if (n.operator === '++' || n.operator === '--') {
          let next = n.operator === '++' ? cur + 1 : cur - 1;
          if (v) setVar(v, String(next), false);
          return n.prefix === false ? cur : next;
        }
        if (n.operator === '-') return -cur;
        if (n.operator === '!') return cur ? 0 : 1;
        if (n.operator === '~') return ~cur;
        return cur;
      }
      case 'ArithmeticBinary': {
        let op = n.operator;
        if (/^([+\-*/%]|<<|>>|&|\||\^)?=$/.test(op) && op !== '==') {
          let v = varOf(n.left);
          let r = evalArith(n.right);
          let l = op === '=' ? 0 : evalArith(n.left);
          let val = op === '=' ? r : binop(op.slice(0, -1), l, r);
          if (v) setVar(v, String(val), false);
          return val;
        }
        if (op === '&&') return evalArith(n.left) && evalArith(n.right) ? 1 : 0;
        if (op === '||') return evalArith(n.left) || evalArith(n.right) ? 1 : 0;
        return binop(op, evalArith(n.left), evalArith(n.right));
      }
      case 'ArithmeticTernary':
        return evalArith(n.test) ? evalArith(n.consequent) : evalArith(n.alternate);
    }
    return 0;
  }
  function binop(op, l, r) {
    switch (op) {
      case '+': return l + r;
      case '-': return l - r;
      case '*': return l * r;
      case '/': return r ? Math.trunc(l / r) : 0;
      case '%': return r ? l % r : 0;
      case '**': return l ** r;
      case '<': return l < r ? 1 : 0;
      case '>': return l > r ? 1 : 0;
      case '<=': return l <= r ? 1 : 0;
      case '>=': return l >= r ? 1 : 0;
      case '==': return l === r ? 1 : 0;
      case '!=': return l !== r ? 1 : 0;
      case '<<': return l << r;
      case '>>': return l >> r;
      case '&': return l & r;
      case '|': return l | r;
      case '^': return l ^ r;
    }
    return 0;
  }

  async function evalCase(index, node, stdin) {
    let word = expandWord(node.word);
    let acc = { code: 0, stdout: '', stderr: '' };
    let items = node.items || [];
    for (let i = 0; i < items.length; i++) {
      let item = items[i];
      let hit = (item.pattern || []).some((p) => {
        let pat = expandWord(p);
        let quoted = (p.parts || []).some((x) => x.type === 'DoubleQuoted' || x.type === 'SingleQuoted');
        return quoted ? pat === word : minimatch(word, pat, { dot: true, nocomment: true, noext: false });
      });
      if (!hit) continue;
      // ;; stops, ;& falls through into the next body, ;;& keeps testing.
      for (let j = i; j < items.length; j++) {
        joinRes(acc, await evalList(index, items[j].body, stdin));
        if (items[j].terminator !== ';&') break;
      }
      if (item.terminator === ';;&') continue;
      return acc;
    }
    return acc;
  }

  /** [[ … ]] */
  function evalTestCommand(node) {
    let w = (x) => (x?.type === 'Word' ? expandWord(x) : '');
    let t = (e) => {
      if (!e) return false;
      switch (e.type) {
        case 'TestBinary': {
          let l = w(e.left);
          let r = w(e.right);
          switch (e.operator) {
            case '==':
            case '=':
              return minimatch(l, r, { dot: true });
            case '!=':
              return !minimatch(l, r, { dot: true });
            case '=~':
              try {
                return new RegExp(r).test(l);
              } catch {
                return false;
              }
            case '<': return l < r;
            case '>': return l > r;
            case '-eq': return Number(l) === Number(r);
            case '-ne': return Number(l) !== Number(r);
            case '-lt': return Number(l) < Number(r);
            case '-le': return Number(l) <= Number(r);
            case '-gt': return Number(l) > Number(r);
            case '-ge': return Number(l) >= Number(r);
            case '&&': return t(e.left) && t(e.right);
            case '||': return t(e.left) || t(e.right);
          }
          return false;
        }
        case 'TestUnary': {
          let v = w(e.operand);
          if (e.operator === '-z') return v === '';
          if (e.operator === '-n') return v !== '';
          if (e.operator === '!') return !t(e.operand);
          return false;
        }
        case 'TestLogical':
          return e.operator === '&&' ? t(e.left) && t(e.right) : t(e.left) || t(e.right);
        case 'TestNot':
          return !t(e.expression || e.operand);
        case 'TestGroup':
          return t(e.expression);
        case 'Word':
          return w(e) !== '';
      }
      return false;
    };
    return { code: t(node.expression) ? 0 : 1, stdout: '', stderr: '' };
  }

  /** Call a shell function: $1… are its arguments; `return` ends it. */
  async function callFunction(index, name, args, stdin) {
    let body = functions.get(name);
    let savedPos = positional;
    positional = args.map((a) => String(a ?? ''));
    localScopes.push(new Map());
    try {
      let r = await evalPipelineNode(index, body, stdin);
      return r;
    } catch (err) {
      if (err instanceof FuncReturn) return { code: err.code ?? lastStatus, stdout: err.stdout || '', stderr: err.stderr || '' };
      throw err;
    } finally {
      positional = savedPos;
      for (let [k, v] of localScopes.pop()) {
        if (v === undefined) delete env[k];
        else env[k] = v;
      }
    }
  }

  async function evalPipeline(index, node, stdin) {
    let input = stdin;
    let stderr = '';
    let code = 0;
    let lastNonzero = 0;
    let stdout = '';
    for (let i = 0; i < node.commands.length; i++) {
      let outer = stageCtx;
      stageCtx = { tail: outer.tail && i === node.commands.length - 1, redirected: outer.redirected };
      let result;
      try {
        result = await evalPipelineNode(index, node.commands[i], input);
      } finally {
        stageCtx = outer;
      }
      code = result.code;
      if (code) lastNonzero = code;
      let last = i === node.commands.length - 1;
      if (last) {
        stdout = result.stdout;
        stderr += result.stderr;
        break;
      }
      if (node.operators[i] === '|&') input = result.stdout + result.stderr;
      else {
        // Programs' exact bytes flow on to the next program (gzip | zcat); builtins see text.
        input = result.stdoutBytes ?? result.stdout;
        stderr += result.stderr;
      }
    }
    if (optPipefail && lastNonzero) code = lastNonzero;
    return { code, stdout, stderr };
  }

  async function evalSimple(index, command, stdin) {
    try {
      return await routeCommand(index, command.redirects || [], stdin, async input => {
        let prefix = command.prefix || [];
        // Expand assignment values in the current environment first.
        let assignments = [];
        for (let item of prefix) {
          if (item?.type !== 'Assignment') continue;
          assignments.push({
            name: item.name,
            value: expandWord(item.value || item),
          });
        }

        // Pure assignment statement: NAME=value [NAME2=...]
        if (!command.name) {
          for (let a of assignments) setVar(a.name, a.value, false);
          syncPwd();
          return ok('');
        }

        // Expand command words before applying temporary prefix assignments
        // (bash expands argv before temp env takes effect).
        let name = expandWord(command.name);
        let args = [];
        let rawArgs = command.args || command.suffix || [];
        for (let arg of rawArgs) {
          if (!arg || arg.type === 'HereDoc' || arg.type === 'HereString') continue;
          if (arg.type === 'Assignment') {
            args.push(arg); // export/readonly keep Assignment nodes
            continue;
          }
          if (arg.type === 'Word') args.push(expandWord(arg));
        }

        let saved = null;
        if (assignments.length) {
          saved = Object.create(null);
          for (let a of assignments) {
            saved[a.name] = Object.prototype.hasOwnProperty.call(env, a.name)
              ? env[a.name]
              : undefined;
            // `VAR=x cmd`: VAR is in cmd's environment (exported for the command only).
            if (!exported.has(a.name)) tempExported.add(a.name);
            exported.add(a.name);
            setVar(a.name, a.value, false);
          }
        }

        try {
          return await dispatch(index, name, args, input, command);
        } catch (err) {
          if (err instanceof ShellExit || err instanceof LoopControl || err instanceof FuncReturn) throw err;
          let message = (err && err.message) || String(err);
          if (!message.endsWith('\n')) message += '\n';
          return { code: err && err.code || 1, stdout: '', stderr: message };
        } finally {
          if (saved) {
            for (let key of Object.keys(saved)) {
              if (tempExported.delete(key)) exported.delete(key);
              if (saved[key] === undefined) delete env[key];
              else setVar(key, saved[key], false);
            }
            syncPwd();
          }
        }
      });
    } catch (err) {
      if (err instanceof ShellExit || err instanceof LoopControl || err instanceof FuncReturn) throw err;
      let message = (err && err.message) || String(err);
      if (!message.endsWith('\n')) message += '\n';
      return { code: err && err.code || 1, stdout: '', stderr: message };
    }
  }

  async function routeCommand(index, redirects, stdin, produce) {
    let input = stdin;
    let fd = { 1: { kind: 'pipe' }, 2: { kind: 'err' } };
    for (let redir of redirects) {
      if (redir.type === 'HereDoc' || redir.type === 'HereString') {
        input = heredocText(redir);
        continue;
      }
      let op = redir.operator;
      let targetRaw = redir.target ? expandWord(redir.target) : '';
      let target = redir.target ? resolvePath(cwd, targetRaw, HOME) : '';
      let src = redir.descriptor?.type === 'FileDescriptor' ? redir.descriptor.value : null;
      if (op === '<' ) {
        let bytes = target === 'dev/null' ? new Uint8Array(0) : await readFileBytes(index, target);
        if (bytes == null) throw shellError(`no such file or directory: ${target}`, 1);
        input = bytes;
        continue;
      }
      if (op === '>' || op === '>>' || op === '>|') {
        let n = src == null ? 1 : src;
        if (op === '>' && optNoclobber && (await existsFile(index, target))) {
          throw shellError(`${target}: cannot overwrite existing file`, 1);
        }
        if (op !== '>>') await writeFile(index, target, '');
        fd[n] = { kind: 'file', path: target, append: true };
        continue;
      }
      if (op === '&>' || op === '&>>') {
        if (op === '&>') await writeFile(index, target, '');
        let spec = { kind: 'file', path: target, append: true };
        fd[1] = spec;
        fd[2] = { ...spec };
        continue;
      }
      if (op === '>&' || op === '<&') {
        let word = redir.target?.value || '';
        if (/^\d+$/.test(word)) {
          let from = src == null ? 1 : src;
          fd[from] = { ...(fd[Number(word)] || { kind: 'pipe' }) };
        } else if (op === '>&') {
          await writeFile(index, target, '');
          let spec = { kind: 'file', path: target, append: true };
          fd[1] = spec;
          fd[2] = { ...spec };
        }
      }
    }
    let outer = stageCtx;
    // Long-running programs (daemons) stream into redirected files as they write,
    // instead of only when they exit: appends are serialized per redirection.
    let chain = Promise.resolve();
    let streamTo = (spec, fallback) =>
      spec.kind === 'file'
        ? (text) => {
            chain = chain.then(() => sink(index, spec, String(text), true)).catch(() => {});
          }
        : fallback;
    // Programs hand over raw bytes (outBytes/errBytes): files get them exactly (gzip > f.gz).
    let streamBytesTo = (spec) => (bytes) => {
      chain = chain.then(() => sinkBytes(index, { ...spec, append: true }, bytes)).catch(() => {});
    };
    let fileSink = null;
    if (fd[1].kind === 'file') {
      let out = streamTo(fd[1]);
      let outBytes = streamBytesTo(fd[1]);
      let errFile = fd[2].kind === 'file';
      fileSink = {
        // Streams into a file: not a terminal (isatty(1) is false, like `prog > f` anywhere).
        notTty: true,
        out,
        outBytes,
        err: fd[2].kind === 'pipe' ? out : streamTo(fd[2], (t) => (outer.liveErr ? outer.liveErr(t) : (fileSinkErr += t))),
        errBytes: fd[2].kind === 'pipe' ? outBytes : errFile ? streamBytesTo(fd[2]) : null,
      };
    }
    let fileSinkErr = '';
    if (fd[1].kind !== 'pipe' || fd[2].kind === 'file') stageCtx = { ...outer, redirected: true, fileSink };
    let result;
    try {
      result = await produce(input);
    } finally {
      stageCtx = outer;
      await chain;
    }
    if (fileSinkErr) result = { ...result, stderr: (result.stderr || '') + fileSinkErr };
    let stdout = result.stdout || '';
    let stderr = result.stderr || '';
    if (result.stdoutBytes && fd[1].kind === 'file') {
      await sinkBytes(index, fd[1], result.stdoutBytes);
      stdout = '';
    } else stdout = await sink(index, fd[1], stdout, true);
    if (fd[2].kind === 'pipe') stdout += stderr, stderr = '';
    else if (fd[2].kind === 'file') stderr = await sink(index, fd[2], stderr, true);
    // Raw bytes keep flowing down a pipe unless stderr was merged into stdout.
    let stdoutBytes = fd[1].kind === 'pipe' && fd[2].kind !== 'pipe' && !stderr ? result.stdoutBytes : undefined;
    return { code: result.code, stdout, stderr, ...(stdoutBytes ? { stdoutBytes } : {}) };
  }

  /** Bytes into a redirected file (binary-safe). */
  async function sinkBytes(index, target, bytes) {
    if (target.path === 'dev/null') return;
    let prev = target.append ? await readFileBytes(index, target.path) : null;
    let all = bytes;
    if (prev?.length) {
      all = new Uint8Array(prev.length + bytes.length);
      all.set(prev);
      all.set(bytes, prev.length);
    }
    await ensureParents(index, target.path);
    let existed = await existsFile(index, target.path);
    if (existed) await requireWrite(target.path);
    else await requireWriteCreate(target.path);
    let { withLock, writeBlob } = await import('./vfs.js');
    let meta = existed ? {} : { uid: actor.uid, gid: actor.gid, mode: fileMode() };
    await withLock(target.path, (lease) => writeBlob(target.path, new Blob([all]), { ...meta, lease }), { mode: 'w' });
    (await index.all()).add(target.path);
  }

  async function sink(index, target, text, keepEmpty) {
    if (!target || target.kind === 'pipe' || target.kind === 'err') return text;
    // Nothing to append (e.g. a program already streamed its bytes there): don't re-read and
    // rewrite the file as text, which would mangle binary content.
    if (target.append && !text) return keepEmpty ? '' : text;
    let prev = target.append ? ((await readFile(index, target.path)) || '') : '';
    await writeFile(index, target.path, prev + text);
    return keepEmpty ? '' : text;
  }

  /** Commands that, like coreutils, report each bad operand, keep going, and exit 1. */
  let PER_OPERAND = { cat: {}, rm: {}, touch: {}, mkdir: { valued: ['-m'] }, chmod: { spec: 1 }, chown: { spec: 1 }, chgrp: { spec: 1 } };

  async function dispatch(index, name, args, stdin, command) {
    let plain = args.filter((a) => typeof a === 'string');
    lastArg = plain.length ? plain[plain.length - 1] : String(name);
    let rule = PER_OPERAND[name];
    if (rule && plain.length === args.length) {
      let fixed = [];
      let operands = [];
      let specLeft = rule.spec || 0;
      let afterDD = false;
      for (let i = 0; i < args.length; i++) {
        let a = args[i];
        if (!afterDD && a === '--') {
          afterDD = true;
          fixed.push(a);
          continue;
        }
        if (!afterDD && a.startsWith('-') && a !== '-' && !(name === 'chmod' && /^-[rwxXst]+$/.test(a) && specLeft)) {
          fixed.push(a);
          if (rule.valued?.includes(a)) fixed.push(args[++i]);
          continue;
        }
        if (specLeft) {
          fixed.push(a);
          specLeft--;
          continue;
        }
        operands.push(a);
      }
      if (operands.length > 1) {
        let stdout = '';
        let stderr = '';
        let code = 0;
        for (let operand of operands) {
          let r;
          try {
            r = await dispatchOne(index, name, [...fixed, operand], stdin, command);
          } catch (err) {
            if (err instanceof ShellExit || err instanceof LoopControl || err instanceof FuncReturn) throw err;
            let message = (err && err.message) || String(err);
            r = { code: (err && err.code) || 1, stdout: '', stderr: message.endsWith('\n') ? message : message + '\n' };
          }
          stdout += r.stdout || '';
          stderr += r.stderr || '';
          if (r.code) code = r.code;
        }
        return { code, stdout, stderr };
      }
    }
    return dispatchOne(index, name, args, stdin, command);
  }

  async function dispatchOne(index, name, args, stdin, command) {
    let trace = '';
    if (optXtrace) {
      let argv = [name];
      for (let a of args) {
        if (a && a.type === 'Assignment') argv.push(a.name + '=' + expandWord(a.value || a));
        else argv.push(String(a ?? ''));
      }
      trace = '+ ' + argv.join(' ') + '\n';
    }
    let result;
    // A loop's input cursor: `read` consumes lines; any other command gets the rest.
    if (stdin && typeof stdin === 'object' && stdin.cursor && name !== 'read') stdin = stdin.text.slice(stdin.pos);
    // Raw bytes on stdin stay raw only for programs; builtins and functions read text.
    if (stdin instanceof Uint8Array && (BUILTINS.includes(name) || functions.has(name))) stdin = new TextDecoder().decode(stdin);
    try {
      if (functions.has(name)) result = await callFunction(index, name, args, stdin);
      else if (name === 'break' || name === 'continue') {
        if (!loopDepth) result = ok('');
        else throw new LoopControl(name, Math.max(1, Number(args[0]) || 1));
      } else if (name === 'return') {
        if (!localScopes.length && !currentScript) result = { code: 1, stdout: '', stderr: "return: can only `return' from a function or sourced script\n" };
        else throw new FuncReturn(args.length ? Number(args[0]) & 255 : lastStatus);
      } else if (name === 'local') {
        let scope = localScopes[localScopes.length - 1];
        for (let a of args) {
          let [k, ...rest] = (a && a.type === 'Assignment' ? `${a.name}=${expandWord(a.value || a)}` : String(a)).split('=');
          if (scope && !scope.has(k)) scope.set(k, Object.prototype.hasOwnProperty.call(env, k) ? env[k] : undefined);
          setVar(k, rest.length ? rest.join('=') : env[k] ?? '', false);
        }
        result = ok('');
      } else if (name === 'read') result = await cmdRead(args, stdin);
      else if (name === 'pwd') result = cmdPwd(args);
      else if (name === 'cd') result = await cmdCd(index, args);
      else if (name === 'ls') result = await cmdLs(index, args);
      else if (name === 'grep') result = await cmdGrep(index, args, stdin);
      else if (name === 'cat') result = await cmdCat(index, args, stdin);
      else if (name === 'mkdir') result = await cmdMkdir(index, args);
      else if (name === 'rm') result = await cmdRm(index, args);
      else if (name === 'mv') result = await cmdMv(index, args);
      else if (name === 'cp') result = await cmdCp(index, args);
      else if (name === 'ln') result = await cmdLn(index, args);
      else if (name === 'addcontact') result = await cmdAddcontact(args);
      else if (name === 'echo') result = cmdEcho(args);
      else if (name === 'printf') result = cmdPrintf(args);
      else if (name === 'head') result = await cmdHeadTail(index, args, true, stdin);
      else if (name === 'tail') result = await cmdHeadTail(index, args, false, stdin);
      else if (name === 'find') result = await cmdFind(index, args);
      else if (name === 'sed') result = await cmdSed(index, args, stdin);
      else if (name === 'wc') result = await cmdWc(index, args, stdin);
      else if (name === 'touch') result = await cmdTouch(index, args);
      else if (name === 'node' || name === 'nodejs') {
        try {
          result = (await requirePackage(name)) || (await cmdNode(args, stdin));
        } finally {
          index.invalidate?.();
        }
      }
      else if (name === 'wf') result = await cmdWf(args);
      else if (name === 'export') result = cmdExport(args);
      else if (name === 'unset') result = cmdUnset(args);
      else if (name === 'printenv') result = cmdPrintenv(args);
      else if (name === 'env') result = await cmdEnv(index, args, stdin, command);
      else if (name === 'set') result = cmdSet(args);
      else if (name === 'source' || name === '.') result = await cmdSource(index, args);
      else if (name === 'whoami') result = cmdWhoami(args);
      else if (name === 'id') result = await cmdId(args);
      else if (name === 'groups') result = await cmdGroups(args);
      else if (name === 'su') result = await cmdSu(args);
      else if (name === 'sudo') result = await cmdSudo(index, args, stdin, command);
      else if (name === 'useradd') result = await cmdUseradd(index, args);
      else if (name === 'userdel') result = await cmdUserdel(index, args);
      else if (name === 'groupadd') result = await cmdGroupadd(args);
      else if (name === 'groupdel') result = await cmdGroupdel(args);
      else if (name === 'usermod') result = await cmdUsermod(args);
      else if (name === 'chmod') result = await cmdChmod(index, args);
      else if (name === 'chown') result = await cmdChown(index, args);
      else if (name === 'chgrp') result = await cmdChgrp(index, args);
      else if (name === 'passwd') result = cmdPasswd(args);
      else if (name === 'umask') result = cmdUmask(args);
      else if (name === 'jobs') result = await cmdJobs(args);
      else if (name === 'wait') result = await cmdWait(args);
      else if (name === 'fg') result = await cmdFg(args);
      else if (name === 'bg') result = findJob(args[0]) ? ok('') : { code: 1, stdout: '', stderr: `bg: ${args[0] || 'current'}: no such job\n` };
      else if (name === 'kill') result = cmdKill(args);
      else if (name === 'sleep') result = await cmdSleep(args);
      else if (name === 'exit') {
        let n = args.length ? Number(args[0]) : lastStatus;
        if (!Number.isInteger(n)) throw new ShellExit(2);
        throw new ShellExit(((n % 256) + 256) % 256);
      }
      else if (name === 'test' || name === '[') result = await cmdTest(index, name, args);
      else if (name === 'shift') {
        let n = args.length ? Number(args[0]) : 1;
        if (!(n >= 0) || n > positional.length) result = { code: 1, stdout: '', stderr: '' };
        else {
          positional = positional.slice(n);
          result = ok('');
        }
      }
      else if (name === 'type' || name === 'which' || (name === 'command' && (args[0] === '-v' || args[0] === '-V'))) result = await cmdType(index, name, name === 'command' ? args.slice(1) : args);
      else if (name === 'command') result = args.length ? await dispatch(index, String(args[0]), args.slice(1), stdin, command) : ok('');
      else if (name === 'basename') result = cmdBasename(args);
      else if (name === 'dirname') result = cmdDirname(args);
      else if (name === 'date') result = cmdDate(args);
      else if (name === 'seq') result = cmdSeq(args);
      else if (name === 'bash' || name === 'sh' || name === 'boxsh') result = await cmdBash(index, name, args, stdin);
      else if (name === 'true' || name === ':') result = ok('');
      else if (name === 'false') result = { code: 1, stdout: '', stderr: '' };
      else if (name === 'npm' || name === 'npx') result = (await requirePackage(name)) || (await cmdNpm(name, args, stdin, index));
      else if (name === 'pkg') result = await cmdPkg(args);
      else if (NET_COMMANDS.includes(name)) result = await cmdNet(index, name, args, stdin);
      else if (name === 'git') result = (await requirePackage(name)) || (await cmdGit(args, index));
      else if (TOOLCHAIN.has(name)) result = (await requirePackage(name)) || (await cmdTool(name, args, stdin));
      else {
        let exe = await findExecutable(index, String(name));
        // A base-system command (busybox) while it's still being installed at boot: wait for it.
        if (!exe && (await awaitBaked(String(name)))) exe = await findExecutable(index, String(name));
        if (!exe) {
          void command;
          // Known but not installed: say how to get it (like Ubuntu's command-not-found).
          let missing = !String(name).includes('/') && (await requirePackage(String(name)));
          if (missing) return missing;
          throw shellError(`command not found: ${name}`, 127);
        }
        result = await runExecutable(index, exe, args, stdin);
      }
    } catch (err) {
      if (trace) {
        let message = (err && err.message) || String(err);
        if (!message.endsWith('\n')) message += '\n';
        return { code: err && err.code || 1, stdout: '', stderr: trace + message };
      }
      throw err;
    }
    if (trace) result = { ...result, stderr: trace + (result.stderr || '') };
    return result;
  }

  function exportListing() {
    let lines = [...exported]
      .filter(k => Object.prototype.hasOwnProperty.call(env, k))
      .sort()
      .map(k => `export ${k}=${shellQuote(env[k])}`);
    return ok(lines.length ? lines.join('\n') + '\n' : '');
  }

  function cmdExport(args) {
    if (!args.length) return exportListing();
    let i = 0;
    while (i < args.length) {
      let arg = args[i];
      if (arg === '-p') {
        if (args.length === 1) return exportListing();
        i += 1;
        continue;
      }
      if (arg === '-n') {
        let name = args[++i];
        if (name == null || name === '') throw shellError('export: -n requires a name', 1);
        exported.delete(String(name));
        i += 1;
        continue;
      }
      if (typeof arg === 'string' && arg.startsWith('-') && arg !== '-') {
        throw shellError(`export: invalid option: ${arg}`, 1);
      }
      if (arg && arg.type === 'Assignment') {
        setVar(arg.name, expandWord(arg.value || arg), true);
        i += 1;
        continue;
      }
      let text = String(arg ?? '');
      let eq = text.indexOf('=');
      if (eq === -1) {
        if (text) {
          if (!Object.prototype.hasOwnProperty.call(env, text)) env[text] = '';
          exported.add(text);
        }
      } else {
        setVar(text.slice(0, eq), text.slice(eq + 1), true);
      }
      i += 1;
    }
    syncPwd();
    return ok('');
  }

  function cmdUnset(args) {
    for (let raw of args) {
      let key = String(raw ?? '');
      if (key === '-v') continue;
      if (!key || (key.startsWith('-') && key !== '-')) continue;
      delete env[key];
      exported.delete(key);
    }
    syncPwd();
    return ok('');
  }

  function dumpEnv(sep) {
    let lines = Object.keys(env).sort().map(k => `${k}=${env[k]}`);
    if (!lines.length) return ok('');
    return ok(lines.join(sep) + sep);
  }

  function cmdPrintenv(args) {
    if (!args.length) return dumpEnv('\n');
    let out = '';
    let code = 0;
    for (let raw of args) {
      let key = String(raw ?? '');
      if (!Object.prototype.hasOwnProperty.call(env, key)) {
        code = 1;
        continue;
      }
      out += env[key] + '\n';
    }
    return { code, stdout: out, stderr: '' };
  }

  async function cmdEnv(index, args, stdin, command) {
    let clear = false;
    let nul = false;
    let unsetNames = [];
    let assignments = [];
    let cmdArgs = [];
    for (let i = 0; i < args.length; i++) {
      let arg = String(args[i] ?? '');
      if (arg === '-i' || arg === '-') {
        clear = true;
        continue;
      }
      if (arg === '-0' || arg === '--null') {
        nul = true;
        continue;
      }
      if (arg === '-u') {
        let name = args[++i];
        if (name == null) throw shellError('env: -u requires a name', 1);
        unsetNames.push(String(name));
        continue;
      }
      if (arg.startsWith('-u') && arg.length > 2) {
        unsetNames.push(arg.slice(2));
        continue;
      }
      if (arg === '--') {
        cmdArgs.push(...args.slice(i + 1).map(a => String(a ?? '')));
        break;
      }
      if (arg.startsWith('-') && arg !== '-') throw shellError(`env: invalid option: ${arg}`, 1);
      let eq = arg.indexOf('=');
      if (eq > 0 && cmdArgs.length === 0) {
        assignments.push({ name: arg.slice(0, eq), value: arg.slice(eq + 1) });
        continue;
      }
      cmdArgs.push(arg);
      cmdArgs.push(...args.slice(i + 1).map(a => String(a ?? '')));
      break;
    }
    if (!cmdArgs.length) {
      let saved = null;
      if (clear || unsetNames.length || assignments.length) {
        saved = { ...env };
        if (clear) for (let k of Object.keys(env)) delete env[k];
        for (let name of unsetNames) delete env[name];
        for (let a of assignments) env[a.name] = a.value;
      }
      try {
        return dumpEnv(nul ? '\0' : '\n');
      } finally {
        if (saved) {
          for (let k of Object.keys(env)) delete env[k];
          Object.assign(env, saved);
          syncPwd();
        }
      }
    }
    let saved = { ...env };
    let savedExported = new Set(exported);
    try {
      if (clear) {
        for (let k of Object.keys(env)) delete env[k];
      }
      for (let name of unsetNames) delete env[name];
      for (let a of assignments) setVar(a.name, a.value, true);
      return await dispatch(index, cmdArgs[0], cmdArgs.slice(1), stdin, command);
    } finally {
      for (let k of Object.keys(env)) delete env[k];
      Object.assign(env, saved);
      exported.clear();
      for (let k of savedExported) exported.add(k);
      syncPwd();
    }
  }

  function cmdSet(args) {
    let dd = args.findIndex((a) => String(a) === '--');
    if (dd !== -1) {
      positional = args.slice(dd + 1).map(String);
      args = args.slice(0, dd);
      if (!args.length) return ok('');
    }
    if (!args.length) {
      let lines = Object.keys(env)
        .sort()
        .map(k => `${k}=${shellQuote(env[k])}`);
      return ok(lines.join('\n') + (lines.length ? '\n' : ''));
    }
    for (let i = 0; i < args.length; i++) {
      let arg = String(args[i] ?? '');
      if (arg === '-o') {
        let name = String(args[++i] ?? '');
        if (name === 'pipefail') optPipefail = true;
        else if (name === 'errexit') optErrexit = true;
        else if (name === 'nounset') optNounset = true;
        else if (name === 'noclobber') optNoclobber = true;
        else if (name === 'xtrace') optXtrace = true;
        else if (name === 'noglob') optNoglob = true;
        else throw shellError(`set: invalid option name: ${name}`, 1);
        continue;
      }
      if (arg === '+o') {
        let name = String(args[++i] ?? '');
        if (name === 'pipefail') optPipefail = false;
        else if (name === 'errexit') optErrexit = false;
        else if (name === 'nounset') optNounset = false;
        else if (name === 'noclobber') optNoclobber = false;
        else if (name === 'xtrace') optXtrace = false;
        else if (name === 'noglob') optNoglob = false;
        else throw shellError(`set: invalid option name: ${name}`, 1);
        continue;
      }
      if (arg.startsWith('-') && arg !== '-' && arg !== '--') {
        for (let c of arg.slice(1)) {
          if (c === 'e') optErrexit = true;
          else if (c === 'u') optNounset = true;
          else if (c === 'C') optNoclobber = true;
          else if (c === 'x') optXtrace = true;
          else if (c === 'f') optNoglob = true;
          else throw shellError(`set: invalid option: -${c}`, 1);
        }
        continue;
      }
      if (arg.startsWith('+') && arg.length > 1) {
        for (let c of arg.slice(1)) {
          if (c === 'e') optErrexit = false;
          else if (c === 'u') optNounset = false;
          else if (c === 'C') optNoclobber = false;
          else if (c === 'x') optXtrace = false;
          else if (c === 'f') optNoglob = false;
          else throw shellError(`set: invalid option: +${c}`, 1);
        }
        continue;
      }
      throw shellError(`set: unsupported argument: ${arg}`, 1);
    }
    return ok('');
  }

  async function cmdSource(index, args) {
    if (!args.length) throw shellError('source: filename argument required', 1);
    let target = resolvePath(cwd, String(args[0]), HOME);
    let text = await readFile(index, target);
    if (text == null) throw shellError(`source: ${args[0]}: no such file`, 1);
    return run(String(text));
  }

  /** Expand a Word / Assignment value node into a string. */
  function expandWord(word) {
    if (word == null) return '';
    if (typeof word === 'string') return tildeExpand(word, true);
    if (word.type === 'Assignment') {
      return expandWord(word.value);
    }
    let parts;
    try {
      parts = word.parts;
    } catch {
      parts = null;
    }
    if (!parts || !parts.length) {
      let v = word.value != null ? String(word.value) : String(word.text || '');
      return tildeExpand(v, true);
    }
    let fullySingle =
      parts.length === 1 && parts[0].type === 'SingleQuoted';
    let fullyDouble =
      parts.length === 1 && parts[0].type === 'DoubleQuoted';
    let out = '';
    for (let part of parts) out += expandPart(part);
    if (!fullySingle && !fullyDouble) out = tildeExpand(out, true);
    return out;
  }

  function expandPart(part) {
    if (!part) return '';
    if (part.type === 'Literal') return String(part.value ?? part.text ?? '');
    if (part.type === 'SingleQuoted') return String(part.value ?? '');
    if (part.type === 'DoubleQuoted') {
      let inner = part.parts || [];
      if (!inner.length) {
        let t = String(part.text || '');
        return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
      }
      let out = '';
      for (let p of inner) out += expandPart(p);
      return out;
    }
    if (part.type === 'SimpleExpansion') {
      return getParam(simpleExpansionName(part.text || ''));
    }
    if (part.type === 'ParameterExpansion') {
      return expandParameter(part);
    }
    if (part.type === 'Escape') {
      return String(part.value ?? part.text?.slice(1) ?? '');
    }
    // Unsupported expansions (command, arithmetic, brace, …) → empty / literal text
    if (part.text) return String(part.text);
    return '';
  }

  function simpleExpansionName(text) {
    let t = String(text || '');
    if (t.startsWith('${') && t.endsWith('}')) return t.slice(2, -1);
    if (t.startsWith('$')) return t.slice(1);
    return t;
  }

  function getParam(name) {
    let key = String(name || '');
    if (key === '?') return String(lastStatus);
    if (key === '$') return String(shellPid);
    if (key === '!') return lastBgPid;
    if (key === '#') return String(positional.length);
    if (key === '0') return argv0 ?? (env.SHELL || 'boxsh');
    if (key === '*' || key === '@') return positional.join(' ');
    if (/^[1-9]\d*$/.test(key)) return positional[Number(key) - 1] ?? '';
    if (key === '_') return lastArg;
    if (key === '-') return (optErrexit ? 'e' : '') + (optNoglob ? 'f' : '') + (optNounset ? 'u' : '') + (optXtrace ? 'x' : '') + (optNoclobber ? 'C' : '') + (interactive ? 'i' : '');
    if (key === 'PPID') return String(parentPid);
    if (key === 'RANDOM') return String(Math.floor(Math.random() * 32768));
    if (key === 'SECONDS') return String(Math.floor((Date.now() - startedAt) / 1000));
    if (Object.prototype.hasOwnProperty.call(env, key)) return String(env[key]);
    if (optNounset) throw shellError(key + ': unbound variable', 1);
    return '';
  }

  function expandParameter(part) {
    let name = part.parameter || '';
    let value = getParam(name);
    if (part.prefix === '#') return String(value.length);
    let op = part.operation;
    if (!op) return value;
    let operand = expandWord(op.operand);
    let operator = op.operator || '';
    if (operator === ':-') return value === '' ? operand : value;
    if (operator === '-') return value === '' && !Object.prototype.hasOwnProperty.call(env, name) ? operand : value;
    if (operator === ':=') {
      if (value === '') {
        setVar(name, operand, false);
        return operand;
      }
      return value;
    }
    if (operator === '=') {
      if (!Object.prototype.hasOwnProperty.call(env, name) || env[name] === '') {
        setVar(name, operand, false);
        return operand;
      }
      return value;
    }
    if (operator === ':?') {
      if (value === '') throw shellError(operand || `${name}: parameter null or not set`, 1);
      return value;
    }
    if (operator === '?') {
      if (!Object.prototype.hasOwnProperty.call(env, name) || env[name] === '') {
        throw shellError(operand || `${name}: parameter null or not set`, 1);
      }
      return value;
    }
    if (operator === '#') return value.replace(new RegExp('^' + globToRegExp(operand)), '');
    if (operator === '##') return value.replace(new RegExp('^' + globToRegExp(operand)), '');
    if (operator === '%') return value.replace(new RegExp(globToRegExp(operand) + '$'), '');
    if (operator === '%%') return value.replace(new RegExp(globToRegExp(operand) + '$'), '');
    if (operator === ':+') return value === '' ? '' : operand;
    if (operator === '+') {
      return Object.prototype.hasOwnProperty.call(env, name) && env[name] !== '' ? operand : '';
    }
    return value;
  }

  function tildeExpand(text, allow) {
    if (!allow) return text;
    let s = String(text ?? '');
    if (s === '~') return env.HOME || '/' + HOME;
    if (s.startsWith('~/')) return (env.HOME || '/' + HOME) + s.slice(1);
    return s;
  }

  function globToRegExp(glob) {
    let g = String(glob ?? '');
    let out = '';
    for (let i = 0; i < g.length; i++) {
      let ch = g[i];
      if (ch === '*') out += '.*';
      else if (ch === '?') out += '.';
      else if ('\\.()+|^$[]{}'.includes(ch)) out += '\\' + ch;
      else out += ch;
    }
    return out;
  }

  function shellQuote(value) {
    let s = String(value ?? '');
    if (!s) return "''";
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, `'\"'\"'`) + "'";
  }

  async function expandLocal(index, raw) {
    if (optNoglob) return [resolvePath(cwd, raw, HOME)];
    return expand(index, cwd, raw, HOME);
  }

  function cmdPwd(args) {
    for (let arg of args) {
      let a = String(arg ?? '');
      if (a === '-L' || a === '-P') continue;
      if (a.startsWith('-')) throw shellError(`pwd: invalid option: ${a}`, 1);
    }
    return ok((cwd ? '/' + cwd : '/') + '\n');
  }

  async function cmdCd(index, args) {
    let raw = args.length ? args[0] : '~';
    let printPath = false;
    if (raw === '-') {
      if (!Object.prototype.hasOwnProperty.call(env, 'OLDPWD')) {
        throw shellError('cd: OLDPWD not set', 1);
      }
      raw = env.OLDPWD;
      printPath = true;
    }
    let target = resolvePath(cwd, raw, HOME);
    if (target && !(await isDir(index, target))) {
      throw shellError(`cd: ${raw}: ${(await pathExists(index, target)) ? 'Not a directory' : 'No such file or directory'}`, 1);
    }
    if (target) await requireExec(target);
    else await requireTraverse('');
    env.OLDPWD = cwd ? '/' + cwd : '/';
    cwd = target;
    syncPwd();
    if (printPath) return ok((cwd ? '/' + cwd : '/') + '\n');
    return ok('');
  }

  async function cmdLs(index, args) {
    let parsed = parseOpts(args, {
      a: 'bool', A: 'bool', d: 'bool', R: 'bool', r: 'bool', S: 'bool', l: 'bool',
    });
    let showKeep = parsed.opts.a || parsed.opts.A;
    let longFmt = !!parsed.opts.l;
    let paths = parsed.rest.length ? parsed.rest : ['.'];
    let entries = [];
    for (let raw of paths) {
      let expanded = await expandLocal(index, raw);
      for (let path of expanded) {
        if (await isDir(index, path)) entries.push({ path, raw, kind: 'dir' });
        else if (await existsFile(index, path)) entries.push({ path, raw, kind: 'file' });
        else throw shellError(`ls: no such file or directory: ${raw}`, 2);
      }
    }
    let multi = entries.length > 1;
    let blocks = [];
    let usersCache = null;
    let groupsCache = null;

    async function ownerNames() {
      if (!usersCache) usersCache = await listUsers();
      if (!groupsCache) groupsCache = await listGroups();
      return { users: usersCache, groups: groupsCache };
    }

    function nameForUid(users, uid) {
      let found = Object.values(users).find(u => Number(u.uid) === Number(uid));
      return found ? found.name : String(uid);
    }

    function nameForGid(groups, gid) {
      let found = Object.values(groups).find(g => Number(g.gid) === Number(gid));
      return found ? found.name : String(gid);
    }

    function formatMtime(ms) {
      if (!ms) return '??? ?? ??:??';
      let d = new Date(ms);
      if (Number.isNaN(d.getTime())) return '??? ?? ??:??';
      return d.toISOString().slice(0, 16).replace('T', ' ');
    }

    async function formatLong(item) {
      let { users, groups } = await ownerNames();
      let st = await vfsGetStat(item.path);
      let mode = st?.mode ?? (item.kind === 'dir' ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE);
      let uid = st?.uid ?? 0;
      let gid = st?.gid ?? 0;
      let mtime = st?.mtime;
      let isLink = st?.kind === 'symlink';
      let linkText = isLink ? String(st.linkText ?? st.target ?? '') : null;
      let size = isLink ? linkText.length : item.kind === 'dir' ? 0 : await vfsSize(item.path);
      let perms = formatMode(mode, item.kind === 'dir' ? 'dir' : 'file');
      if (isLink) perms = 'l' + perms.slice(1);
      let display = longFmt && item.kind === 'dir' && !item.name.endsWith('/')
        ? item.name
        : item.name;
      if (item.kind === 'dir' && !String(display).endsWith('/') && !longFmt) display += '/';
      if (longFmt && item.kind === 'dir' && String(display).endsWith('/')) {
        display = display.slice(0, -1);
      }
      return [
        perms,
        '1',
        nameForUid(users, uid),
        nameForGid(groups, gid),
        String(size),
        formatMtime(mtime),
        isLink ? `${display} -> ${linkText}` : display,
      ].join(' ');
    }

    async function sizeOfEntry(path, kind) {
      if (kind === 'dir') return 0;
      return vfsSize(path);
    }

    async function sortNames(items) {
      if (parsed.opts.S) {
        for (let item of items) item._size = await sizeOfEntry(item.path, item.kind);
        items.sort((a, b) => b._size - a._size || a.name.localeCompare(b.name));
      } else {
        items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
      }
      if (parsed.opts.r) items.reverse();
      return items;
    }

    async function listOne(dirPath) {
      await requireList(dirPath);
      let names = await listDir(index, dirPath, showKeep);
      let items = names.map(entry => ({
        name: entry.kind === 'dir' ? entry.name + '/' : entry.name,
        kind: entry.kind,
        path: joinPath(dirPath, entry.name),
      }));
      await sortNames(items);
      if (longFmt) {
        let lines = [];
        for (let item of items) lines.push(await formatLong(item));
        return lines.join('\n');
      }
      return items.map(i => i.name).join('\n');
    }

    async function listRecursive(dirPath, headerPath) {
      let out = [];
      let label = headerPath == null ? (dirPath || '.') : headerPath;
      out.push(label + ':');
      let body = await listOne(dirPath);
      if (body) out.push(body);
      let names = await listDir(index, dirPath, showKeep);
      let dirs = names.filter(e => e.kind === 'dir').map(e => e.name).sort();
      if (parsed.opts.r) dirs.reverse();
      for (let name of dirs) {
        let child = joinPath(dirPath, name);
        let childLabel = (label === '.' ? name : label + '/' + name);
        out.push('');
        out.push(await listRecursive(child, childLabel));
      }
      return out.join('\n');
    }

    // Operands are shown as typed (globs: relative to cwd, or absolute).
    let operandName = (e) => {
      if (!/[*?[]/.test(e.raw)) return e.raw;
      if (String(e.raw).startsWith('/')) return '/' + e.path;
      let c = cwd ? cwd + '/' : '';
      return e.path.startsWith(c) ? e.path.slice(c.length) : '/' + e.path;
    };
    if (parsed.opts.d) {
      let items = entries.map(e => ({
        name: parsed.rest.length ? operandName(e) : '.',
        kind: e.kind,
        path: e.path,
      }));
      await sortNames(items);
      if (longFmt) {
        let lines = [];
        for (let item of items) lines.push(await formatLong(item));
        return ok(lines.length ? lines.join('\n') + '\n' : '');
      }
      let text = items.map(i => i.name).join('\n');
      return ok(text ? text + '\n' : '');
    }

    // Like GNU ls: file operands first, in one block, named as typed; then each directory.
    let fileItems = entries.filter((e) => e.kind === 'file').map((e) => ({ name: operandName(e), kind: 'file', path: e.path }));
    if (fileItems.length) {
      await sortNames(fileItems);
      let lines = [];
      for (let item of fileItems) {
        await requireRead(item.path);
        lines.push(longFmt ? await formatLong(item) : item.name);
      }
      blocks.push(lines.join('\n'));
    }
    for (let entry of entries) {
      if (entry.kind === 'file') continue;
      let header = multi || parsed.opts.R;
      if (parsed.opts.R) {
        let block = await listRecursive(entry.path, parsed.rest.length ? operandName(entry) : '.');
        blocks.push(block);
      } else {
        let body = await listOne(entry.path);
        if (header) blocks.push((parsed.rest.length ? operandName(entry) : '.') + ':' + (body ? '\n' + body : ''));
        else blocks.push(body);
      }
    }
    let text = blocks.filter(b => b != null && b !== '').join('\n\n');
    return ok(text ? text + '\n' : '');
  }

  function transformCat(text, opts) {
    let lines = text.split('\n');
    let endsWithNl = text.endsWith('\n');
    if (endsWithNl) lines.pop();
    let out = [];
    let prevBlank = false;
    let num = 0;
    for (let line of lines) {
      let blank = line === '';
      if (opts.s && blank && prevBlank) continue;
      prevBlank = blank;
      if (opts.n || (opts.b && !blank)) {
        num += 1;
        out.push(String(num).padStart(6, ' ') + '\t' + line);
      } else if (opts.b && blank) {
        out.push(line);
      } else {
        out.push(line);
      }
    }
    return out.join('\n') + (out.length || endsWithNl ? '\n' : '');
  }

  async function cmdCat(index, args, stdin) {
    let parsed = parseOpts(args, { n: 'bool', b: 'bool', s: 'bool' });
    let opts = { n: !!parsed.opts.n, b: !!parsed.opts.b, s: !!parsed.opts.s };
    if (opts.b) opts.n = false;
    if (!parsed.rest.length) {
      if (stdin == null) throw shellError('cat: no paths given', 1);
      return ok(opts.n || opts.b || opts.s ? transformCat(stdin, opts) : stdin);
    }
    let out = '';
    for (let raw of parsed.rest) {
      if (raw === '-') {
        let chunk = stdin || '';
        out += opts.n || opts.b || opts.s ? transformCat(chunk, opts) : chunk;
        continue;
      }
      let expanded = await expandLocal(index, raw);
      for (let path of expanded) {
        if (await isDir(index, path)) throw shellError(`cat: ${path}: Is a directory`, 1);
        let text = await readFile(index, path);
        if (text == null) throw shellError(`cat: no such file or directory: ${path}`, 1);
        out += opts.n || opts.b || opts.s ? transformCat(text, opts) : text;
      }
    }
    return ok(out);
  }

  async function cmdGrep(index, args, stdin) {
    let parsed = parseGrepArgs(args);
    let before = parsed.before;
    let after = parsed.after;
    if ((before != null && before < 0) || (after != null && after < 0)) {
      throw shellError('grep: invalid context length argument', 2);
    }
    for (let file of parsed.patternFiles) {
      let path = resolvePath(cwd, file, HOME);
      let text = await readFile(index, path);
      if (text == null) throw shellError(`grep: ${file}: No such file or directory`, 2);
      let plines = text.split('\n');
      if (text.endsWith('\n')) plines.pop();
      for (let line of plines) parsed.patterns.push(line);
    }
    if (!parsed.patterns.length) throw shellError('grep: no pattern given', 2);
    let fileArgs = parsed.files;
    if (!fileArgs.length && stdin == null) throw shellError('grep: no paths given', 2);
    let source = parsed.patterns.map(pattern => parsed.fixed ? escapeRegExp(pattern) : pattern).join('|');
    if (parsed.word) source = `\\b(?:${source})\\b`;
    if (parsed.lineRegexp) source = `^(?:${source})$`;
    let regex;
    try {
      regex = new RegExp(source, parsed.ignoreCase ? 'i' : '');
    } catch (err) {
      throw shellError(`grep: ${err.message}`, 2);
    }
    let files = [];
    let stdinFiles = [];
    let stderr = '';
    let code = 0;
    for (let raw of fileArgs) {
      if (raw === '-') {
        stdinFiles.push(stdin || '');
        continue;
      }
      let expanded = await expandLocal(index, raw);
      for (let path of expanded) {
        if (await isDir(index, path)) {
          if (!parsed.recursive) {
            stderr += `grep: ${path}: Is a directory\n`;
            code = 2;
            continue;
          }
          for (let file of await filesUnder(index, path)) {
            if (grepSkip(file, parsed)) continue;
            files.push(file);
          }
        } else if (isKeep(path) && !raw.endsWith('.keep')) {
          continue;
        } else if (await existsFile(index, path)) {
          if (!grepSkip(path, parsed)) files.push(path);
        } else if (!parsed.quietErrors) {
          stderr += `grep: no such file or directory: ${path}\n`;
          code = 2;
        } else {
          code = 2;
        }
      }
    }
    if (!fileArgs.length) stdinFiles.push(stdin || '');
    files = [...new Set(files)];
    let prefixNames = parsed.withFilename || (!parsed.noFilename && (parsed.recursive || files.length + stdinFiles.length > 1));
    let groups = [];
    let any = false;
    let sep = (before || after) ? '\n--\n' : '\n';
    let scan = async (label, contents) => {
      if (parsed.countOnly) {
        let lines = contents.split('\n');
        if (contents.endsWith('\n')) lines.pop();
        let n = 0;
        for (let line of lines) {
          let matched = regex.test(line);
          if ((parsed.inverse && !matched) || (!parsed.inverse && matched)) n += 1;
        }
        if (n > 0) any = true;
        groups.push((prefixNames && label ? label + ':' : '') + String(n));
        return;
      }
      if (parsed.quiet) {
        let lines = contents.split('\n');
        if (contents.endsWith('\n')) lines.pop();
        for (let line of lines) {
          let matched = regex.test(line);
          if ((parsed.inverse && !matched) || (!parsed.inverse && matched)) {
            any = true;
            return;
          }
        }
        return;
      }
      if (parsed.onlyMatching) {
        let rows = grepOnly(regex, contents, parsed.inverse);
        if (!rows.length) return;
        any = true;
        groups.push(rows.map(row => (prefixNames && label ? label + ':' : '') + (parsed.lineNumber ? row.lineNumber + ':' : '') + row.text).join('\n'));
        return;
      }
      let matched = grepContents({
        inverse: parsed.inverse,
        nameOnly: parsed.namesOnly,
        lineNumber: parsed.lineNumber,
        before: before || 0,
        after: after || 0,
      }, regex, contents);
      if (parsed.namesOnly) {
        if (matched && label) {
          any = true;
          groups.push(label);
        }
        return;
      }
      if (!matched.length) return;
      any = true;
      groups.push(matched.map(group => rowsOf(group).map(row => formatGrepRow(label, row, parsed.lineNumber, prefixNames && !!label)).join('\n')).join(sep));
    };
    for (let file of files) {
      let contents = await fs.read(file);
      if (contents == null) {
        if (!parsed.quietErrors) stderr += `grep: no such file or directory: ${file}\n`;
        code = 2;
        continue;
      }
      await scan(file, contents);
      if (parsed.quiet && any) break;
    }
    if (!(parsed.quiet && any)) {
      for (let text of stdinFiles) await scan(parsed.withFilename ? '(standard input)' : '', text);
    }
    if (!any && !code) code = 1;
    if (parsed.quiet) return { code: any ? 0 : (code === 2 ? 2 : 1), stdout: '', stderr: '' };
    let joiner = parsed.namesOnly || parsed.countOnly ? '\n' : sep;
    let stdout = groups.length ? groups.join(joiner) + '\n' : '';
    if (code === 1 && !stdout && !stderr) stderr = 'grep: no matches\n';
    return { code, stdout, stderr };
  }

  async function cmdMkdir(index, args) {
    let parsed = parseOpts(args, { p: 'bool', v: 'bool', m: 'str' });
    if (!parsed.rest.length) throw shellError('mkdir: missing operand', 1);
    let modeOverride = null;
    if (parsed.opts.m != null) {
      try {
        modeOverride = parseModeSpec(parsed.opts.m, DEFAULT_DIR_MODE);
      } catch (err) {
        throw shellError(`mkdir: ${err.message}`, 1);
      }
    }
    let out = '';
    for (let raw of parsed.rest) {
      let path = resolvePath(cwd, raw, HOME);
      if (!path) continue;
      if (await existsFile(index, path)) {
        throw shellError(`mkdir: cannot create directory '${path}': File exists`, 1);
      }
      if (parsed.opts.p) {
        let parts = path.split('/');
        let acc = [];
        for (let part of parts) {
          acc.push(part);
          let dir = acc.join('/');
          if (await existsFile(index, dir)) {
            throw shellError(`mkdir: cannot create directory '${path}': Not a directory`, 1);
          }
          if (!(await isDir(index, dir))) {
            await writeKeep(index, dir, modeOverride);
            if (parsed.opts.v) out += `mkdir: created directory '${dir}'\n`;
          }
        }
        continue;
      }
      if (await isDir(index, path)) {
        throw shellError(`mkdir: cannot create directory '${path}': File exists`, 1);
      }
      let parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (parent) {
        if (await existsFile(index, parent)) {
          throw shellError(`mkdir: cannot create directory '${path}': Not a directory`, 1);
        }
        if (!(await isDir(index, parent))) {
          throw shellError(`mkdir: cannot create directory '${path}': No such file or directory`, 1);
        }
      }
      await writeKeep(index, path, modeOverride);
      if (parsed.opts.v) out += `mkdir: created directory '${path}'\n`;
    }
    return ok(out);
  }

  async function cmdRm(index, args) {
    let parsed = parseOpts(args, { r: 'bool', R: 'bool', f: 'bool', d: 'bool' });
    let recursive = parsed.opts.r || parsed.opts.R;
    if (!parsed.rest.length && !parsed.opts.f) throw shellError('rm: missing operand', 1);
    for (let raw of parsed.rest) {
      let expanded = hasGlob(raw) && !optNoglob
        ? await expand(index, cwd, raw, HOME)
        : [resolvePath(cwd, raw, HOME)];
      if (hasGlob(raw) && !optNoglob && !expanded.length) {
        if (!parsed.opts.f) throw shellError(`rm: no such file or directory: ${raw}`, 1);
        continue;
      }
      for (let path of expanded) {
        if (isKeep(path)) throw shellError(`rm: refusing to remove ${path}; remove the directory with rm -r`, 1);
        if (await isDir(index, path)) {
          await requireUnlink(path);
          if (recursive) {
            await fs.remove(path + '/');
            dropPrefix(await index.all(), path + '/');
          } else if (parsed.opts.d) {
            let kids = await listDir(index, path, true);
            let nonempty = kids.filter(e => !(e.kind === 'file' && e.name === '.keep'));
            if (nonempty.length) throw shellError(`rm: cannot remove '${path}': Directory not empty`, 1);
            await fs.remove(path + '/');
            dropPrefix(await index.all(), path + '/');
          } else {
            throw shellError(`rm: cannot remove '${path}': Is a directory`, 1);
          }
        } else if (await existsFile(index, path)) {
          await requireUnlink(path);
          await fs.remove(path);
          (await index.all()).delete(path);
        } else if (!parsed.opts.f) {
          throw shellError(`rm: no such file or directory: ${path}`, 1);
        }
      }
    }
    return ok('');
  }

  async function cmdMv(index, args) {
    let parsed = parseOpts(args, { n: 'bool', t: 'str', T: 'bool', v: 'bool' });
    let sources;
    let dest;
    if (parsed.opts.t != null) {
      dest = resolvePath(cwd, parsed.opts.t, HOME);
      sources = [];
      for (let raw of parsed.rest) sources.push(...await expandLocal(index, raw));
      if (!sources.length) throw shellError('mv: missing file operand', 1);
    } else {
      if (parsed.rest.length < 2) throw shellError('mv: missing operand', 1);
      dest = resolvePath(cwd, parsed.rest[parsed.rest.length - 1], HOME);
      sources = [];
      for (let raw of parsed.rest.slice(0, -1)) sources.push(...await expandLocal(index, raw));
    }
    let destIsDir = await isDir(index, dest);
    if (parsed.opts.T) {
      if (destIsDir) throw shellError(`mv: cannot overwrite directory '${dest}' with non-directory`, 1);
      destIsDir = false;
    }
    if ((sources.length > 1 || parsed.opts.t != null) && !destIsDir && !parsed.opts.T) {
      if (!(await isDir(index, dest))) throw shellError(`mv: target '${dest}' is not a directory`, 1);
      destIsDir = true;
    }
    if (sources.length > 1 && !destIsDir) throw shellError(`mv: target '${dest}' is not a directory`, 1);
    let out = '';
    for (let src of sources) {
      await requireUnlink(src);
      let target = destIsDir ? joinPath(dest, baseName(src)) : dest;
      await requireWriteCreate(target);
      if (parsed.opts.n && ((await existsFile(index, target)) || (await isDir(index, target)))) continue;
      if (await isDir(index, src)) {
        await ensureParents(index, target + '/.keep');
        await fs.move(src + '/', target + '/');
        retargetPrefix(await index.all(), src + '/', target + '/');
      } else {
        if (!(await existsFile(index, src))) throw shellError(`mv: no such file or directory: ${src}`, 1);
        await ensureParents(index, target);
        await fs.move(src, target);
        let paths = await index.all();
        paths.delete(src);
        paths.add(target);
      }
      if (parsed.opts.v) out += `${src} -> ${target}\n`;
    }
    return ok(out);
  }

  async function cmdCp(index, args) {
    let parsed = parseOpts(args, { r: 'bool', R: 'bool', n: 'bool', t: 'str', T: 'bool', v: 'bool' });
    let sources;
    let dest;
    if (parsed.opts.t != null) {
      dest = resolvePath(cwd, parsed.opts.t, HOME);
      sources = [];
      for (let raw of parsed.rest) sources.push(...await expandLocal(index, raw));
      if (!sources.length) throw shellError('cp: missing file operand', 1);
    } else {
      if (parsed.rest.length < 2) throw shellError('cp: missing operand', 1);
      dest = resolvePath(cwd, parsed.rest[parsed.rest.length - 1], HOME);
      sources = [];
      for (let raw of parsed.rest.slice(0, -1)) sources.push(...await expandLocal(index, raw));
    }
    let destIsDir = await isDir(index, dest);
    if (parsed.opts.T) {
      if (destIsDir) throw shellError(`cp: cannot overwrite directory '${dest}' with non-directory`, 1);
      destIsDir = false;
    }
    if ((sources.length > 1 || parsed.opts.t != null) && !destIsDir && !parsed.opts.T) {
      if (!(await isDir(index, dest))) throw shellError(`cp: target '${dest}' is not a directory`, 1);
      destIsDir = true;
    }
    if (sources.length > 1 && !destIsDir) throw shellError(`cp: target '${dest}' is not a directory`, 1);
    let out = '';
    for (let src of sources) {
      let target = destIsDir ? joinPath(dest, baseName(src)) : dest;
      if (parsed.opts.n && ((await existsFile(index, target)) || (await isDir(index, target)))) continue;
      if (await isDir(index, src)) {
        if (!(parsed.opts.r || parsed.opts.R)) throw shellError(`cp: -r not specified; omitting directory '${src}'`, 1);
        await requireList(src);
        let paths = [...await index.all()].filter(path => path === src + '/.keep' || path.startsWith(src + '/'));
        for (let path of paths) {
          let next = target + path.slice(src.length);
          let text = await fs.read(path);
          await writeFile(index, next, text == null ? '' : text);
        }
      } else {
        let text = await readFile(index, src);
        if (text == null) throw shellError(`cp: no such file or directory: ${src}`, 1);
        await writeFile(index, target, text);
      }
      if (parsed.opts.v) out += `${src} -> ${target}\n`;
    }
    return ok(out);
  }

  async function cmdLn(index, args) {
    let symbolic = false;
    let force = false;
    let rest = [];
    for (let a of args) {
      let s = String(a ?? '');
      if (s === '-s' || s === '--symbolic') symbolic = true;
      else if (s === '-f' || s === '--force') force = true;
      else if (s === '-sf' || s === '-fs') {
        symbolic = true;
        force = true;
      } else if (s.startsWith('-')) throw shellError('ln: unsupported option ' + s, 1);
      else rest.push(s);
    }
    if (rest.length !== 2) throw shellError('ln: usage: ln [-s] [-f] TARGET LINK_NAME', 1);
    let target = resolvePath(cwd, rest[0], HOME);
    let linkName = resolvePath(cwd, rest[1], HOME);
    if (symbolic) {
      if (typeof fs.symlink !== 'function') {
        throw shellError('ln: symbolic links not supported by this filesystem', 1);
      }
      if (!force && ((await existsFile(index, linkName)) || (await isDir(index, linkName)))) {
        throw shellError('ln: failed to create symbolic link \'' + linkName + '\': File exists', 1);
      }
      await requireWriteCreate(linkName);
      // Store target as the path the user typed when relative-looking; otherwise
      // the resolved absolute VFS path so location/exits stay stable.
      // POSIX: a relative target is relative to the link's directory (stored as ./x so the VFS's
      // root-relative convention doesn't apply); the text as typed is what readlink/ls show.
      let rawTarget = String(rest[0] ?? '');
      let stored = rawTarget.startsWith('/') ? rawTarget.replace(/^\/+/, '') || target : rawTarget.startsWith('.') ? rawTarget : './' + rawTarget;
      try {
        await fs.symlink(stored, linkName, { force });
        await vfsSetStat(linkName, { ...((await vfsGetStat(linkName)) || {}), kind: 'symlink', linkText: rawTarget });
      } catch (err) {
        throw shellError('ln: ' + (err?.message || err), 1);
      }
      return ok('');
    }
    if (typeof fs.link !== 'function') {
      throw shellError('ln: hard links not supported by this filesystem', 1);
    }
    if (force && (await existsFile(index, linkName))) await fs.remove(linkName);
    await requireRead(target);
    await requireWriteCreate(linkName);
    try {
      await fs.link(target, linkName);
    } catch (err) {
      throw shellError('ln: ' + (err?.message || err), 1);
    }
    return ok('');
  }

  async function cmdAddcontact(args) {
    let app = 'relay';
    let peer = null;
    for (let i = 0; i < args.length; i++) {
      let a = String(args[i] ?? '');
      if (a === '--app') app = String(args[++i] || 'relay');
      else if (a.startsWith('--app=')) app = a.slice(6) || 'relay';
      else if (a.startsWith('-')) throw shellError('addcontact: unknown option ' + a, 1);
      else peer = a;
    }
    if (!peer) throw shellError('addcontact: usage: addcontact <user> [--app relay]', 1);
    let self = actor.name || PLAYER;
    if (!isRoot(actor.uid)) {
      let gs = await groupsForUser(actor.name);
      if (!gs.some((g) => g.name === 'sudo') && self !== peer) {
        // Self-service: any user may add a contact for themselves.
      }
    }
    try {
      let { addContact } = await import('./chats.js');
      let result = await addContact(self, peer, { app });
      return ok(
        (result.reused ? 'reused' : 'created') +
          ' chat ' +
          (result.chatId || '') +
          ' (' +
          self +
          ' ↔ ' +
          peer +
          ' via ' +
          app +
          ')\n',
      );
    } catch (err) {
      throw shellError('addcontact: ' + (err?.message || err), 1);
    }
  }

  function interpretEchoEscapes(text) {
    let out = '';
    let stopped = false;
    for (let i = 0; i < text.length; i++) {
      let ch = text[i];
      if (ch !== '\\' || i + 1 >= text.length) {
        out += ch;
        continue;
      }
      let next = text[++i];
      if (next === '\\') out += '\\';
      else if (next === 'n') out += '\n';
      else if (next === 't') out += '\t';
      else if (next === 'r') out += '\r';
      else if (next === 'a') out += '\x07';
      else if (next === 'b') out += '\b';
      else if (next === 'f') out += '\f';
      else if (next === 'v') out += '\v';
      else if (next === 'e') out += '\x1b';
      else if (next === 'c') {
        stopped = true;
        break;
      } else if (next === 'x') {
        let hex = '';
        for (let k = 0; k < 2 && i + 1 < text.length && /[0-9a-fA-F]/.test(text[i + 1]); k++) {
          hex += text[++i];
        }
        out += hex ? String.fromCharCode(parseInt(hex, 16)) : 'x';
      } else if (next === '0') {
        let oct = '';
        for (let k = 0; k < 3 && i + 1 < text.length && /[0-7]/.test(text[i + 1]); k++) {
          oct += text[++i];
        }
        out += oct ? String.fromCharCode(parseInt(oct, 8)) : '\0';
      } else {
        out += '\\' + next;
      }
    }
    return { text: out, stopped };
  }

  function cmdEcho(args) {
    let newline = true;
    let escapes = false;
    let i = 0;
    while (i < args.length) {
      let arg = String(args[i] ?? '');
      if (arg === '-' || arg === '--') {
        if (arg === '--') i += 1;
        break;
      }
      if (!arg.startsWith('-') || arg.length === 1) break;
      let cluster = arg.slice(1);
      if (![...cluster].every(c => 'neE'.includes(c))) break;
      for (let c of cluster) {
        if (c === 'n') newline = false;
        else if (c === 'e') escapes = true;
        else if (c === 'E') escapes = false;
      }
      i += 1;
    }
    let messages = args.slice(i).map(a => String(a ?? ''));
    let body = messages.join(' ');
    if (escapes) {
      let interpreted = interpretEchoEscapes(body);
      body = interpreted.text;
      if (interpreted.stopped) newline = false;
    }
    return ok(body + (newline ? '\n' : ''));
  }

  function interpretPercentB(text) {
    return interpretEchoEscapes(String(text ?? '')).text;
  }

  function applyPrintfFormat(format, rest, startIndex) {
    let i = startIndex;
    let out = '';
    let s = String(format ?? '');
    for (let p = 0; p < s.length; p++) {
      let ch = s[p];
      if (ch === '\\' && p + 1 < s.length) {
        let next = s[++p];
        if (next === 'n') out += '\n';
        else if (next === 't') out += '\t';
        else if (next === 'r') out += '\r';
        else if (next === '\\') out += '\\';
        else out += next;
        continue;
      }
      if (ch === '%' && p + 1 < s.length) {
        let spec = s[++p];
        if (spec === '%') {
          out += '%';
          continue;
        }
        let v = rest[i++];
        if (spec === 's') out += v == null ? '' : String(v);
        else if (spec === 'd') out += v == null ? '0' : String(Number(v) || 0);
        else if (spec === 'b') out += v == null ? '' : interpretPercentB(v);
        else out += '%' + spec;
        continue;
      }
      out += ch;
    }
    return { text: out, next: i };
  }

  function cmdPrintf(args) {
    if (!args.length) return ok('');
    let format = String(args[0] ?? '');
    let rest = args.slice(1);
    if (!rest.length) {
      return ok(applyPrintfFormat(format, [], 0).text);
    }
    let out = '';
    let i = 0;
    // Reuse format until args exhausted (POSIX).
    do {
      let before = i;
      let step = applyPrintfFormat(format, rest, i);
      out += step.text;
      i = step.next;
      if (i === before) break;
    } while (i < rest.length);
    return ok(out);
  }

  function parseHeadTailArgs(args) {
    let opts = { n: null, c: null, q: false, v: false };
    let rest = [];
    for (let i = 0; i < args.length; i++) {
      let arg = String(args[i] ?? '');
      if (arg === '--') {
        rest.push(...args.slice(i + 1));
        break;
      }
      if (arg === '-') {
        rest.push(arg);
        continue;
      }
      let m = arg.match(/^-([nc])([+-]?\d+)$/);
      if (m) {
        opts[m[1]] = m[2];
        continue;
      }
      if (arg === '-n' || arg === '-c') {
        let flag = arg[1];
        let value = args[++i];
        if (value == null) throw shellError(`option -${flag} requires a value`, 1);
        opts[flag] = String(value);
        continue;
      }
      if (arg === '-q') {
        opts.q = true;
        continue;
      }
      if (arg === '-v') {
        opts.v = true;
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') {
        let cluster = arg.slice(1);
        for (let c = 0; c < cluster.length; c++) {
          let flag = cluster[c];
          if (flag === 'q') opts.q = true;
          else if (flag === 'v') opts.v = true;
          else if (flag === 'n' || flag === 'c') {
            let inline = cluster.slice(c + 1);
            let value = inline || args[++i];
            if (value == null || value === '') throw shellError(`option -${flag} requires a value`, 1);
            opts[flag] = String(value);
            break;
          } else throw shellError(`unknown option: -${flag}`, 1);
        }
        continue;
      }
      rest.push(arg);
    }
    return { opts, rest };
  }

  function sliceHeadTail(text, head, opts) {
    let mode = opts.c != null ? 'c' : 'n';
    let raw = mode === 'c' ? opts.c : (opts.n == null ? '10' : opts.n);
    let fromStart = String(raw).startsWith('+');
    let neg = String(raw).startsWith('-') && !fromStart;
    let count = Math.abs(Number(raw));
    if (Number.isNaN(count)) count = 10;
    if (mode === 'c') {
      if (head) {
        if (fromStart) return text.slice(Math.max(count - 1, 0));
        if (neg) return text.slice(0, Math.max(text.length - count, 0));
        return text.slice(0, count);
      }
      if (fromStart) return text.slice(Math.max(count - 1, 0));
      if (neg) return text.slice(0, Math.max(text.length - count, 0));
      return text.slice(Math.max(text.length - count, 0));
    }
    let lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    let slice;
    if (head) {
      if (fromStart) slice = lines.slice(Math.max(count - 1, 0));
      else if (neg) slice = lines.slice(0, Math.max(lines.length - count, 0));
      else slice = lines.slice(0, count);
    } else {
      if (fromStart) slice = lines.slice(Math.max(count - 1, 0));
      else if (neg) slice = lines.slice(0, Math.max(lines.length - count, 0));
      else slice = lines.slice(Math.max(lines.length - count, 0));
    }
    return slice.join('\n') + (slice.length ? '\n' : '');
  }

  async function cmdHeadTail(index, args, head, stdin) {
    // Classic `head -3` / `tail -20` shorthand for -n NUM.
    args = args.flatMap((a) => (typeof a === 'string' && /^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]));
    let parsed = parseHeadTailArgs(args);
    let labeled = [];
    if (!parsed.rest.length) {
      if (stdin == null) throw shellError(`${head ? 'head' : 'tail'}: no paths given`, 1);
      labeled.push({ path: null, text: stdin });
    }
    for (let raw of parsed.rest) {
      if (raw === '-') {
        labeled.push({ path: 'standard input', text: stdin || '' });
        continue;
      }
      for (let path of await expandLocal(index, raw)) {
        if (await isDir(index, path)) throw shellError(`${head ? 'head' : 'tail'}: ${path}: Is a directory`, 1);
        let text = await readFile(index, path);
        if (text == null) throw shellError(`${head ? 'head' : 'tail'}: no such file or directory: ${path}`, 1);
        labeled.push({ path, text });
      }
    }
    let showHeaders = parsed.opts.v || (!parsed.opts.q && labeled.length > 1);
    let out = '';
    for (let i = 0; i < labeled.length; i++) {
      let item = labeled[i];
      if (showHeaders && item.path != null) {
        if (i) out += '\n';
        out += `==> ${item.path} <==\n`;
      }
      out += sliceHeadTail(item.text, head, parsed.opts);
    }
    return ok(out);
  }

  async function cmdTouch(index, args) {
    let filtered = [];
    let noCreate = false;
    for (let i = 0; i < args.length; i++) {
      let arg = String(args[i] ?? '');
      if (arg === '--') {
        filtered.push(...args.slice(i + 1));
        break;
      }
      if (arg === '--no-create') {
        noCreate = true;
        continue;
      }
      filtered.push(arg);
    }
    let parsed = parseOpts(filtered, { c: 'bool' });
    if (parsed.opts.c) noCreate = true;
    if (!parsed.rest.length) throw shellError('touch: missing file operand', 1);
    for (let raw of parsed.rest) {
      let path = resolvePath(cwd, raw, HOME);
      if (!path) continue;
      if (await existsFile(index, path) || await isDir(index, path)) continue;
      if (noCreate) continue;
      await writeFile(index, path, '');
    }
    return ok('');
  }

  async function cmdFind(index, args) {
    let starts = [];
    let preds = [];
    let maxdepth = null;
    let mindepth = 0;
    let print0 = false;
    let i = 0;
    while (i < args.length && !String(args[i]).startsWith('-')) {
      starts.push(String(args[i++]));
    }
    if (!starts.length) starts.push('.');
    for (; i < args.length; i++) {
      let arg = String(args[i]);
      if (arg === '-name' || arg === '-iname' || arg === '-path' || arg === '-ipath') {
        let glob = args[++i];
        if (glob == null) throw shellError(`find: missing argument to ${arg}`, 1);
        preds.push({ kind: arg, glob: String(glob) });
        continue;
      }
      if (arg === '-type') {
        let kind = args[++i];
        if (kind !== 'f' && kind !== 'd') throw shellError('find: -type expects f or d', 1);
        preds.push({ kind: '-type', type: kind });
        continue;
      }
      if (arg === '-maxdepth') {
        let n = Number(args[++i]);
        if (Number.isNaN(n)) throw shellError('find: -maxdepth expects a number', 1);
        maxdepth = n;
        continue;
      }
      if (arg === '-mindepth') {
        let n = Number(args[++i]);
        if (Number.isNaN(n)) throw shellError('find: -mindepth expects a number', 1);
        mindepth = n;
        continue;
      }
      if (arg === '-print0') {
        print0 = true;
        continue;
      }
      if (arg === '-print') continue;
      throw shellError(`find: unknown predicate: ${arg}`, 1);
    }

    function depthOf(path, root) {
      if (!root) return path ? path.split('/').filter(Boolean).length : 0;
      if (path === root) return 0;
      if (!path.startsWith(root + '/')) return -1;
      return path.slice(root.length + 1).split('/').filter(Boolean).length;
    }

    function matchPreds(path, isDirectory) {
      for (let pred of preds) {
        if (pred.kind === '-type') {
          if (pred.type === 'd' && !isDirectory) return false;
          if (pred.type === 'f' && isDirectory) return false;
          continue;
        }
        let subject = (pred.kind === '-name' || pred.kind === '-iname') ? baseName(path) : path;
        let ignore = pred.kind === '-iname' || pred.kind === '-ipath';
        if (!minimatch(subject, pred.glob, { ...globOpts, nocase: ignore })) return false;
      }
      return true;
    }

    let lines = [];
    for (let rawStart of starts) {
      let start = resolvePath(cwd, rawStart, HOME);
      let paths = [...await index.all()];
      let dirs = new Set();
      let files = [];
      for (let path of paths) {
        if (start && path !== start && !path.startsWith(start + '/')) continue;
        if (isKeep(path)) {
          dirs.add(path.slice(0, -'/.keep'.length));
          continue;
        }
        files.push(path);
      }
      if (!start) dirs.add('');
      else if (await isDir(index, start)) dirs.add(start);

      let candidates = [];
      for (let dir of dirs) {
        let d = depthOf(dir, start);
        if (d < 0) continue;
        if (maxdepth != null && d > maxdepth) continue;
        if (d < mindepth) continue;
        if (matchPreds(dir || '.', true)) candidates.push(dir || '.');
      }
      for (let file of files) {
        let d = depthOf(file, start);
        if (d < 0) continue;
        if (maxdepth != null && d > maxdepth) continue;
        if (d < mindepth) continue;
        if (isKeep(file)) continue;
        if (matchPreds(file, false)) candidates.push(file);
      }
      candidates = [...new Set(candidates)].sort();
      lines.push(...candidates);
    }
    if (!lines.length) return ok('');
    if (print0) return ok(lines.join('\0') + '\0');
    return ok(lines.join('\n') + '\n');
  }

  function compileSedScripts(scripts, extended) {
    return scripts.map(script => {
      let range = String(script).match(/^(\d+)(?:,(\d+))?p$/);
      if (range) {
        return {
          kind: 'print',
          start: Number(range[1]),
          end: range[2] ? Number(range[2]) : Number(range[1]),
        };
      }
      let s = String(script);
      if (!s.startsWith('s') || s.length < 4) {
        throw shellError('sed: unsupported script (use Np / N,Mp or s/// )', 1);
      }
      let delim = s[1];
      let body = s.slice(2);
      let parts = [];
      let cur = '';
      let escaped = false;
      for (let i = 0; i < body.length; i++) {
        let ch = body[i];
        if (escaped) {
          cur += ch;
          escaped = false;
          continue;
        }
        if (ch === '\\') {
          // Keep escapes for the regex/repl; also allow delim escape.
          if (i + 1 < body.length && body[i + 1] === delim) {
            cur += delim;
            i += 1;
            continue;
          }
          cur += ch;
          escaped = true;
          continue;
        }
        if (ch === delim) {
          parts.push(cur);
          cur = '';
          continue;
        }
        cur += ch;
      }
      // flags after final delim sit in cur if we ended without trailing empty
      let flags = '';
      if (parts.length >= 2) {
        flags = cur;
      } else {
        throw shellError('sed: bad s/// script', 1);
      }
      let pat = parts[0];
      let repl = parts[1];
      let reFlags = '';
      if (flags.includes('g')) reFlags += 'g';
      if (flags.includes('i') || flags.includes('I')) reFlags += 'i';
      void extended;
      let regex;
      try {
        regex = new RegExp(pat, reFlags);
      } catch (err) {
        throw shellError(`sed: ${err.message}`, 1);
      }
      return { kind: 'sub', regex, repl };
    });
  }

  async function cmdSed(index, args, stdin) {
    let quiet = false;
    let extended = false;
    let inPlace = false;
    let inPlaceExt = '';
    let scripts = [];
    let files = [];
    for (let i = 0; i < args.length; i++) {
      let arg = String(args[i] ?? '');
      if (arg === '--') {
        files.push(...args.slice(i + 1));
        break;
      }
      if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
        quiet = true;
        continue;
      }
      if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
        extended = true;
        continue;
      }
      if (arg === '-i') {
        inPlace = true;
        inPlaceExt = '';
        continue;
      }
      if (arg.startsWith('-i') && arg.length > 2) {
        inPlace = true;
        inPlaceExt = arg.slice(2);
        continue;
      }
      if (arg === '--in-place') {
        inPlace = true;
        inPlaceExt = '';
        continue;
      }
      if (arg.startsWith('--in-place=')) {
        inPlace = true;
        inPlaceExt = arg.slice('--in-place='.length);
        continue;
      }
      if (arg === '-e') {
        let script = args[++i];
        if (script == null) throw shellError('sed: -e requires a script', 1);
        scripts.push(String(script));
        continue;
      }
      if (arg.startsWith('-e') && arg.length > 2) {
        scripts.push(arg.slice(2));
        continue;
      }
      if (arg.startsWith('-') && arg !== '-') throw shellError(`sed: unknown option: ${arg}`, 1);
      if (!scripts.length) scripts.push(arg);
      else files.push(arg);
    }
    if (!scripts.length) throw shellError('sed: no script', 1);
    let compiled = compileSedScripts(scripts, extended);
    let targets = [];
    if (!files.length) {
      if (stdin == null) throw shellError('sed: no paths given', 1);
      targets.push({ path: null, text: stdin });
    }
    for (let raw of files) {
      for (let path of await expandLocal(index, raw)) {
        let text = await readFile(index, path);
        if (text == null) throw shellError(`sed: no such file or directory: ${path}`, 1);
        targets.push({ path, text });
      }
    }
    let out = '';
    for (let target of targets) {
      let lines = target.text.split('\n');
      if (target.text.endsWith('\n')) lines.pop();
      let rebuilt = [];
      let chunk = '';
      for (let li = 0; li < lines.length; li++) {
        let lineNo = li + 1;
        let text = lines[li];
        for (let cmd of compiled) {
          if (cmd.kind === 'sub') text = text.replace(cmd.regex, cmd.repl);
        }
        rebuilt.push(text);
        let selected = false;
        for (let cmd of compiled) {
          if (cmd.kind === 'print' && lineNo >= cmd.start && lineNo <= cmd.end) selected = true;
        }
        if (!quiet) chunk += text + '\n';
        else if (selected) chunk += text + '\n';
      }
      if (inPlace && target.path) {
        if (inPlaceExt) await writeFile(index, target.path + inPlaceExt, target.text);
        let body = rebuilt.join('\n');
        if (target.text.endsWith('\n')) body += '\n';
        await writeFile(index, target.path, body);
      } else {
        out += chunk;
      }
    }
    return ok(out);
  }

  async function cmdWc(index, args, stdin) {
    let parsed = parseOpts(args, { l: 'bool', w: 'bool', c: 'bool' });
    let texts = [];
    if (!parsed.rest.length) {
      if (stdin == null) throw shellError('wc: no paths given', 1);
      texts.push(['', stdin]);
    }
    for (let raw of parsed.rest) {
      if (raw === '-') {
        texts.push(['', stdin || '']);
        continue;
      }
      for (let path of await expandLocal(index, raw)) {
        let text = await readFile(index, path);
        if (text == null) throw shellError(`wc: no such file or directory: ${path}`, 1);
        texts.push([path, text]);
      }
    }
    let wantLines = !!parsed.opts.l;
    let wantWords = !!parsed.opts.w;
    let wantChars = !!parsed.opts.c;
    if (!wantLines && !wantWords && !wantChars) {
      wantLines = true;
      wantWords = true;
      wantChars = true;
    }
    let fields = [];
    if (wantLines) fields.push('l');
    if (wantWords) fields.push('w');
    if (wantChars) fields.push('c');
    let out = '';
    let totals = { l: 0, w: 0, c: 0 };
    let fileCount = 0;
    for (let [path, text] of texts) {
      let counts = {
        l: (text.match(/\n/g) || []).length,
        w: text.split(/\s+/).filter(Boolean).length,
        c: text.length,
      };
      totals.l += counts.l;
      totals.w += counts.w;
      totals.c += counts.c;
      if (path) fileCount += 1;
      out += fields.map(field => counts[field]).join(' ');
      if (path) out += ' ' + path;
      out += '\n';
    }
    if (fileCount >= 2) {
      out += fields.map(field => totals[field]).join(' ') + ' total\n';
    }
    return ok(out);
  }

  async function cmdWf(args) {
    void args;
    return {
      code: 1,
      stdout: '',
      stderr:
        'wf: not available in Tehboxen (use the desktop apps / VFS shell instead)\n',
    };
  }

  /** Exported env as a plain object (what child processes inherit). */
  function exportedEnv() {
    let out = {};
    for (let k of exported) if (Object.prototype.hasOwnProperty.call(env, k)) out[k] = String(env[k]);
    out.PWD = cwd ? '/' + cwd : '/';
    return out;
  }

  /** Run a command line in a fresh shell as the same user (child_process). */
  async function subshell(cmdline, opts = {}) {
    let sh = createShell(fs, { wfCursor, wfOptions, home: HOME, ppid: shellPid });
    await sh.become(actor.name);
    for (let [k, v] of Object.entries(opts.env || exportedEnv())) sh.setVar(k, v, true);
    if (opts.cwd) {
      let r = await sh.run('cd ' + shellQuote(String(opts.cwd)));
      if (r.code) return r;
    }
    let script = String(cmdline);
    if (opts.stdin) {
      let tag = '__TEHBOXEN_STDIN_' + Math.random().toString(36).slice(2, 8).toUpperCase() + '__';
      script += ` <<'${tag}'\n${String(opts.stdin).replace(/\n$/, '')}\n${tag}`;
    }
    return sh.run(script);
  }

  /** Follow symlinks (VFS keys, no leading slash). */
  async function realKey(key, depth = 0) {
    if (depth > 40) throw shellError(`${key}: Too many levels of symbolic links`, 1);
    let parts = key.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      if (await vfsIsSymlink(acc).catch(() => false)) {
        let target = resolveLinkTarget(acc, await vfsReadlink(acc));
        let rest = parts.slice(i + 1).join('/');
        return realKey(rest ? target + '/' + rest : target, depth + 1);
      }
    }
    return acc;
  }

  /** `./script`, `/abs/bin`, or a name found in $PATH (e.g. node_modules/.bin during npm run). */
  async function findExecutable(index, name) {
    let candidates = name.includes('/')
      ? [resolvePath(cwd, name, HOME)]
      : String(env.PATH || '').split(':').filter(Boolean).map((d) => resolvePath(cwd, d.replace(/\/+$/, '') + '/' + name, HOME));
    for (let c of candidates) {
      let real;
      try {
        real = await realKey(c);
      } catch {
        continue;
      }
      if (real && (await existsFile(index, real)) && !(await isDir(index, real))) return { path: c, real };
      if (name.includes('/') && real && (await isDir(index, real))) throw shellError(`${name}: Is a directory`, 126);
    }
    if (name.includes('/')) throw shellError(`${name}: No such file or directory`, 127);
    return null;
  }

  async function runExecutable(index, exe, args, stdin) {
    try {
      await requireExec(exe.real);
      await requireRead(exe.real);
    } catch {
      throw shellError(`${exe.path.replace(/^(?!\/)/, '/')}: Permission denied`, 126);
    }
    let text = (await readFile(index, exe.real)) || '';
    // WebAssembly: run it as a WASI preview1 program in a node process.
    if (text.startsWith('\u0000asm')) {
      return cmdNode(['-e', WASM_RUNNER, '/' + exe.real, '/' + exe.path.replace(/^\/+/, ''), ...args.map((a) => String(a ?? ''))], stdin, exe.path.split('/').pop());
    }
    // Native executables (ELF and friends) can't run here, same message as bash on a foreign binary.
    if (/^(\x7fELF|MZ|\xcf\xfa\xed\xfe|\xca\xfe\xba\xbe)/.test(text) || text.slice(0, 1024).includes('\u0000')) {
      throw shellError(`/${exe.real}: cannot execute binary file: Exec format error`, 126);
    }
    let first = text.split('\n', 1)[0];
    let argv = args.map((a) => String(a ?? ''));
    if (/^#!.*\bnode\b/.test(first) || (!first.startsWith('#!') && /\.(c|m)?js$/.test(exe.real))) {
      // A node script needs the nodejs package (WASI programs above don't: they only borrow its workers).
      let missing = await requirePackage('node');
      if (missing) return { ...missing, stderr: `/${exe.real}: node: No such file or directory\n` + missing.stderr };
      return cmdNode(['/' + exe.real, ...argv], stdin);
    }
    if (first.startsWith('#!') && !/\b(sh|bash|boxsh|dash|zsh)\b/.test(first)) {
      throw shellError(`/${exe.real}: ${first.slice(2).trim().split(/\s+/)[0]}: bad interpreter: No such file or directory`, 126);
    }
    // Shell script: run in a subshell with $0/$1… set.
    let sh = createShell(fs, { wfCursor, wfOptions, home: HOME, ppid: shellPid });
    await sh.become(actor.name);
    for (let [k, v] of Object.entries(exportedEnv())) sh.setVar(k, v, true);
    await sh.run('cd ' + shellQuote(cwd ? '/' + cwd : '/'));
    await sh.run('set -- ' + argv.map(shellQuote).join(' '));
    let script = text;
    if (stdin != null) {
      let tag = '__TEHBOXEN_STDIN_' + Math.random().toString(36).slice(2, 8).toUpperCase() + '__';
      script = `{\n${text}\n} <<'${tag}'\n${String(stdin instanceof Uint8Array ? new TextDecoder().decode(stdin) : stdin).replace(/\n$/, '')}\n${tag}`;
    }
    let live = liveSink && stageCtx.tail && !stageCtx.redirected ? liveSink : null;
    let unlink = linkInterrupt(sh);
    try {
      let r = live ? await sh.withLive(live, () => sh.run(script)) : await sh.withLive(null, () => sh.run(script));
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    } finally {
      unlink();
    }
  }

  /** Ctrl-C / kill on this shell's running command reaches a child shell's command too. */
  function linkInterrupt(child) {
    let signal = runAbort?.signal;
    if (!signal) return () => {};
    let onAbort = () => child.interrupt(signal.reason?.signal || 'SIGINT');
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  /**
   * bash / sh / boxsh: run a command string (-c), a script file, or a script on
   * stdin in a child shell; with none of those on a terminal, start a nested
   * interactive shell there (exit returns to this one).
   *   bash [-eux…] [-c command [name [args…]]] | [script [args…]]
   */
  async function cmdBash(index, name, args, stdin) {
    let cmdMode = false;
    let readStdin = false;
    let flags = [];
    let i = 0;
    for (; i < args.length; i++) {
      let a = String(args[i]);
      if (a === '--') {
        i++;
        break;
      }
      if (a === '--version') return ok(`GNU bash, version 5.2.21(1)-release (wasm32-tehboxen)\nThis is boxsh, the Tehboxen shell.\n`);
      if (a === '--help') return ok(`Usage: ${name} [option] [-c command [name [args]] | script [args]]\nOptions: -c -e -u -x -f -C -s -i -l --login --norc --noprofile --posix --version\n`);
      if (['--login', '--norc', '--noprofile', '--posix', '--noediting', '--rcfile'].includes(a)) {
        if (a === '--rcfile') i++;
        continue;
      }
      if (/^-[A-Za-z]+$/.test(a)) {
        for (let ch of a.slice(1)) {
          if (ch === 'c') cmdMode = true;
          else if (ch === 's') readStdin = true;
          else if ('euxfC'.includes(ch)) flags.push(ch);
          else if (ch === 'o') i++;
          else if (!'ilrv'.includes(ch)) return { code: 2, stdout: '', stderr: `${name}: -${ch}: invalid option\n` };
        }
        continue;
      }
      if (/^\+[A-Za-z]+$/.test(a)) continue;
      break;
    }
    let rest = args.slice(i).map((a) => String(a ?? ''));
    let script;
    let argv0 = name;
    let positionals = rest;
    let scriptStdin = stdin;
    let live = liveSink && stageCtx.tail && !stageCtx.redirected ? liveSink : null;
    if (cmdMode) {
      if (!rest.length) return { code: 2, stdout: '', stderr: `${name}: -c: option requires an argument\n` };
      script = rest[0];
      argv0 = rest[1] ?? name;
      positionals = rest.slice(2);
    } else if (rest.length && !readStdin) {
      let key = resolvePath(cwd, rest[0], HOME);
      if (!(await pathExists(index, key))) return { code: 127, stdout: '', stderr: `${name}: ${rest[0]}: No such file or directory\n` };
      if (await isDir(index, key)) return { code: 126, stdout: '', stderr: `${name}: ${rest[0]}: Is a directory\n` };
      try {
        await requireRead(key);
      } catch {
        return { code: 126, stdout: '', stderr: `${name}: ${rest[0]}: Permission denied\n` };
      }
      script = (await readFile(index, key)) || '';
      if (script.startsWith('#!')) script = script.slice(script.indexOf('\n') + 1);
      argv0 = rest[0];
      positionals = rest.slice(1);
    } else if (stdin != null) {
      script = String(stdin);
      scriptStdin = null;
    } else if (live?.tty?.nested) {
      // Interactive: a nested session on the same terminal.
      let sh = createShell(fs, { wfCursor, wfOptions, home: HOME, ppid: shellPid, interactive: true, argv0: name });
      await sh.become(actor.name);
      for (let [k, v] of Object.entries(exportedEnv())) sh.setVar(k, v, true);
      sh.setVar('SHLVL', String((Number(env.SHLVL) || 1) + 1), true);
      await sh.run('cd ' + shellQuote(cwd ? '/' + cwd : '/'));
      sh.setBackgroundSink(bgSink);
      await sh.loadRc();
      let code = await live.tty.nested(sh);
      return { code: code ?? 0, stdout: '', stderr: '' };
    } else {
      return ok('');
    }

    let sh = createShell(fs, { wfCursor, wfOptions, home: HOME, ppid: shellPid, argv0 });
    await sh.become(actor.name);
    for (let [k, v] of Object.entries(exportedEnv())) sh.setVar(k, v, true);
    sh.setVar('SHLVL', String((Number(env.SHLVL) || 1) + 1), true);
    await sh.run('cd ' + shellQuote(cwd ? '/' + cwd : '/'));
    await sh.run('set -- ' + positionals.map(shellQuote).join(' '));
    if (flags.length) await sh.run('set -' + flags.join(''));
    if (scriptStdin != null) {
      let tag = '__TEHBOXEN_STDIN_' + Math.random().toString(36).slice(2, 8).toUpperCase() + '__';
      script = `{\n${script}\n} <<'${tag}'\n${String(scriptStdin).replace(/\n$/, '')}\n${tag}`;
    }
    let unlink = linkInterrupt(sh);
    try {
      let r = await sh.withLive(live, () => sh.run(script));
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    } finally {
      unlink();
    }
  }

  /** clang / wasm-ld / llvm tools: run in a node worker on the VFS (other/node/clang.js). */
  async function cmdTool(name, args, stdin) {
    let { runNode } = await import('./node/node.js');
    let live = liveSink && stageCtx.tail && !stageCtx.redirected ? liveSink : null;
    return runNode([], {
      cwd: cwd ? '/' + cwd : '/',
      env: exportedEnv(),
      actor: { ...actor, gids: [...(actor.gids || [])] },
      stdin: stdin ?? null,
      signal: runAbort?.signal,
      live,
      exec: subshell,
      pid: takePid(),
      ppid: shellPid,
      tool: { name, args: args.map((a) => String(a ?? '')) },
    });
  }

  /**
   * Commands from system packages (git, clang…) run only once the package is
   * installed. Returns a command-not-found result with the install hint, or null.
   */
  /**
   * If `name` comes from a baked package (busybox) that isn't installed yet, wait for the
   * boot-time install — drawing pkg's progress bar on a terminal, cleared when done.
   * True when it waited (the caller looks the command up again).
   */
  async function awaitBaked(name) {
    let { packageFor, PACKAGES, isInstalled, ensureBaked, installJob } = await import('./packages.js');
    let base = name.split('/').pop();
    let pkg = packageFor(base);
    if (!pkg || !PACKAGES[pkg].baked) return false;
    if (await isInstalled(pkg)) return false;
    let live = liveSink && stageCtx.tail && !stageCtx.redirected ? liveSink : null;
    let done = ensureBaked();
    let finished = false;
    done.finally(() => (finished = true));
    // The run may still be checking what's installed: give it a moment to start the job.
    let job = installJob(pkg);
    for (let i = 0; !job && !finished && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 20));
      job = installJob(pkg);
    }
    if (live && job) {
      let { progressLine } = await import('./pkg.js');
      let drawn = false;
      let lastAt = 0;
      let show = (ev) => {
        if (!ev) return;
        let now = performance.now();
        if (now - lastAt < 50 && !(ev.total && ev.done >= ev.total)) return;
        lastAt = now;
        live.out(`${drawn ? '' : '\x1b[?25l'}\r\x1b[2K${progressLine(`${pkg}:`, ev, Number(live.columns) || 80)}`);
        drawn = true;
      };
      show(job.last());
      job.listeners.add(show);
      try {
        await done;
      } finally {
        job.listeners.delete(show);
        if (drawn) live.out('\r\x1b[2K\x1b[?25h');
      }
    } else await done;
    return true;
  }

  async function requirePackage(name) {
    let { packageFor, isInstalled } = await import('./packages.js');
    let pkg = packageFor(name);
    if (!pkg || (await isInstalled(pkg))) return null;
    return { code: 127, stdout: '', stderr: `Command '${name}' not found, but can be installed with:\n  sudo pkg install ${pkg}\n` };
  }

  /** pkg: the package manager (other/pkg.js). */
  /** read [-r] [-p prompt] [-t secs] [name…]: one line from stdin (a loop cursor, a pipe, or the terminal). */
  async function cmdRead(args, stdin) {
    let raw = false;
    let prompt = '';
    let timeout = null;
    let names = [];
    for (let i = 0; i < args.length; i++) {
      let a = String(args[i]);
      if (a === '-r') raw = true;
      else if (a === '-p') prompt = String(args[++i] ?? '');
      else if (a === '-t') timeout = Number(args[++i]);
      else if (a === '-s' || a === '-e') continue;
      else names.push(a);
    }
    if (!names.length) names = ['REPLY'];
    let line = null;
    if (stdin && typeof stdin === 'object' && stdin.cursor) {
      if (stdin.pos < stdin.text.length) {
        let nl = stdin.text.indexOf('\n', stdin.pos);
        line = nl === -1 ? stdin.text.slice(stdin.pos) : stdin.text.slice(stdin.pos, nl);
        stdin.pos = nl === -1 ? stdin.text.length : nl + 1;
      }
    } else if (stdin != null) {
      let text = String(stdin);
      if (text.length) line = text.split('\n')[0];
    } else if (liveSink?.tty?.attachProcess) {
      if (prompt) liveSink.err(prompt);
      let tty = liveSink.tty.attachProcess();
      try {
        let bytes = [];
        let deadline = timeout != null ? Date.now() + timeout * 1000 : null;
        for (;;) {
          if (deadline != null && !(await tty.poll(Math.max(0, deadline - Date.now())))) break;
          let b = await tty.read(4096);
          if (!b.length) break;
          bytes.push(...b);
          if (bytes.includes(10)) break;
        }
        let text = new TextDecoder().decode(new Uint8Array(bytes));
        if (text.length) line = text.replace(/\n$/, '');
      } finally {
        tty.detach();
      }
    }
    if (line == null) {
      for (let n of names) setVar(n, '', false);
      return { code: 1, stdout: '', stderr: '' };
    }
    if (!raw) line = line.replace(/\\(.)/g, '$1');
    let fields = line.replace(/^[ \t]+/, '').split(/[ \t]+/);
    names.forEach((n, i) => setVar(n, i === names.length - 1 ? fields.slice(i).join(' ').replace(/[ \t]+$/, '') : fields[i] ?? '', false));
    return ok('');
  }

  /** ip, iptables*, ss, netstat, hostname, sysctl, conntrack (other/net/commands.js). */
  async function cmdNet(index, name, args, stdin) {
    let { runNetCommand } = await import('./net/commands.js');
    let { writeMany } = await import('./vfs.js');
    return runNetCommand(name, args.map((a) => String(a ?? '')), {
      uid: actor.uid,
      stdin,
      readFile: (p) => readFile(index, resolvePath(cwd, String(p), HOME)),
      writeFile: (abs, text) => writeMany([{ path: String(abs).replace(/^\/+/, ''), data: text, mode: 0o644, uid: 0, gid: 0 }], { uid: 0, gid: 0 }),
    });
  }

  async function cmdPkg(args) {
    let { runPkg } = await import('./pkg.js');
    let live = liveSink && stageCtx.tail && !stageCtx.redirected ? liveSink : null;
    return runPkg(args.map((a) => String(a ?? '')), { actor: { ...actor }, live });
  }

  /** git: isomorphic-git on the VFS (other/git/git.js). */
  async function cmdGit(args, index) {
    let { runGit } = await import('./git/git.js');
    let live = liveSink && stageCtx.tail && !stageCtx.redirected ? liveSink : null;
    try {
      return await runGit(args.map((a) => String(a ?? '')), {
        cwd: cwd ? '/' + cwd : '/',
        env: exportedEnv(),
        actor: { ...actor, gids: [...(actor.gids || [])] },
        exec: subshell,
        live,
      });
    } finally {
      index.invalidate?.();
    }
  }

  async function cmdNpm(name, args, stdin, index) {
    let { runNpm } = await import('./npm/npm.js');
    let live = liveSink && stageCtx.tail && !stageCtx.redirected ? liveSink : null;
    try {
      return await runNpm(args.map((a) => String(a ?? '')), {
        cwd: cwd ? '/' + cwd : '/',
        env: exportedEnv(),
        actor: { ...actor, gids: [...(actor.gids || [])] },
        exec: subshell,
        live,
        npx: name === 'npx',
      });
    } finally {
      index.invalidate?.();
    }
  }

  async function cmdNode(args, stdin, name = 'node') {
    let { runNode } = await import('./node/node.js');
    let live = liveSink && stageCtx.tail && !stageCtx.redirected ? liveSink : stageCtx.fileSink || null;
    return runNode(args.map((a) => String(a ?? '')), {
      cwd: cwd ? '/' + cwd : '/',
      env: exportedEnv(),
      actor: { ...actor, gids: [...(actor.gids || [])] },
      stdin: stdin ?? null,
      signal: runAbort?.signal,
      live,
      exec: subshell,
      pid: takePid(),
      ppid: shellPid,
      name,
    });
  }

  let BUILTINS = ['pwd', 'cd', 'ls', 'grep', 'cat', 'mkdir', 'rm', 'mv', 'cp', 'ln', 'addcontact', 'echo', 'printf', 'head', 'tail', 'find', 'sed', 'wc', 'touch', 'wf', 'export', 'unset', 'printenv', 'env', 'set', 'source', '.', 'whoami', 'id', 'groups', 'su', 'sudo', 'useradd', 'userdel', 'groupadd', 'groupdel', 'usermod', 'chmod', 'chown', 'chgrp', 'passwd', 'umask', 'true', 'false', ':', 'jobs', 'wait', 'fg', 'bg', 'kill', 'sleep', 'exit', 'test', '[', 'shift', 'type', 'which', 'command', 'basename', 'dirname', 'date', 'seq', 'bash', 'sh', 'boxsh', 'pkg', 'read', 'local', 'return', 'break', 'continue', ...NET_COMMANDS];

  async function cmdSleep(args) {
    if (!args.length) throw shellError('sleep: missing operand', 1);
    let total = 0;
    for (let a of args) {
      let m = /^(\d*\.?\d+)([smhd]?)$/.exec(String(a));
      if (!m) throw shellError(`sleep: invalid time interval '${a}'`, 1);
      total += Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2]]);
    }
    let signal = runAbort?.signal;
    let interrupted = await new Promise((resolve) => {
      let t = setTimeout(() => resolve(null), total * 1000);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve(signal.reason?.signal || 'SIGINT');
      }, { once: true });
    });
    if (interrupted) return { code: 128 + (SIGNALS[String(interrupted).replace(/^SIG/, '')] || 2), stdout: '', stderr: '' };
    return ok('');
  }

  async function cmdTest(index, name, args) {
    let a = args.map(String);
    if (name === '[') {
      if (a[a.length - 1] !== ']') throw shellError("[: missing `]'", 2);
      a = a.slice(0, -1);
    }
    let pathTest = async (op, raw) => {
      let path = resolvePath(cwd, raw, HOME);
      let st = await vfsGetStat(path);
      let exists = (await isDir(index, path)) || (await existsFile(index, path));
      if (op === '-e') return exists;
      if (op === '-f') return exists && !(await isDir(index, path));
      if (op === '-d') return await isDir(index, path);
      if (op === '-s') return exists && !(await isDir(index, path)) && ((await readFile(index, path)) || '').length > 0;
      if (op === '-L' || op === '-h') return typeof fs.isSymlink === 'function' && (await fs.isSymlink(path));
      let want = { '-r': 'r', '-w': 'w', '-x': 'x' }[op];
      if (want) {
        if (!exists) return false;
        try {
          await assertAccess(path, want, actor);
          return true;
        } catch {
          return false;
        }
      }
      void st;
      return null;
    };
    let evalExpr = async (t) => {
      if (!t.length) return false;
      if (t[0] === '!') return !(await evalExpr(t.slice(1)));
      let oi = t.findIndex((x, i) => i > 0 && (x === '-o'));
      if (oi > 0) return (await evalExpr(t.slice(0, oi))) || (await evalExpr(t.slice(oi + 1)));
      let ai = t.findIndex((x, i) => i > 0 && (x === '-a'));
      if (ai > 0) return (await evalExpr(t.slice(0, ai))) && (await evalExpr(t.slice(ai + 1)));
      if (t.length === 1) return t[0] !== '';
      if (t.length === 2) {
        if (t[0] === '-z') return t[1] === '';
        if (t[0] === '-n') return t[1] !== '';
        let r = await pathTest(t[0], t[1]);
        if (r === null) throw shellError(`${name}: ${t[0]}: unary operator expected`, 2);
        return r;
      }
      if (t.length === 3) {
        let [x, op, y] = t;
        if (op === '=' || op === '==') return x === y;
        if (op === '!=') return x !== y;
        let num = { '-eq': (p, q) => p === q, '-ne': (p, q) => p !== q, '-lt': (p, q) => p < q, '-le': (p, q) => p <= q, '-gt': (p, q) => p > q, '-ge': (p, q) => p >= q }[op];
        if (num) {
          if (!/^-?\d+$/.test(x) || !/^-?\d+$/.test(y)) throw shellError(`${name}: integer expression expected`, 2);
          return num(Number(x), Number(y));
        }
        if (op === '<') return x < y;
        if (op === '>') return x > y;
      }
      throw shellError(`${name}: too many arguments`, 2);
    };
    return { code: (await evalExpr(a)) ? 0 : 1, stdout: '', stderr: '' };
  }

  async function cmdType(index, name, args) {
    let out = '';
    let err = '';
    let code = 0;
    for (let a of args.map(String)) {
      if (BUILTINS.includes(a)) {
        if (name === 'type') out += `${a} is a shell builtin\n`;
        else if (name === 'which') out += `/bin/${a}\n`;
        else out += `${a}\n`;
        continue;
      }
      // Programs on $PATH (installed packages, npm bins, scripts).
      let exe = await findExecutable(index, a).catch(() => null);
      if (!exe) {
        code = 1;
        if (name === 'type') err += `${name}: ${a}: not found\n`;
        continue;
      }
      let path = '/' + exe.path.replace(/^\/+/, '');
      out += name === 'type' ? `${a} is ${path}\n` : `${path}\n`;
    }
    return { code, stdout: out, stderr: err };
  }

  function cmdBasename(args) {
    let a = args.map(String).filter((x) => x !== '--');
    if (!a.length) throw shellError('basename: missing operand', 1);
    let base = a[0].replace(/\/+$/, '').split('/').pop() || '/';
    if (a[1] && base !== a[1] && base.endsWith(a[1])) base = base.slice(0, -a[1].length);
    return ok(base + '\n');
  }

  function cmdDirname(args) {
    let a = args.map(String).filter((x) => x !== '--');
    if (!a.length) throw shellError('dirname: missing operand', 1);
    return ok(a.map((p) => {
      let t = p.replace(/\/+$/, '');
      if (!t) return '/';
      let i = t.lastIndexOf('/');
      return i === -1 ? '.' : t.slice(0, i) || '/';
    }).join('\n') + '\n');
  }

  function cmdDate(args) {
    let d = new Date();
    let utc = args.includes('-u') || args.includes('--utc');
    let fmt = args.find((a) => String(a).startsWith('+'));
    let pad = (n, w = 2) => String(n).padStart(w, '0');
    let get = (k) => (utc ? d['getUTC' + k]() : d['get' + k]());
    let DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    let tz = utc ? 'UTC' : (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
    let f = {
      Y: () => get('FullYear'), m: () => pad(get('Month') + 1), d: () => pad(get('Date')), H: () => pad(get('Hours')), M: () => pad(get('Minutes')), S: () => pad(get('Seconds')),
      s: () => Math.floor(d.getTime() / 1000), N: () => pad(d.getMilliseconds() * 1e6, 9), a: () => DAYS[get('Day')], b: () => MONTHS[get('Month')], y: () => pad(get('FullYear') % 100), Z: () => tz,
      F: () => `${get('FullYear')}-${pad(get('Month') + 1)}-${pad(get('Date'))}`, T: () => `${pad(get('Hours'))}:${pad(get('Minutes'))}:${pad(get('Seconds'))}`, '%': () => '%', n: () => '\n', e: () => String(get('Date')).padStart(2, ' '),
    };
    if (fmt) return ok(String(fmt).slice(1).replace(/%(.)/g, (m, c) => (f[c] ? String(f[c]()) : m)) + '\n');
    return ok(`${f.a()} ${f.b()} ${f.e()} ${f.T()} ${f.Z()} ${f.Y()}\n`);
  }

  function cmdSeq(args) {
    let nums = args.map(String).filter((a) => !/^-[sw]$/.test(a));
    let sepIdx = args.indexOf('-s');
    let sep = sepIdx !== -1 ? String(args[sepIdx + 1] ?? '\n') : '\n';
    if (sepIdx !== -1) nums = args.map(String).filter((a, i) => i !== sepIdx && i !== sepIdx + 1);
    if (!nums.length || nums.length > 3 || nums.some((n) => !/^-?\d+(\.\d+)?$/.test(n))) throw shellError('seq: invalid arguments', 1);
    let [first, step, last] = nums.length === 1 ? [1, 1, Number(nums[0])] : nums.length === 2 ? [Number(nums[0]), 1, Number(nums[1])] : nums.map(Number);
    if (!step) throw shellError('seq: invalid Zero increment value', 1);
    let out = [];
    for (let x = first; step > 0 ? x <= last : x >= last; x += step) {
      out.push(String(x));
      if (out.length > 100000) break;
    }
    return ok(out.length ? out.join(sep) + '\n' : '');
  }

  function cmdWhoami(args) {
    void args;
    return ok(actor.name + '\n');
  }

  async function cmdId(args) {
    let targetName = args[0] ? String(args[0]) : actor.name;
    let a = args[0] ? await actorFromUser(targetName) : await actorFromUser(actor.name) || actor;
    if (!a) throw shellError(`id: '${targetName}': no such user`, 1);
    let groupsMap = await listGroups();
    let gPrimary = Object.values(groupsMap).find(g => Number(g.gid) === Number(a.gid));
    let gids = [...new Set([Number(a.gid), ...(a.gids || []).map(Number)])];
    let groupParts = [];
    for (let gid of gids) {
      let g = Object.values(groupsMap).find(x => Number(x.gid) === Number(gid));
      groupParts.push(`${gid}(${g ? g.name : gid})`);
    }
    return ok(
      `uid=${a.uid}(${a.name}) gid=${a.gid}(${gPrimary ? gPrimary.name : a.gid}) groups=${groupParts.join(',')}\n`,
    );
  }

  async function cmdGroups(args) {
    let name = args[0] ? String(args[0]) : actor.name;
    let u = await getUser(name);
    if (!u) throw shellError(`groups: '${name}': no such user`, 1);
    let gs = await groupsForUser(name);
    let names = [...new Set(gs.map(g => g.name))];
    let primary = Object.values(await listGroups()).find(g => Number(g.gid) === Number(u.gid));
    if (primary && !names.includes(primary.name)) names.unshift(primary.name);
    return ok(names.join(' ') + '\n');
  }

  async function cmdSu(args) {
    let login = false;
    let rest = [];
    for (let a of args) {
      if (a === '-') login = true;
      else rest.push(a);
    }
    if (!rest.length) throw shellError('su: user required', 1);
    let next = await actorFromUser(String(rest[0]));
    if (!next) throw shellError(`su: user ${rest[0]} does not exist`, 1);
    actor = next;
    syncActorEnv();
    syncPwd();
    if (login) {
      cwd = HOME;
      syncPwd();
    }
    return ok('');
  }

  async function cmdSudo(index, args, stdin, command) {
    if (!args.length) throw shellError('sudo: command required', 1);
    let gs = await groupsForUser(actor.name);
    if (!isRoot(actor.uid) && !gs.some((g) => g.name === 'sudo')) {
      throw shellError('sudo: Permission denied', 1);
    }
    let prev = {
      name: actor.name,
      uid: actor.uid,
      gid: actor.gid,
      gids: [...(actor.gids || [])],
      home: actor.home,
      shell: actor.shell,
    };
    let root = await actorFromUser('root');
    if (!root) throw shellError('sudo: user root does not exist', 1);
    actor = root;
    syncActorEnv();
    try {
      return await dispatch(
        index,
        String(args[0]),
        args.slice(1).map((a) => String(a)),
        stdin,
        command,
      );
    } finally {
      actor = prev;
      syncActorEnv();
      syncPwd();
    }
  }

  /** Switch actor to a VFS user (used by dbg RPC `user=` and app code). */
  async function become(username) {
    let next = await actorFromUser(String(username || ''));
    if (!next) throw shellError(`become: user ${username} does not exist`, 1);
    actor = next;
    syncActorEnv();
    cwd = HOME || '';
    syncPwd();
    return actor;
  }

  async function cmdUseradd(index, args) {
    requireRootCmd('useradd');
    let makeHome = false;
    let uidOpt = null;
    let groupOpt = null;
    let gecos = null;
    let name = null;
    for (let i = 0; i < args.length; i++) {
      let a = String(args[i] ?? '');
      if (a === '-m') makeHome = true;
      else if (a === '-u') {
        uidOpt = Number(args[++i]);
        if (Number.isNaN(uidOpt)) throw shellError('useradd: invalid user ID', 1);
      } else if (a === '-g') {
        groupOpt = args[++i];
        if (groupOpt == null) throw shellError('useradd: option requires an argument -- g', 1);
      } else if (a === '-c') {
        gecos = args[++i];
        if (gecos == null) throw shellError('useradd: option requires an argument -- c', 1);
      } else if (a.startsWith('-')) throw shellError(`useradd: invalid option -- '${a}'`, 1);
      else name = a;
    }
    if (!name) throw shellError('useradd: missing user name', 1);
    if (await getUser(name)) throw shellError(`useradd: user '${name}' already exists`, 1);
    let finalUid = uidOpt != null ? uidOpt : await nextUid();
    let finalGid;
    if (groupOpt != null) {
      let g = await resolveGroupRef(groupOpt);
      if (!g) throw shellError(`useradd: group '${groupOpt}' does not exist`, 1);
      finalGid = g.gid;
      if (!g.members?.includes(name)) {
        await saveGroup({ ...g, members: [...(g.members || []), name] });
      }
    } else {
      let existing = await getGroup(name);
      if (existing) finalGid = existing.gid;
      else {
        finalGid = await nextGid();
        await saveGroup({ name, gid: finalGid, members: [name] });
      }
    }
    let homePath = 'home/' + name;
    await saveUser({
      name,
      uid: finalUid,
      gid: finalGid,
      home: homePath,
      shell: '/bin/boxsh',
      gecos: gecos != null ? String(gecos) : name,
    });
    if (makeHome) {
      await writeKeep(index, homePath);
      await vfsSetStat(homePath, {
        kind: 'dir',
        mode: dirMode(),
        uid: finalUid,
        gid: finalGid,
      });
    }
    return ok('');
  }

  async function cmdUserdel(index, args) {
    requireRootCmd('userdel');
    let removeHome = false;
    let name = null;
    for (let a of args) {
      if (a === '-r') removeHome = true;
      else if (String(a).startsWith('-')) throw shellError(`userdel: invalid option -- '${a}'`, 1);
      else name = String(a);
    }
    if (!name) throw shellError('userdel: missing operand', 1);
    if (name === 'root' || name === actor.name || name === 'godshand' || name === 'nobody') {
      throw shellError(`userdel: cannot remove user ${name}`, 1);
    }
    let u = await getUser(name);
    if (!u) throw shellError(`userdel: user '${name}' does not exist`, 1);
    if (removeHome && u.home) {
      await fs.remove(String(u.home).replace(/^\/+/, '') + '/');
      dropPrefix(await index.all(), String(u.home).replace(/^\/+/, '') + '/');
    }
    await removeUser(name);
    return ok('');
  }

  async function cmdGroupadd(args) {
    requireRootCmd('groupadd');
    let gidOpt = null;
    let name = null;
    for (let i = 0; i < args.length; i++) {
      let a = String(args[i] ?? '');
      if (a === '-g') {
        gidOpt = Number(args[++i]);
        if (Number.isNaN(gidOpt)) throw shellError('groupadd: invalid group ID', 1);
      } else if (a.startsWith('-')) throw shellError(`groupadd: invalid option -- '${a}'`, 1);
      else name = a;
    }
    if (!name) throw shellError('groupadd: missing group name', 1);
    if (await getGroup(name)) throw shellError(`groupadd: group '${name}' already exists`, 1);
    let gid = gidOpt != null ? gidOpt : await nextGid();
    await saveGroup({ name, gid, members: [] });
    return ok('');
  }

  async function cmdGroupdel(args) {
    requireRootCmd('groupdel');
    let name = args[0] ? String(args[0]) : null;
    if (!name) throw shellError('groupdel: missing operand', 1);
    if (name === 'root' || name === 'sudo' || name === 'world') {
      throw shellError(`groupdel: cannot remove group ${name}`, 1);
    }
    if (!(await getGroup(name))) throw shellError(`groupdel: group '${name}' does not exist`, 1);
    await removeGroup(name);
    return ok('');
  }

  async function cmdUsermod(args) {
    requireRootCmd('usermod');
    let groupOpt = null;
    let homeOpt = null;
    let gecosOpt = null;
    let name = null;
    for (let i = 0; i < args.length; i++) {
      let a = String(args[i] ?? '');
      if (a === '-g') groupOpt = args[++i];
      else if (a === '-d') homeOpt = args[++i];
      else if (a === '-c') gecosOpt = args[++i];
      else if (a.startsWith('-')) throw shellError(`usermod: invalid option -- '${a}'`, 1);
      else name = a;
    }
    if (!name) throw shellError('usermod: missing user name', 1);
    let u = await getUser(name);
    if (!u) throw shellError(`usermod: user '${name}' does not exist`, 1);
    if (groupOpt != null) {
      let g = await resolveGroupRef(groupOpt);
      if (!g) throw shellError(`usermod: group '${groupOpt}' does not exist`, 1);
      u.gid = g.gid;
      if (!g.members?.includes(name)) {
        await saveGroup({ ...g, members: [...(g.members || []), name] });
      }
    }
    if (homeOpt != null) u.home = String(homeOpt).replace(/^\/+/, '');
    if (gecosOpt != null) u.gecos = String(gecosOpt);
    await saveUser(u);
    if (actor.name === name) {
      actor = await actorFromUser(name);
      syncActorEnv();
      syncPwd();
    }
    return ok('');
  }

  async function collectPaths(index, path, recursive) {
    let out = [];
    if (await isDir(index, path)) {
      out.push(path);
      if (recursive) {
        for (let p of await index.all()) {
          if (p === path + '/.keep' || p.startsWith(path + '/')) {
            if (isKeep(p)) {
              let dir = p.slice(0, -'/.keep'.length);
              if (dir && !out.includes(dir)) out.push(dir);
            } else if (!out.includes(p)) out.push(p);
          }
        }
      }
    } else if (await existsFile(index, path)) {
      out.push(path);
    }
    return out;
  }

  async function cmdChmod(index, args) {
    let parsed = parseOpts(args, { R: 'bool' });
    if (parsed.rest.length < 2) throw shellError('chmod: missing operand', 1);
    let modeSpec = parsed.rest[0];
    let targets = parsed.rest.slice(1);
    for (let raw of targets) {
      let path = resolvePath(cwd, raw, HOME);
      if (!(await pathExists(index, path))) {
        throw shellError(`chmod: cannot access '${raw}': No such file or directory`, 1);
      }
      let paths = await collectPaths(index, path, parsed.opts.R);
      for (let p of paths) {
        await requireOwnerOrRoot(p, 'chmod');
        let st = await vfsGetStat(p);
        let current = st?.mode ?? DEFAULT_FILE_MODE;
        let next;
        try {
          next = parseModeSpec(modeSpec, current);
        } catch (err) {
          throw shellError(`chmod: ${err.message}`, 1);
        }
        await vfsSetStat(p, { mode: next, kind: st?.kind || ((await isDir(index, p)) ? 'dir' : 'file') });
      }
    }
    return ok('');
  }

  async function cmdChown(index, args) {
    let parsed = parseOpts(args, { R: 'bool' });
    if (parsed.rest.length < 2) throw shellError('chown: missing operand', 1);
    let spec = String(parsed.rest[0]);
    let userPart = spec;
    let groupPart = null;
    let colon = spec.indexOf(':');
    if (colon === -1) colon = spec.indexOf('.');
    if (colon !== -1) {
      userPart = spec.slice(0, colon);
      groupPart = spec.slice(colon + 1) || null;
    }
    let user = userPart ? await resolveUserRef(userPart) : null;
    if (userPart && !user) throw shellError(`chown: invalid user: '${userPart}'`, 1);
    let group = groupPart != null && groupPart !== '' ? await resolveGroupRef(groupPart) : null;
    if (groupPart && !group) throw shellError(`chown: invalid group: '${groupPart}'`, 1);
    for (let raw of parsed.rest.slice(1)) {
      let path = resolvePath(cwd, raw, HOME);
      if (!(await pathExists(index, path))) {
        throw shellError(`chown: cannot access '${raw}': No such file or directory`, 1);
      }
      let paths = await collectPaths(index, path, parsed.opts.R);
      for (let p of paths) {
        await requireOwnerOrRoot(p, 'chown');
        let patch = {};
        if (user) {
          patch.uid = user.uid;
          if (groupPart == null) patch.gid = user.gid;
        }
        if (group) patch.gid = group.gid;
        await vfsSetStat(p, patch);
      }
    }
    return ok('');
  }

  async function cmdChgrp(index, args) {
    let parsed = parseOpts(args, { R: 'bool' });
    if (parsed.rest.length < 2) throw shellError('chgrp: missing operand', 1);
    let group = await resolveGroupRef(parsed.rest[0]);
    if (!group) throw shellError(`chgrp: invalid group: '${parsed.rest[0]}'`, 1);
    for (let raw of parsed.rest.slice(1)) {
      let path = resolvePath(cwd, raw, HOME);
      if (!(await pathExists(index, path))) {
        throw shellError(`chgrp: cannot access '${raw}': No such file or directory`, 1);
      }
      let paths = await collectPaths(index, path, parsed.opts.R);
      for (let p of paths) {
        await requireOwnerOrRoot(p, 'chgrp');
        await vfsSetStat(p, { gid: group.gid });
      }
    }
    return ok('');
  }

  function cmdPasswd(args) {
    void args;
    return ok('Tehboxen has no passwords\n');
  }

  function cmdUmask(args) {
    if (!args.length) {
      return ok((umaskVal & 0o777).toString(8).padStart(4, '0') + '\n');
    }
    let spec = String(args[0]);
    if (!/^[0-7]{1,4}$/.test(spec)) throw shellError(`umask: ${spec}: octal number expected`, 1);
    umaskVal = parseInt(spec, 8) & 0o777;
    return ok('');
  }

  async function writeFile(index, path, text) {
    if (path === 'dev/null') return;
    await ensureParents(index, path);
    let existed = await existsFile(index, path);
    if (existed) await requireWrite(path);
    else await requireWriteCreate(path);
    if (existed) {
      await fs.write(path, text);
    } else {
      await fs.write(path, text, {
        uid: actor.uid,
        gid: actor.gid,
        mode: fileMode(),
      });
    }
    (await index.all()).add(path);
  }

  async function writeKeep(index, dir, modeOverride) {
    let keep = dir + '/.keep';
    let paths = await index.all();
    if (paths.has(keep)) return;
    await ensureParents(index, keep);
    await requireWriteCreate(keep);
    let mode = modeOverride != null ? (modeOverride & ~umaskVal) & 0o777 : dirMode();
    // .keep shares the directory stat — pass directory mode/owner
    await fs.write(keep, '', {
      uid: actor.uid,
      gid: actor.gid,
      mode,
      kind: 'dir',
    });
    paths.add(keep);
  }

  async function ensureParents(index, path) {
    let parts = path.split('/');
    parts.pop();
    let acc = [];
    let paths = await index.all();
    for (let part of parts) {
      acc.push(part);
      let dir = acc.join('/');
      let keep = dir + '/.keep';
      if (paths.has(keep)) continue;
      let parent = parentOf(dir);
      if (!isRoot(actor.uid) && parent) {
        await assertAccess(parent, 'w', actor);
        await assertAccess(parent, 'x', actor);
      }
      await fs.write(keep, '', {
        uid: actor.uid,
        gid: actor.gid,
        mode: dirMode(),
        kind: 'dir',
      });
      paths.add(keep);
    }
  }

  async function readFile(index, path) {
    if (!(await existsFile(index, path))) return null;
    await requireRead(path);
    return await fs.read(path);
  }

  /** A file's exact bytes (binary-safe), or null. */
  async function readFileBytes(index, path) {
    if (!(await existsFile(index, path))) return null;
    await requireRead(path);
    let { withLock, readBlob } = await import('./vfs.js');
    let blob = await withLock(path, (lease) => readBlob(path, { lease }), { mode: 'r' });
    return blob ? new Uint8Array(await blob.arrayBuffer()) : new Uint8Array(0);
  }

  async function existsFile(index, path) {
    if (!path || isDirPath(path)) return false;
    return (await index.all()).has(path);
  }

  async function isDir(index, path) {
    if (!path) return true;
    let prefix = path + '/';
    for (let item of await index.all()) {
      if (item.startsWith(prefix)) return true;
    }
    return false;
  }

  async function listDir(index, dir, showKeep) {
    let prefix = dir ? dir + '/' : '';
    let entries = new Map();
    for (let path of await index.all()) {
      if (prefix && !path.startsWith(prefix)) continue;
      if (!prefix && path.startsWith('/')) continue;
      let rest = prefix ? path.slice(prefix.length) : path;
      if (!rest) continue;
      let slash = rest.indexOf('/');
      if (slash === -1) {
        if (rest === '.keep' && !showKeep) continue;
        if (!entries.has(rest)) entries.set(rest, 'file');
      } else {
        entries.set(rest.slice(0, slash), 'dir');
      }
    }
    return [...entries.entries()]
      .map(([name, kind]) => ({ name, kind }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  async function filesUnder(index, dir) {
    let prefix = dir ? dir + '/' : '';
    let files = [];
    for (let path of await index.all()) {
      if (prefix && !path.startsWith(prefix)) continue;
      if (isKeep(path)) continue;
      if (await isDir(index, path)) continue;
      files.push(path);
    }
    return files.sort();
  }

  syncActorEnv();
  syncPwd();

  return {
    get cwd() { return cwd; },
    get home() { return HOME; },
    get env() { return env; },
    get status() { return lastStatus; },
    get user() { return actor.name; },
    get uid() { return actor.uid; },
    getActor() { return { ...actor, gids: [...(actor.gids || [])] }; },
    run,
    loadRc,
    become,
    /** Stream output of long-running commands while `fn` runs (Terminal). */
    async withLive(sink, fn) {
      let prev = liveSink;
      let prevAbort = runAbort;
      liveSink = sink;
      runAbort = new AbortController();
      try {
        return await fn();
      } finally {
        liveSink = prev;
        runAbort = prevAbort;
      }
    },
    /** Ctrl-C / kill: signal the running command (node receives it as a process signal). */
    interrupt(sig = 'SIGINT') {
      runAbort?.abort({ signal: sig });
    },
    /** Where background jobs write their output (the Terminal); null buffers it for wait/fg. */
    setBackgroundSink(fn) {
      bgSink = fn;
    },
    /** Finished background jobs since the last call, as bash-style "[1]+  Done  cmd" lines. */
    takeNotices() {
      let done = notices.filter((j) => j.state !== 'Running');
      notices = notices.filter((j) => j.state === 'Running');
      for (let j of done) jobs.delete(j.id);
      return done.map((j) => jobLine(j, '+'));
    },
    get pid() { return shellPid; },
    setVar,
    expandWord,
  };
}

export function formatResult(result) {
  let text = result.stdout || '';
  if (result.stderr) text += result.stderr;
  if (text.length > 40000) text = text.slice(0, 40000) + '\n… output truncated\n';
  if (!text) text = result.code ? `exit ${result.code}\n` : '';
  return text;
}

/**
 * The shell's view of which paths exist (VFS keys, directories as `dir/.keep`),
 * built on demand from the live directory index (other/node/host.js), which is
 * kept current by VFS change events: no per-command snapshot, so changes made
 * by background jobs or node processes are visible immediately.
 */
function makeIndex(fs) {
  void fs;
  return {
    async all() {
      let idx = await getLiveIndex();
      let out = new Set();
      for (let [dir, kids] of idx) {
        if (dir) out.add(dir + '/.keep');
        for (let [name, kind] of kids) if (kind !== 'dir') out.add(dir ? dir + '/' + name : name);
      }
      return out;
    },
    invalidate() {},
  };
}

function ok(stdout) {
  return { code: 0, stdout, stderr: '' };
}

function shellError(message, code) {
  let err = new Error(message);
  err.code = code;
  return err;
}

function isKeep(path) {
  return path === '.keep' || path.endsWith('/.keep');
}

function isDirPath(path) {
  return path.endsWith('/');
}

function baseName(path) {
  let parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function joinPath(dir, name) {
  return dir ? dir + '/' + name : name;
}

/**
 * Resolve a user path against cwd.
 * Absolute paths (`/...`) reset to VFS root; `~` / `~/...` expand via home.
 * Returns a project-relative path with no leading slash ('' = root).
 */
function resolvePath(cwd, input, home = SHELL_HOME) {
  let text = input == null ? '' : String(input);
  if (text === '~' || text.startsWith('~/')) {
    text = home + text.slice(1);
  }
  let absolute = text.startsWith('/');
  if (absolute) text = text.replace(/^\/+/, '');
  // Absolute ⇒ start from root. Relative empty/`.` ⇒ stay at cwd.
  let parts = absolute ? [] : (cwd ? cwd.split('/').filter(Boolean) : []);
  if (!text || text === '.') return parts.join('/');
  for (let part of text.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function hasGlob(text) {
  return /[*?[{]/.test(text);
}

async function expand(index, cwd, raw, home = SHELL_HOME) {
  let path = resolvePath(cwd, raw, home);
  if (!hasGlob(raw)) return [path];
  let matches = [];
  for (let item of await index.all()) {
    if (minimatch(item, path, globOpts)) matches.push(item);
    if (!isKeep(item)) continue;
    let dir = item.slice(0, -'/.keep'.length);
    if (dir && minimatch(dir, path, globOpts)) matches.push(dir);
  }
  matches = [...new Set(matches)].sort();
  return matches.length ? matches : [path];
}

function rowsOf(group) {
  return Object.keys(group).map(key => Number(key)).sort((a, b) => a - b).map(lineNumber => {
    let row = group[lineNumber];
    return { lineNumber, line: row.line, match: row.match };
  });
}

function parseOpts(args, spec) {
  let opts = {};
  let rest = [];
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (typeof arg !== 'string') {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-' || arg === '--') {
      rest.push(arg);
      continue;
    }
    let cluster = arg.slice(1);
    for (let c = 0; c < cluster.length; c++) {
      let flag = cluster[c];
      let kind = spec[flag];
      if (!kind) throw shellError(`unknown option: -${flag}`, 1);
      if (kind === 'bool') {
        opts[flag] = true;
        continue;
      }
      let inline = cluster.slice(c + 1);
      let value = inline || args[++i];
      if (value == null || value === '') throw shellError(`option -${flag} requires a value`, 1);
      if (kind === 'str' || kind === 'raw') {
        opts[flag] = String(value);
      } else {
        opts[flag] = Number(value);
        if (Number.isNaN(opts[flag])) throw shellError(`option -${flag} requires a number`, 1);
      }
      break;
    }
  }
  return { opts, rest };
}

function grepContents(options, regex, contents) {
  if (options.nameOnly) {
    let lines = contents.split('\n');
    for (let line of lines) {
      let matched = line.match(regex);
      if ((options.inverse && !matched) || (!options.inverse && matched)) return true;
    }
    return false;
  }
  let lines = contents.split('\n');
  let matches = [];
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index];
    let matched = line.match(regex);
    let hit = (options.inverse && !matched) || (!options.inverse && matched);
    if (!hit) continue;
    let lineNumber = index + 1;
    let result = {};
    if (matches.length) {
      let last = matches[matches.length - 1];
      let minimumLineNumber = Math.max(1, lineNumber - options.before - 1);
      if (last[lineNumber] || last[minimumLineNumber]) result = last;
    }
    result[lineNumber] = { line, match: true };
    if (options.before > 0) {
      let slice = lines.slice(Math.max(index - options.before, 0), index);
      for (let i = 0; i < slice.length; i++) {
        let lineNum = index - slice.length + i + 1;
        if (!result[lineNum]) result[lineNum] = { line: slice[i], match: false };
      }
    }
    if (options.after > 0) {
      let slice = lines.slice(index + 1, Math.min(index + options.after + 1, lines.length));
      for (let i = 0; i < slice.length; i++) {
        let lineNum = index + 2 + i;
        if (!result[lineNum]) result[lineNum] = { line: slice[i], match: false };
      }
    }
    if (!matches.includes(result)) matches.push(result);
  }
  return matches;
}

function formatGrepRow(file, row, lineNumber, prefixNames) {
  let prefix = prefixNames ? file + ':' : '';
  if (lineNumber) return prefix + row.lineNumber + (row.match ? ':' : '-') + row.line;
  return prefix + row.line;
}

function heredocText(redir) {
  if (redir.type === 'HereString') return (redir.target?.value || '') + '\n';
  let text = redir.body?.text || '';
  if (redir.operator === '<<-') text = text.split('\n').map(line => line.replace(/^\t+/, '')).join('\n');
  return text;
}

function escapeRegExp(text) {
  return String(text).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&');
}

function parseGrepArgs(args) {
  let parsed = {
    patterns: [],
    patternFiles: [],
    files: [],
    ignoreCase: false,
    inverse: false,
    namesOnly: false,
    lineNumber: false,
    recursive: false,
    fixed: false,
    word: false,
    onlyMatching: false,
    withFilename: false,
    noFilename: false,
    quietErrors: false,
    countOnly: false,
    quiet: false,
    lineRegexp: false,
    before: null,
    after: null,
    include: [],
    exclude: [],
    excludeDir: [],
  };
  let sawPattern = false;
  let take = (i, flag) => {
    let value = args[i + 1];
    if (value == null) throw shellError(`grep: ${flag} requires an argument`, 2);
    return value;
  };
  for (let i = 0; i < args.length; i++) {
    let arg = args[i];
    if (arg === '--') {
      if (!sawPattern && !parsed.patterns.length && !parsed.patternFiles.length) {
        if (args[i + 1] == null) throw shellError('grep: no pattern given', 2);
        parsed.patterns.push(args[i + 1]);
        parsed.files.push(...args.slice(i + 2));
      } else {
        parsed.files.push(...args.slice(i + 1));
      }
      break;
    }
    if (arg.startsWith('--')) {
      let eq = arg.indexOf('=');
      let key = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
      let inline = eq === -1 ? null : arg.slice(eq + 1);
      if (key === 'include' || key === 'exclude' || key === 'exclude-dir') {
        let value = inline == null ? take(i, arg) : inline;
        if (inline == null) i += 1;
        if (key === 'include') parsed.include.push(value);
        else if (key === 'exclude') parsed.exclude.push(value);
        else parsed.excludeDir.push(value);
        continue;
      }
      if (key === 'regexp' || key === 'e') {
        let value = inline == null ? take(i, arg) : inline;
        if (inline == null) i += 1;
        parsed.patterns.push(value);
        sawPattern = true;
        continue;
      }
      if (key === 'file' || key === 'f') {
        let value = inline == null ? take(i, arg) : inline;
        if (inline == null) i += 1;
        parsed.patternFiles.push(value);
        sawPattern = true;
        continue;
      }
      if (key === 'before-context' || key === 'after-context' || key === 'context') {
        let value = inline == null ? take(i, arg) : inline;
        if (inline == null) i += 1;
        let n = Number(value);
        if (Number.isNaN(n)) throw shellError(`grep: ${arg} requires a number`, 2);
        if (key !== 'after-context') parsed.before = n;
        if (key !== 'before-context') parsed.after = n;
        continue;
      }
      if (key === 'ignore-case') parsed.ignoreCase = true;
      else if (key === 'invert-match') parsed.inverse = true;
      else if (key === 'files-with-matches') parsed.namesOnly = true;
      else if (key === 'line-number') parsed.lineNumber = true;
      else if (key === 'recursive' || key === 'dereference-recursive') parsed.recursive = true;
      else if (key === 'fixed-strings') parsed.fixed = true;
      else if (key === 'word-regexp') parsed.word = true;
      else if (key === 'only-matching') parsed.onlyMatching = true;
      else if (key === 'with-filename') parsed.withFilename = true;
      else if (key === 'no-filename') parsed.noFilename = true;
      else if (key === 'count') parsed.countOnly = true;
      else if (key === 'quiet' || key === 'silent') parsed.quiet = true;
      else if (key === 'line-regexp') parsed.lineRegexp = true;
      else if (key === 'extended-regexp' || key === 'basic-regexp' || key === 'binary-files') {}
      else if (key === 'no-messages') parsed.quietErrors = true;
      else throw shellError(`grep: unknown option: --${key}`, 2);
      continue;
    }
    if (arg.startsWith('-') && arg !== '-') {
      let cluster = arg.slice(1);
      for (let c = 0; c < cluster.length; c++) {
        let flag = cluster[c];
        if ('vilnrRIFHwHoEscqx'.includes(flag)) {
          if (flag === 'v') parsed.inverse = true;
          else if (flag === 'i') parsed.ignoreCase = true;
          else if (flag === 'l') parsed.namesOnly = true;
          else if (flag === 'n') parsed.lineNumber = true;
          else if (flag === 'r' || flag === 'R') parsed.recursive = true;
          else if (flag === 'I') {}
          else if (flag === 'F') parsed.fixed = true;
          else if (flag === 'H') parsed.withFilename = true;
          else if (flag === 'h') parsed.noFilename = true;
          else if (flag === 'w') parsed.word = true;
          else if (flag === 'o') parsed.onlyMatching = true;
          else if (flag === 'E') {}
          else if (flag === 's') parsed.quietErrors = true;
          else if (flag === 'c') parsed.countOnly = true;
          else if (flag === 'q') parsed.quiet = true;
          else if (flag === 'x') parsed.lineRegexp = true;
          continue;
        }
        if (flag === 'e') {
          let inline = cluster.slice(c + 1);
          let value = inline || take(i, '-e');
          if (!inline) i += 1;
          parsed.patterns.push(value);
          sawPattern = true;
          break;
        }
        if (flag === 'f') {
          let inline = cluster.slice(c + 1);
          let value = inline || take(i, '-f');
          if (!inline) i += 1;
          parsed.patternFiles.push(value);
          sawPattern = true;
          break;
        }
        if (flag === 'A' || flag === 'B' || flag === 'C') {
          let inline = cluster.slice(c + 1);
          let value = inline || take(i, '-' + flag);
          if (!inline) i += 1;
          let n = Number(value);
          if (Number.isNaN(n)) throw shellError(`grep: -${flag} requires a number`, 2);
          if (flag !== 'A') parsed.before = n;
          if (flag !== 'B') parsed.after = n;
          break;
        }
        throw shellError(`grep: unknown option: -${flag}`, 2);
      }
      continue;
    }
    if (!sawPattern && !parsed.patterns.length && !parsed.patternFiles.length) {
      parsed.patterns.push(arg);
      sawPattern = true;
    } else {
      parsed.files.push(arg);
    }
  }
  return parsed;
}

function grepSkip(path, parsed) {
  let base = baseName(path);
  if (parsed.exclude.some(glob => minimatch(base, glob, globOpts))) return true;
  if (parsed.include.length && !parsed.include.some(glob => minimatch(base, glob, globOpts))) return true;
  if (!parsed.excludeDir.length) return false;
  let parts = path.split('/');
  parts.pop();
  return parts.some(part => parsed.excludeDir.some(glob => minimatch(part, glob, globOpts)));
}

function grepOnly(regex, contents, inverse) {
  let lines = contents.split('\n');
  if (contents.endsWith('\n')) lines.pop();
  let rows = [];
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
    let matcher = new RegExp(regex.source, flags);
    let found = regex.source ? [...line.matchAll(matcher)] : [];
    if (inverse) {
      if (!found.length) rows.push({ lineNumber: i + 1, text: line });
      continue;
    }
    for (let match of found) {
      if (!match[0]) continue;
      rows.push({ lineNumber: i + 1, text: match[0] });
    }
  }
  return rows;
}

function dropPrefix(paths, prefix) {
  for (let path of [...paths]) {
    if (path.startsWith(prefix)) paths.delete(path);
  }
}

function retargetPrefix(paths, from, to) {
  let moved = [];
  for (let path of [...paths]) {
    if (!path.startsWith(from)) continue;
    moved.push([path, to + path.slice(from.length)]);
  }
  for (let [path, next] of moved) {
    paths.delete(path);
    paths.add(next);
  }
}
