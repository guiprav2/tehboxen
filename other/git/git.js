/**
 * `git` for the Tehboxen shell, on isomorphic-git (git's object/pack formats
 * and smart-HTTP protocol in JS). Runs on the page like npm; every file
 * operation goes through the permission-checked syscall host as the shell
 * user. HTTP(S) remotes go through a CORS proxy: $GIT_CORS_PROXY, else
 * `git config http.corsProxy`, else https://cors.isomorphic-git.org.
 * Pushing and private repos: $GIT_TOKEN (or $GITHUB_TOKEN) as the password.
 *
 * Commands: init clone status add rm mv commit log show branch checkout switch
 * fetch pull push remote config rev-parse ls-files diff tag reset(--hard/soft/mixed) help version
 */
import { createHost } from '../node/host.js';

export let GIT_VERSION = '2.47.1 (isomorphic-git 1.44.17)';
let ISO = 'https://cdn.jsdelivr.net/npm/isomorphic-git@1.44.17';
let DEFAULT_PROXY = 'https://cors.isomorphic-git.org';
let enc = new TextEncoder();
let dec = new TextDecoder();

let libPromise = null;
function loadLib() {
  libPromise ??= (async () => {
    if (typeof globalThis.Buffer === 'undefined') {
      let { Buffer } = await import('https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm');
      globalThis.Buffer = Buffer;
    }
    let [git, http] = await Promise.all([import(`${ISO}/+esm`), import(`${ISO}/http/web/+esm`)]);
    return { git: git.default || git, http: http.default || http };
  })();
  libPromise.catch(() => (libPromise = null));
  return libPromise;
}

class GitError extends Error {
  constructor(message, code = 128) {
    super(message);
    this.exitCode = code;
  }
}
let fatal = (msg, code = 128) => {
  throw new GitError(`fatal: ${msg}`, code);
};

/** isomorphic-git fs client on the syscall host (permissions, locks, the user's uid). */
function makeFs(host, resolve) {
  let toErr = (e) => {
    if (!e?.__syserr) return e;
    let err = new Error(e.message);
    err.code = e.code;
    err.errno = e.errno;
    err.path = e.path;
    return err;
  };
  let call = async (op, args) => {
    try {
      // isomorphic-git sometimes passes paths relative to the process cwd ('.').
      if (args.path != null) args = { ...args, path: resolve(String(args.path)) };
      return await host.call(op, args);
    } catch (e) {
      throw toErr(e);
    }
  };
  let stats = (s) => {
    let type = s.kind === 'dir' ? 0o040000 : s.kind === 'symlink' ? 0o120000 : 0o100000;
    let t = Number(s.mtime) || Date.now();
    return {
      type: s.kind === 'dir' ? 'dir' : s.kind === 'symlink' ? 'symlink' : 'file',
      isFile: () => s.kind === 'file' || s.kind === 'chr',
      isDirectory: () => s.kind === 'dir',
      isSymbolicLink: () => s.kind === 'symlink',
      mode: type | (s.mode & 0o7777),
      size: s.size || 0,
      ino: Number(s.ino) || 0,
      uid: s.uid || 0,
      gid: s.gid || 0,
      dev: 1,
      mtimeMs: t,
      ctimeMs: t,
      mtime: new Date(t),
      ctime: new Date(t),
    };
  };
  let promises = {
    async readFile(path, opts) {
      let bytes = await call('readFile', { path });
      let encoding = typeof opts === 'string' ? opts : opts?.encoding;
      return encoding ? dec.decode(bytes) : bytes;
    },
    async writeFile(path, data, opts) {
      let mode = typeof opts === 'object' && opts?.mode != null ? opts.mode : undefined;
      let existed = await call('stat', { path, follow: false }).catch(() => null);
      await call('writeFile', { path, data: typeof data === 'string' ? data : new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data), ...(mode != null ? { mode } : {}) });
      if (mode != null && existed && (existed.mode & 0o777) !== (mode & 0o777)) await call('chmod', { path, mode: mode & 0o777 }).catch(() => {});
    },
    unlink: (path) => call('rm', { path, fileOnly: true, syscall: 'unlink' }),
    readdir: async (path) => (await call('readdir', { path })).map((e) => e.name),
    mkdir: (path) => call('mkdir', { path }),
    rmdir: (path) => call('rm', { path, dirOnly: true, syscall: 'rmdir' }),
    stat: async (path) => stats(await call('stat', { path, follow: true })),
    lstat: async (path) => stats(await call('stat', { path, follow: false })),
    readlink: (path) => call('readlink', { path }),
    symlink: (target, path) => call('symlink', { target, path }),
    chmod: (path, mode) => call('chmod', { path, mode }),
  };
  return { promises };
}

/* ---------- tiny INI for ~/.gitconfig ---------- */

function parseIni(text) {
  let out = {};
  let section = '';
  for (let raw of String(text || '').split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    let m = /^\[([^\]\s"]+)(?:\s+"([^"]*)")?\]$/.exec(line);
    if (m) {
      section = m[2] != null ? `${m[1]}.${m[2]}` : m[1];
      continue;
    }
    let kv = /^([^=\s]+)\s*(?:=\s*(.*))?$/.exec(line);
    if (kv && section) out[`${section}.${kv[1]}`.toLowerCase()] = kv[2] == null ? 'true' : kv[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}
function setIni(text, key, value) {
  let parts = key.split('.');
  let name = parts.pop();
  let sub = parts.length > 1 ? parts.slice(1).join('.') : null;
  let header = sub != null ? `[${parts[0]} "${sub}"]` : `[${parts[0]}]`;
  let lines = String(text || '').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  let start = lines.findIndex((l) => l.trim().toLowerCase() === header.toLowerCase());
  if (start === -1) {
    if (value == null) return lines.join('\n') + (lines.length ? '\n' : '');
    lines.push(header, `\t${name} = ${value}`);
    return lines.join('\n') + '\n';
  }
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith('[')) end++;
  let at = lines.slice(start + 1, end).findIndex((l) => l.trim().split(/\s*=/)[0].toLowerCase() === name.toLowerCase());
  if (at !== -1) {
    if (value == null) lines.splice(start + 1 + at, 1);
    else lines[start + 1 + at] = `\t${name} = ${value}`;
  } else if (value != null) lines.splice(end, 0, `\t${name} = ${value}`);
  return lines.join('\n') + '\n';
}

/* ---------- diff ---------- */

/** Line diff (Myers, O(ND)) → unified hunks with 3 lines of context. */
function unifiedDiff(a, b) {
  let A = a.length ? a.replace(/\n$/, '').split('\n') : [];
  let B = b.length ? b.replace(/\n$/, '').split('\n') : [];
  let n = A.length;
  let m = B.length;
  let max = n + m;
  let v = new Map([[1, 0]]);
  let trace = [];
  outer: for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) (x++, y++);
      v.set(k, x);
      if (x >= n && y >= m) break outer;
    }
    if (d > 4000) return null; // too different: caller prints a summary
  }
  let ops = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
    let vv = trace[d];
    let k = x - y;
    let prevK = k === -d || (k !== d && (vv.get(k - 1) ?? -1) < (vv.get(k + 1) ?? -1)) ? k + 1 : k - 1;
    let prevX = vv.get(prevK) ?? 0;
    let prevY = prevX - prevK;
    while (x > prevX && y > prevY) ops.push([' ', A[--x], --y]);
    if (d === 0) break;
    if (x === prevX) ops.push(['+', B[--y]]);
    else ops.push(['-', A[--x]]);
  }
  ops.reverse();
  // Group into hunks.
  let out = [];
  let ai = 0;
  let bi = 0;
  let rows = ops.map((op) => {
    let row = { op: op[0], text: op[1], a: ai, b: bi };
    if (op[0] !== '+') ai++;
    if (op[0] !== '-') bi++;
    return row;
  });
  let i = 0;
  while (i < rows.length) {
    while (i < rows.length && rows[i].op === ' ') i++;
    if (i >= rows.length) break;
    let start = Math.max(0, i - 3);
    let end = i;
    let lastChange = i;
    while (end < rows.length && end - lastChange <= 6) {
      if (rows[end].op !== ' ') lastChange = end;
      end++;
    }
    end = Math.min(rows.length, lastChange + 4);
    let chunk = rows.slice(start, end);
    let aStart = chunk[0].a;
    let bStart = chunk[0].b;
    let aLen = chunk.filter((r) => r.op !== '+').length;
    let bLen = chunk.filter((r) => r.op !== '-').length;
    out.push(`\x1b[36m@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@\x1b[0m`);
    for (let r of chunk) out.push(r.op === '+' ? `\x1b[32m+${r.text}\x1b[0m` : r.op === '-' ? `\x1b[31m-${r.text}\x1b[0m` : ` ${r.text}`);
    i = end;
  }
  return out;
}

/* ---------- argv ---------- */

function parse(args, spec = {}) {
  let opts = {};
  let rest = [];
  for (let i = 0; i < args.length; i++) {
    let a = args[i];
    if (a === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (v === undefined && spec.valued?.includes(k) && i + 1 < args.length) v = args[++i];
      opts[k] = v === undefined ? true : v;
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
      let flags = a.slice(1);
      for (let j = 0; j < flags.length; j++) {
        let c = flags[j];
        if (spec.short?.[c]) {
          let k = spec.short[c];
          if (spec.valued?.includes(k)) {
            opts[k] = flags.slice(j + 1) || args[++i];
            break;
          }
          opts[k] = true;
        } else opts[c] = true;
      }
      continue;
    }
    if (/^-\d+$/.test(a)) {
      opts['max-count'] = a.slice(1);
      continue;
    }
    rest.push(a);
  }
  return { opts, rest };
}

let short = (oid) => oid.slice(0, 7);
let fmtDate = (ts, tz) => {
  let d = new Date((ts - tz * 60) * 1000);
  let days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let off = -tz;
  let sign = off >= 0 ? '+' : '-';
  let abs = Math.abs(off);
  let p = (n) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()} ${sign}${p(Math.floor(abs / 60))}${p(abs % 60)}`;
};

/**
 * @param {string[]} argv
 * @param {{ cwd: string, env: object, actor: object, exec: Function, live?: { out, err } }} ctx
 */
export async function runGit(argv, ctx) {
  let stdout = '';
  let stderr = '';
  let out = (s) => (ctx.live ? ctx.live.out(s) : (stdout += s));
  let err = (s) => (ctx.live ? ctx.live.err(s) : (stderr += s));
  let host = createHost({ actor: ctx.actor, hostname: ctx.env?.HOSTNAME, exec: ctx.exec });
  try {
    let code = await main(argv.map(String), { ...ctx, out, err, host });
    return { code: code ?? 0, stdout, stderr };
  } catch (e) {
    if (e instanceof GitError) {
      err(e.message + '\n');
      return { code: e.exitCode, stdout, stderr };
    }
    let msg = String(e?.message || e);
    if (e?.code === 'NotFoundError' && /Could not find/.test(msg)) msg = msg.replace(/^Could not find /, "pathspec '").replace(/\.$/, "' did not match any files");
    err(`fatal: ${msg}\n`);
    return { code: 128, stdout, stderr };
  } finally {
    await host.dispose().catch(() => {});
  }
}

async function main(argv, c) {
  let P = await import('../node/path.js').then((m) => m.default || m);
  let cwd = c.cwd;
  while (argv.length && argv[0].startsWith('-')) {
    let a = argv.shift();
    if (a === '--version' || a === '-v') {
      c.out(`git version ${GIT_VERSION}\n`);
      return 0;
    }
    if (a === '-C') cwd = P.resolve(cwd, argv.shift() || '.');
    else if (a === '-c') argv.shift();
    else if (a === '--help' || a === '-h') argv.unshift('help');
    else if (a === '--no-pager' || a === '--bare' || a === '-p' || a === '--paginate') {
      /* no pager here */
    } else fatal(`unknown option: ${a}`, 129);
  }
  let cmd = argv.shift();
  let args = argv;
  if (!cmd || cmd === 'help') {
    c.out(`usage: git [-C <path>] [--version] <command> [<args>]

Tehboxen git (isomorphic-git). Commands:
   init clone status add rm mv commit log show diff branch checkout switch
   tag fetch pull push remote config rev-parse ls-files reset
Remotes over http(s) go through a CORS proxy ($GIT_CORS_PROXY or http.corsProxy,
default ${DEFAULT_PROXY}); authenticate with $GIT_TOKEN / $GITHUB_TOKEN.
`);
    return cmd ? 0 : 1;
  }
  if (cmd === 'version') {
    c.out(`git version ${GIT_VERSION}\n`);
    return 0;
  }

  let { git, http } = await loadLib();
  let fs = makeFs(c.host, (p) => P.resolve(cwd, p));
  let home = c.env?.HOME || c.actor?.home || '/';
  let globalPath = P.join(home, '.gitconfig');
  let readGlobal = async () => parseIni(await fs.promises.readFile(globalPath, 'utf8').catch(() => ''));

  let findRoot = async () => {
    try {
      return await git.findRoot({ fs, filepath: cwd });
    } catch {
      fatal('not a git repository (or any of the parent directories): .git');
    }
  };
  let configGet = async (dir, key) => {
    if (dir) {
      let v = await git.getConfig({ fs, dir, path: key }).catch(() => undefined);
      if (v !== undefined) return v;
    }
    return (await readGlobal())[key.toLowerCase()];
  };
  let author = async (dir) => {
    let name = c.env?.GIT_AUTHOR_NAME || (await configGet(dir, 'user.name')) || c.actor?.name || c.env?.USER || 'tehboxen';
    let email = c.env?.GIT_AUTHOR_EMAIL || (await configGet(dir, 'user.email')) || `${c.actor?.name || 'user'}@${c.env?.HOSTNAME || 'tehboxen'}`;
    return { name, email };
  };
  let proxyFor = async (dir, url) => {
    if (!/^https?:/i.test(String(url || ''))) return undefined;
    let p = c.env?.GIT_CORS_PROXY ?? (await configGet(dir, 'http.corsProxy')) ?? DEFAULT_PROXY;
    return p || undefined;
  };
  let onAuth = () => {
    let token = c.env?.GIT_TOKEN || c.env?.GITHUB_TOKEN || c.env?.GH_TOKEN;
    return token ? { username: c.env?.GIT_USERNAME || token, password: token } : { cancel: true };
  };
  let progress = (quiet) => {
    if (quiet) return undefined;
    let last = '';
    return ({ phase, loaded, total }) => {
      let line = total ? `${phase}: ${Math.round((100 * loaded) / total)}% (${loaded}/${total})` : `${phase}: ${loaded}`;
      if (line === last) return;
      if (c.live) c.err(`\r\x1b[K${line}`);
      last = line;
    };
  };
  let endProgress = () => c.live && c.err('\r\x1b[K');
  let rel = (dir, p) => {
    let abs = P.resolve(cwd, p);
    let r = P.relative(dir, abs);
    if (r.startsWith('..')) fatal(`${p}: '${abs}' is outside repository at '${dir}'`);
    return r || '.';
  };
  let currentBranch = (dir) => git.currentBranch({ fs, dir, fullname: false }).catch(() => undefined);

  switch (cmd) {
    case 'init': {
      let { opts, rest } = parse(args, { short: { b: 'initial-branch', q: 'quiet' }, valued: ['initial-branch'] });
      let dir = P.resolve(cwd, rest[0] || '.');
      await fs.promises.mkdir(dir).catch(() => {});
      let existed = await fs.promises.stat(P.join(dir, '.git')).catch(() => null);
      await git.init({ fs, dir, bare: !!opts.bare, defaultBranch: opts['initial-branch'] || (await configGet(null, 'init.defaultBranch')) || 'main' });
      if (!opts.quiet) c.out(`${existed ? 'Reinitialized existing' : 'Initialized empty'} Git repository in ${opts.bare ? dir : P.join(dir, '.git')}/\n`);
      return 0;
    }

    case 'clone': {
      let { opts, rest } = parse(args, { short: { b: 'branch', q: 'quiet', n: 'no-checkout' }, valued: ['branch', 'depth', 'origin', 'o'] });
      let url = rest[0];
      if (!url) fatal('You must specify a repository to clone.', 129);
      if (/^[\w.-]+\/[\w.-]+$/.test(url) && !(await fs.promises.stat(P.resolve(cwd, url)).catch(() => null))) url = `https://github.com/${url}`;
      let name = rest[1] || url.replace(/\/+$/, '').split('/').pop().replace(/\.git$/, '');
      let dir = P.resolve(cwd, name);
      let existing = await fs.promises.readdir(dir).catch(() => null);
      if (existing?.length) fatal(`destination path '${name}' already exists and is not an empty directory.`);
      if (!opts.quiet) c.err(`Cloning into '${name}'...\n`);
      await fs.promises.mkdir(dir).catch(() => {});
      try {
        await git.clone({
          fs,
          http,
          dir,
          url,
          corsProxy: await proxyFor(null, url),
          ref: opts.branch,
          singleBranch: !!(opts['single-branch'] || opts.depth),
          depth: opts.depth ? Number(opts.depth) : undefined,
          noCheckout: !!opts['no-checkout'],
          remote: opts.origin || opts.o || 'origin',
          onProgress: progress(opts.quiet),
          onAuth,
        });
      } catch (e) {
        endProgress();
        // Leave nothing half-cloned behind, like git.
        if (!existing) await c.host.call('rm', { path: dir, recursive: true, force: true }).catch(() => {});
        if (e?.code === 'HttpError') fatal(`unable to access '${url}': ${e.data?.statusCode || ''} ${e.data?.statusMessage || e.message}`.trim());
        throw e;
      }
      endProgress();
      return 0;
    }

    case 'status': {
      let { opts } = parse(args, { short: { s: 'short', b: 'branch' } });
      let dir = await findRoot();
      let branch = await currentBranch(dir);
      let matrix = await git.statusMatrix({ fs, dir });
      let staged = [];
      let unstaged = [];
      let untracked = [];
      for (let [file, head, work, stage] of matrix) {
        if (head === 1 && work === 1 && stage === 1) continue;
        let x = head === 0 && stage === 2 ? 'A' : head === 0 && stage === 3 ? 'A' : head === 1 && stage === 0 ? 'D' : stage === 2 || stage === 3 ? 'M' : ' ';
        if (head === 0 && stage === 0 && work === 2) {
          untracked.push(file);
          continue;
        }
        let y = work === 0 && stage !== 0 ? 'D' : (stage === 1 && work === 2) || (stage === 3 && work === 2) ? 'M' : ' ';
        if (x !== ' ') staged.push([x, file]);
        if (y !== ' ') unstaged.push([y, file]);
        if (opts.short || opts.porcelain) c.out(`${x}${y} ${file}\n`);
      }
      if (opts.short || opts.porcelain) {
        for (let f of untracked) c.out(`?? ${f}\n`);
        return 0;
      }
      let head = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
      c.out(branch ? `On branch ${branch}\n` : `HEAD detached at ${short(head || '')}\n`);
      if (!head) c.out('\nNo commits yet\n');
      let word = { M: 'modified:   ', A: 'new file:   ', D: 'deleted:    ' };
      if (staged.length) {
        c.out('\nChanges to be committed:\n  (use "git restore --staged <file>..." to unstage)\n');
        for (let [k, f] of staged) c.out(`\t\x1b[32m${word[k]}${f}\x1b[0m\n`);
      }
      if (unstaged.length) {
        c.out('\nChanges not staged for commit:\n  (use "git add <file>..." to update what will be committed)\n');
        for (let [k, f] of unstaged) c.out(`\t\x1b[31m${word[k]}${f}\x1b[0m\n`);
      }
      if (untracked.length) {
        c.out('\nUntracked files:\n  (use "git add <file>..." to include in what will be committed)\n');
        for (let f of untracked) c.out(`\t\x1b[31m${f}\x1b[0m\n`);
      }
      if (!staged.length && !unstaged.length && !untracked.length) c.out(head ? '\nnothing to commit, working tree clean\n' : '\nnothing to commit (create/copy files and use "git add" to track)\n');
      else if (!staged.length) c.out(`\nno changes added to commit${unstaged.length ? ' (use "git add" and/or "git commit -a")' : ''}\n`);
      return 0;
    }

    case 'add': {
      let { opts, rest } = parse(args, { short: { A: 'all', u: 'update', f: 'force', v: 'verbose' } });
      let dir = await findRoot();
      if (!rest.length && !opts.all && !opts.update) {
        c.err('Nothing specified, nothing added.\nhint: Maybe you wanted to say \'git add .\'?\n');
        return 0;
      }
      let specs = rest.length ? rest.map((p) => rel(dir, p)) : ['.'];
      let matrix = await git.statusMatrix({ fs, dir });
      let under = (file) => specs.some((s) => s === '.' || file === s || file.startsWith(s.replace(/\/$/, '') + '/'));
      let matched = new Set();
      for (let [file, head, work, stage] of matrix) {
        if (!under(file)) continue;
        matched.add(file);
        if (opts.update && head === 0 && stage === 0) continue;
        if (work === 0) {
          if (stage !== 0) await git.remove({ fs, dir, filepath: file });
        } else if (work !== stage || (head === 0 && stage === 0)) await git.add({ fs, dir, filepath: file, force: !!opts.force });
        if (opts.verbose) c.out(`add '${file}'\n`);
      }
      for (let s of specs) {
        if (s === '.' || [...matched].some((f) => f === s || f.startsWith(s.replace(/\/$/, '') + '/'))) continue;
        let ignored = await git.isIgnored({ fs, dir, filepath: s }).catch(() => false);
        if (ignored && !opts.force) fatal(`The following paths are ignored by one of your .gitignore files:\n${s}`, 1);
        if (opts.force) await git.add({ fs, dir, filepath: s, force: true });
        else fatal(`pathspec '${s}' did not match any files`);
      }
      return 0;
    }

    case 'rm': {
      let { opts, rest } = parse(args, { short: { r: 'recursive', f: 'force', q: 'quiet' } });
      let dir = await findRoot();
      let files = await git.listFiles({ fs, dir });
      for (let p of rest) {
        let r = rel(dir, p);
        let hits = files.filter((f) => f === r || (opts.recursive && f.startsWith(r.replace(/\/$/, '') + '/')));
        if (!hits.length) fatal(files.some((f) => f.startsWith(r + '/')) ? `not removing '${r}' recursively without -r` : `pathspec '${p}' did not match any files`);
        for (let f of hits) {
          await git.remove({ fs, dir, filepath: f });
          if (!opts.cached) await fs.promises.unlink(P.join(dir, f)).catch(() => {});
          if (!opts.quiet) c.out(`rm '${f}'\n`);
        }
      }
      return 0;
    }

    case 'mv': {
      let { rest } = parse(args);
      if (rest.length !== 2) fatal('usage: git mv <source> <destination>', 129);
      let dir = await findRoot();
      let [from, to] = rest.map((p) => rel(dir, p));
      await c.host.call('rename', { from: P.join(dir, from), to: P.join(dir, to) });
      await git.remove({ fs, dir, filepath: from });
      await git.add({ fs, dir, filepath: to });
      return 0;
    }

    case 'commit': {
      let { opts } = parse(args, { short: { m: 'message', a: 'all', q: 'quiet', F: 'file' }, valued: ['message', 'author', 'file'] });
      let dir = await findRoot();
      if (opts.all) {
        for (let [file, head, work, stage] of await git.statusMatrix({ fs, dir })) {
          if (head === 0) continue;
          if (work === 0) await git.remove({ fs, dir, filepath: file });
          else if (work !== stage) await git.add({ fs, dir, filepath: file });
        }
      }
      let message = opts.message ?? (opts.file ? await fs.promises.readFile(P.resolve(cwd, opts.file), 'utf8') : null);
      if (message == null) fatal('no commit message given (use -m "message"; there is no editor here yet)', 1);
      let matrix = await git.statusMatrix({ fs, dir });
      let changed = matrix.filter(([, head, , stage]) => head !== stage || stage === 3 || (head === 1 && stage === 2));
      let headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
      if (!changed.length && !opts['allow-empty'] && headOid) {
        c.out(`On branch ${await currentBranch(dir)}\nnothing to commit, working tree clean\n`);
        return 1;
      }
      let who = await author(dir);
      if (opts.author) {
        let m = /^(.*?)\s*<([^>]*)>$/.exec(opts.author);
        if (m) Object.assign(who, { name: m[1], email: m[2] });
      }
      let oid = await git.commit({ fs, dir, message: String(message).endsWith('\n') ? message : message + '\n', author: who });
      if (!opts.quiet) {
        let branch = await currentBranch(dir);
        let created = changed.filter(([, head]) => head === 0).length;
        let deleted = changed.filter(([, , , stage]) => stage === 0).length;
        c.out(`[${branch || 'detached HEAD'}${headOid ? '' : ' (root-commit)'} ${short(oid)}] ${String(message).split('\n')[0]}\n`);
        c.out(` ${changed.length} file${changed.length === 1 ? '' : 's'} changed${created ? `, ${created} created` : ''}${deleted ? `, ${deleted} deleted` : ''}\n`);
      }
      return 0;
    }

    case 'log': {
      let { opts, rest } = parse(args, { short: { n: 'max-count' }, valued: ['max-count', 'format', 'pretty'] });
      let dir = await findRoot();
      let ref = rest[0] || 'HEAD';
      let commits;
      try {
        commits = await git.log({ fs, dir, ref, depth: opts['max-count'] ? Number(opts['max-count']) : undefined });
      } catch (e) {
        if (ref === 'HEAD') fatal(`your current branch '${(await currentBranch(dir)) || 'HEAD'}' does not have any commits yet`);
        throw e;
      }
      let oneline = opts.oneline || opts.pretty === 'oneline' || opts.format === 'oneline';
      for (let { oid, commit } of commits) {
        if (oneline) {
          c.out(`\x1b[33m${short(oid)}\x1b[0m ${commit.message.split('\n')[0]}\n`);
          continue;
        }
        c.out(`\x1b[33mcommit ${oid}\x1b[0m\n`);
        if (commit.parent.length > 1) c.out(`Merge: ${commit.parent.map(short).join(' ')}\n`);
        c.out(`Author: ${commit.author.name} <${commit.author.email}>\nDate:   ${fmtDate(commit.author.timestamp, commit.author.timezoneOffset)}\n\n`);
        c.out(commit.message.replace(/\n$/, '').split('\n').map((l) => `    ${l}\n`).join('') + '\n');
      }
      return 0;
    }

    case 'show': {
      let { rest } = parse(args);
      let dir = await findRoot();
      let oid = await git.resolveRef({ fs, dir, ref: rest[0] || 'HEAD' }).catch(() => git.expandOid({ fs, dir, oid: rest[0] }));
      let { commit } = await git.readCommit({ fs, dir, oid });
      c.out(`\x1b[33mcommit ${oid}\x1b[0m\nAuthor: ${commit.author.name} <${commit.author.email}>\nDate:   ${fmtDate(commit.author.timestamp, commit.author.timezoneOffset)}\n\n`);
      c.out(commit.message.replace(/\n$/, '').split('\n').map((l) => `    ${l}\n`).join('') + '\n');
      await diffTrees(git, fs, dir, commit.parent[0] || null, oid, c);
      return 0;
    }

    case 'diff': {
      let { opts, rest } = parse(args);
      let dir = await findRoot();
      let cached = opts.cached || opts.staged;
      let specs = rest.map((p) => rel(dir, p));
      let want = (f) => !specs.length || specs.some((s) => s === '.' || f === s || f.startsWith(s + '/'));
      let matrix = await git.statusMatrix({ fs, dir });
      for (let [file, head, work, stage] of matrix) {
        if (!want(file)) continue;
        let a;
        let b;
        if (cached) {
          if (head === 1 && (stage === 1 || stage === 0) && !(stage === 0)) continue;
          if (head === 0 && stage === 0) continue;
          if (head === 1 && stage === 1) continue;
          a = head ? await readAt(git, fs, dir, 'HEAD', file) : '';
          b = stage ? await readStaged(git, fs, dir, file) : '';
        } else {
          if (stage === 0 && head === 0) continue; // untracked
          if (work === stage || (stage === 1 && work === 1) || (stage === 3 && work === 3)) continue;
          a = await readStaged(git, fs, dir, file);
          b = work ? await fs.promises.readFile(P.join(dir, file), 'utf8').catch(() => '') : '';
        }
        if (a === b) continue;
        printFileDiff(c, file, a, b);
      }
      return 0;
    }

    case 'branch': {
      let { opts, rest } = parse(args, { short: { d: 'delete', D: 'force-delete', a: 'all', r: 'remotes', m: 'move', v: 'verbose' } });
      let dir = await findRoot();
      if (opts.delete || opts['force-delete']) {
        for (let b of rest) {
          await git.deleteBranch({ fs, dir, ref: b });
          c.out(`Deleted branch ${b}.\n`);
        }
        return 0;
      }
      if (opts.move) {
        let [from, to] = rest.length === 2 ? rest : [await currentBranch(dir), rest[0]];
        await git.renameBranch({ fs, dir, oldref: from, ref: to, checkout: from === (await currentBranch(dir)) });
        return 0;
      }
      if (rest.length) {
        await git.branch({ fs, dir, ref: rest[0], object: rest[1] });
        return 0;
      }
      let cur = await currentBranch(dir);
      let names = opts.remotes ? [] : await git.listBranches({ fs, dir });
      for (let b of names) c.out(b === cur ? `* \x1b[32m${b}\x1b[0m\n` : `  ${b}\n`);
      if (opts.all || opts.remotes) {
        for (let r of await git.listRemotes({ fs, dir })) for (let b of await git.listBranches({ fs, dir, remote: r.remote })) c.out(`  \x1b[31mremotes/${r.remote}/${b}\x1b[0m\n`);
      }
      return 0;
    }

    case 'checkout':
    case 'switch': {
      let { opts, rest } = parse(args, { short: { b: 'new', c: 'new', B: 'new', f: 'force', q: 'quiet' }, valued: ['new'] });
      let dir = await findRoot();
      if (opts.new) {
        await git.branch({ fs, dir, ref: opts.new, object: rest[0], checkout: false, force: !!opts.B });
        await git.checkout({ fs, dir, ref: opts.new, force: !!opts.force });
        if (!opts.quiet) c.err(`Switched to a new branch '${opts.new}'\n`);
        return 0;
      }
      if (!rest.length) fatal('you must specify a branch to switch to', 128);
      // `git checkout -- file` / `git checkout file`: restore from the index.
      let files = await git.listFiles({ fs, dir });
      let asPath = cmd === 'checkout' && (args.includes('--') || files.includes(rel(dir, rest[0])));
      if (asPath) {
        await git.checkout({ fs, dir, force: true, filepaths: rest.filter((p) => p !== '--').map((p) => rel(dir, p)) });
        return 0;
      }
      let ref = rest[0];
      let local = await git.listBranches({ fs, dir });
      if (!local.includes(ref)) {
        let remotes = await git.listRemotes({ fs, dir });
        let found = null;
        for (let r of remotes) if ((await git.listBranches({ fs, dir, remote: r.remote })).includes(ref)) found = r.remote;
        if (found) {
          await git.branch({ fs, dir, ref, object: `refs/remotes/${found}/${ref}` });
          await git.setConfig({ fs, dir, path: `branch.${ref}.remote`, value: found });
          await git.setConfig({ fs, dir, path: `branch.${ref}.merge`, value: `refs/heads/${ref}` });
          if (!opts.quiet) c.err(`branch '${ref}' set up to track '${found}/${ref}'.\n`);
        } else if (cmd === 'switch') fatal(`invalid reference: ${ref}`);
      }
      await git.checkout({ fs, dir, ref, force: !!opts.force });
      if (!opts.quiet) c.err(local.includes(ref) || (await git.listBranches({ fs, dir })).includes(ref) ? `Switched to branch '${ref}'\n` : `HEAD is now at ${short(await git.resolveRef({ fs, dir, ref: 'HEAD' }))}\n`);
      return 0;
    }

    case 'tag': {
      let { opts, rest } = parse(args, { short: { d: 'delete', a: 'annotate', m: 'message', l: 'list' }, valued: ['message'] });
      let dir = await findRoot();
      if (opts.delete) {
        for (let t of rest) await git.deleteTag({ fs, dir, ref: t });
        return 0;
      }
      if (!rest.length || opts.list) {
        for (let t of (await git.listTags({ fs, dir })).sort()) c.out(t + '\n');
        return 0;
      }
      if (opts.annotate || opts.message) await git.annotatedTag({ fs, dir, ref: rest[0], object: rest[1], message: opts.message || rest[0], tagger: await author(dir) });
      else await git.tag({ fs, dir, ref: rest[0], object: rest[1] });
      return 0;
    }

    case 'remote': {
      let { opts, rest } = parse(args, { short: { v: 'verbose' } });
      let dir = await findRoot();
      let sub = rest.shift();
      if (sub === 'add') {
        await git.addRemote({ fs, dir, remote: rest[0], url: rest[1] });
        return 0;
      }
      if (sub === 'remove' || sub === 'rm') {
        await git.deleteRemote({ fs, dir, remote: rest[0] });
        return 0;
      }
      if (sub === 'set-url') {
        await git.addRemote({ fs, dir, remote: rest[0], url: rest[1], force: true });
        return 0;
      }
      if (sub === 'get-url') {
        let r = (await git.listRemotes({ fs, dir })).find((x) => x.remote === rest[0]);
        if (!r) fatal(`No such remote '${rest[0]}'`, 2);
        c.out(r.url + '\n');
        return 0;
      }
      for (let r of await git.listRemotes({ fs, dir })) c.out(opts.verbose ? `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)\n` : `${r.remote}\n`);
      return 0;
    }

    case 'fetch':
    case 'pull': {
      let { opts, rest } = parse(args, { short: { q: 'quiet' }, valued: ['depth'] });
      let dir = await findRoot();
      let branch = await currentBranch(dir);
      let remote = rest[0] || (branch && (await configGet(dir, `branch.${branch}.remote`))) || 'origin';
      let url = (await git.listRemotes({ fs, dir })).find((r) => r.remote === remote)?.url;
      if (!url) fatal(`'${remote}' does not appear to be a git repository`);
      let common = { fs, http, dir, remote, url, corsProxy: await proxyFor(dir, url), onProgress: progress(opts.quiet), onAuth, depth: opts.depth ? Number(opts.depth) : undefined };
      if (cmd === 'fetch') {
        let r = await git.fetch({ ...common, ref: rest[1], singleBranch: !!rest[1], tags: !!opts.tags });
        endProgress();
        if (!opts.quiet && r.fetchHead) c.err(`From ${url}\n`);
        return 0;
      }
      await git.pull({ ...common, ref: rest[1] || branch, singleBranch: true, fastForward: true, author: await author(dir) });
      endProgress();
      if (!opts.quiet) c.out(`Updated ${branch} to ${short(await git.resolveRef({ fs, dir, ref: 'HEAD' }))}\n`);
      return 0;
    }

    case 'push': {
      let { opts, rest } = parse(args, { short: { f: 'force', u: 'set-upstream', q: 'quiet' } });
      let dir = await findRoot();
      let branch = await currentBranch(dir);
      let remote = rest[0] || (branch && (await configGet(dir, `branch.${branch}.remote`))) || 'origin';
      let url = (await git.listRemotes({ fs, dir })).find((r) => r.remote === remote)?.url;
      if (!url) fatal(`'${remote}' does not appear to be a git repository`);
      let r = await git.push({ fs, http, dir, remote, url, ref: rest[1] || branch, force: !!opts.force, corsProxy: await proxyFor(dir, url), onProgress: progress(opts.quiet), onAuth });
      endProgress();
      if (!r.ok) fatal(`failed to push some refs to '${url}'${r.error ? `: ${r.error}` : ''}`, 1);
      if (opts['set-upstream']) {
        await git.setConfig({ fs, dir, path: `branch.${branch}.remote`, value: remote });
        await git.setConfig({ fs, dir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
      }
      if (!opts.quiet) c.err(`To ${url}\n   ${rest[1] || branch} -> ${rest[1] || branch}\n`);
      return 0;
    }

    case 'config': {
      let { opts, rest } = parse(args, { short: { l: 'list' } });
      let global = !!opts.global;
      let dir = global ? null : await git.findRoot({ fs, filepath: cwd }).catch(() => null);
      if (!global && !dir && !opts.list && rest.length > 1) fatal('not in a git directory', 128);
      if (opts.list) {
        for (let [k, v] of Object.entries(await readGlobal())) c.out(`${k}=${v}\n`);
        if (dir && !global) {
          let text = await fs.promises.readFile(P.join(dir, '.git', 'config'), 'utf8').catch(() => '');
          for (let [k, v] of Object.entries(parseIni(text))) c.out(`${k}=${v}\n`);
        }
        return 0;
      }
      let key = rest[0];
      if (!key) fatal('usage: git config [--global] <name> [<value>]', 129);
      if (opts.unset) {
        if (global) await fs.promises.writeFile(globalPath, setIni(await fs.promises.readFile(globalPath, 'utf8').catch(() => ''), key, null));
        else await git.setConfig({ fs, dir, path: key, value: undefined });
        return 0;
      }
      if (rest.length > 1 && !opts.get) {
        if (global) await fs.promises.writeFile(globalPath, setIni(await fs.promises.readFile(globalPath, 'utf8').catch(() => ''), key, rest.slice(1).join(' ')));
        else await git.setConfig({ fs, dir, path: key, value: rest.slice(1).join(' ') });
        return 0;
      }
      let v = global ? (await readGlobal())[key.toLowerCase()] : await configGet(dir, key);
      if (v === undefined) return 1;
      c.out(`${v}\n`);
      return 0;
    }

    case 'rev-parse': {
      let { opts, rest } = parse(args);
      if (opts['is-inside-work-tree']) {
        let ok = await git.findRoot({ fs, filepath: cwd }).catch(() => null);
        if (!ok) fatal('not a git repository (or any of the parent directories): .git');
        c.out('true\n');
        return 0;
      }
      let dir = await findRoot();
      if (opts['show-toplevel']) {
        c.out(dir + '\n');
        return 0;
      }
      if (opts['git-dir']) {
        c.out(P.relative(cwd, P.join(dir, '.git')) || '.git');
        c.out('\n');
        return 0;
      }
      for (let r of rest.length ? rest : ['HEAD']) {
        if (opts['abbrev-ref']) {
          c.out(r === 'HEAD' ? `${(await currentBranch(dir)) || 'HEAD'}\n` : `${r}\n`);
          continue;
        }
        let oid = await git.resolveRef({ fs, dir, ref: r }).catch(() => git.expandOid({ fs, dir, oid: r }).catch(() => null));
        if (!oid) fatal(`ambiguous argument '${r}': unknown revision or path not in the working tree.`);
        c.out((opts.short ? short(oid) : oid) + '\n');
      }
      return 0;
    }

    case 'ls-files': {
      let dir = await findRoot();
      let base = P.relative(dir, cwd);
      for (let f of await git.listFiles({ fs, dir })) {
        if (base && !f.startsWith(base + '/')) continue;
        c.out((base ? f.slice(base.length + 1) : f) + '\n');
      }
      return 0;
    }

    case 'reset': {
      let { opts, rest } = parse(args, { short: { q: 'quiet' } });
      let dir = await findRoot();
      let target = rest.find((r) => !r.includes('/') && r !== '--') || 'HEAD';
      if (opts.hard || opts.soft || opts.mixed || !rest.length || rest.length === 1) {
        let oid = await git.resolveRef({ fs, dir, ref: target }).catch(() => git.expandOid({ fs, dir, oid: target }));
        let branch = await currentBranch(dir);
        if (branch && target !== 'HEAD') await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
        if (!opts.soft) {
          // Index (and with --hard, the work tree) back to the commit.
          for (let [file, head, work, stage] of await git.statusMatrix({ fs, dir, ref: oid })) {
            if (head === 0 && stage !== 0) await git.remove({ fs, dir, filepath: file });
            else if (head === 1 && stage !== 1) await git.resetIndex({ fs, dir, filepath: file, ref: oid });
            if (opts.hard && head === 0 && stage !== 0 && work !== 0) await fs.promises.unlink(P.join(dir, file)).catch(() => {});
          }
          if (opts.hard) await git.checkout({ fs, dir, ref: branch || oid, force: true });
        }
        if (opts.hard && !opts.quiet) {
          let { commit } = await git.readCommit({ fs, dir, oid });
          c.out(`HEAD is now at ${short(oid)} ${commit.message.split('\n')[0]}\n`);
        }
        return 0;
      }
      for (let p of rest.filter((r) => r !== '--')) await git.resetIndex({ fs, dir, filepath: rel(dir, p) });
      return 0;
    }

    default:
      fatal(`'${cmd}' is not a git command. See 'git help'.`, 1);
  }
}

async function readAt(git, fs, dir, ref, file) {
  try {
    let oid = await git.resolveRef({ fs, dir, ref });
    let { blob } = await git.readBlob({ fs, dir, oid, filepath: file });
    return dec.decode(blob);
  } catch {
    return '';
  }
}

async function readStaged(git, fs, dir, file) {
  // The index entry's blob: walk the STAGE tree for this one path.
  let text = '';
  await git.walk({
    fs,
    dir,
    trees: [git.STAGE()],
    map: async (filepath, [entry]) => {
      if (filepath === '.') return true;
      if (file !== filepath && !file.startsWith(filepath + '/')) return null;
      if (filepath === file && entry) text = dec.decode((await git.readBlob({ fs, dir, oid: await entry.oid() })).blob);
      return true;
    },
  });
  return text;
}

function printFileDiff(c, file, a, b) {
  c.out(`\x1b[1mdiff --git a/${file} b/${file}\x1b[0m\n`);
  if (!a) c.out('\x1b[1mnew file mode 100644\x1b[0m\n');
  if (!b) c.out('\x1b[1mdeleted file mode 100644\x1b[0m\n');
  if (a.includes('\u0000') || b.includes('\u0000')) {
    c.out(`Binary files ${a ? 'a/' + file : '/dev/null'} and ${b ? 'b/' + file : '/dev/null'} differ\n`);
    return;
  }
  c.out(`\x1b[1m--- ${a ? 'a/' + file : '/dev/null'}\x1b[0m\n\x1b[1m+++ ${b ? 'b/' + file : '/dev/null'}\x1b[0m\n`);
  let hunks = unifiedDiff(a, b);
  if (!hunks) c.out('(files differ too much to show)\n');
  else for (let l of hunks) c.out(l + '\n');
}

async function diffTrees(git, fs, dir, fromOid, toOid, c) {
  let trees = [git.TREE({ ref: fromOid || toOid }), git.TREE({ ref: toOid })];
  await git.walk({
    fs,
    dir,
    trees,
    map: async (filepath, [A, B]) => {
      if (filepath === '.') return true;
      let ta = A && (await A.type());
      let tb = B && (await B.type());
      if (ta === 'tree' || tb === 'tree') return true;
      let oa = fromOid && A ? await A.oid() : null;
      let ob = B ? await B.oid() : null;
      if (oa === ob) return null;
      let a = fromOid && A ? dec.decode(await A.content()) : '';
      let b = B ? dec.decode(await B.content()) : '';
      printFileDiff(c, filepath, a, b);
      return null;
    },
  });
}

void enc;
