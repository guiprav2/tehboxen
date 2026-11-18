/**
 * `node` for the Tehboxen shell (page side).
 *
 *   node [options] [ script.js | -e "script" | - ] [--] [arguments]
 *
 * Each invocation is a process: a dedicated module Worker (worker.js) that
 * reaches the VFS only through syscalls served here (host.js) over the
 * channel in channel.js. Blocking calls need SharedArrayBuffer, so the page
 * must be cross-origin isolated (Webfoundry: Settings → Hardened isolation;
 * deployed: COOP/COEP headers, see _headers).
 */
import { createHost } from './host.js';
import { serveWorker, SAB_SIZE } from './channel.js';

let enc = new TextEncoder();
let dec = new TextDecoder();
/** CDN library bundles built by earlier processes (commander), shared with new workers. */
let libCache = {};
/** Toolchain assets from the first clang run: compiled WebAssembly.Modules + resource tarball bytes. */
let toolCache = null;

/* ---------- transform cache: Babel output per file, shared by all processes ---------- */

let XC_LIMIT = 4000;
let xcMemory = new Map();
let xcStore = null;
function xcDb() {
  xcStore ??= import('https://cdn.jsdelivr.net/npm/localforage@1.10.0/+esm').then((m) => (m.default || m).createInstance({ name: 'tehboxen-node', storeName: 'transforms' }));
  return xcStore;
}
async function xcGet(key) {
  if (xcMemory.has(key)) return xcMemory.get(key);
  try {
    let v = await (await xcDb()).getItem(key);
    if (v) xcMemory.set(key, v);
    return v || null;
  } catch {
    return null;
  }
}
function xcSet(key, value) {
  xcMemory.set(key, value);
  if (xcMemory.size > XC_LIMIT) xcMemory.delete(xcMemory.keys().next().value);
  xcDb()
    .then((db) => db.setItem(key, value))
    .catch(() => {});
}

/* ---------- warm worker: modules, commander and libraries preloaded ---------- */

let warm = null;
function spawnWarm() {
  let worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'node' });
  let onMessage = (ev) => {
    let m = ev.data || {};
    if (m.t === 'lib-cache') libCache[m.key] = m.body;
    else if (m.t === 'xc-get') xcGet(m.key).then((value) => worker.postMessage({ t: 'xc-res', id: m.id, value }));
    else if (m.t === 'xc-set') xcSet(m.key, m.value);
  };
  worker.addEventListener('message', onMessage);
  let ready = new Promise((resolve) => {
    let h = (ev) => {
      if (ev.data?.t !== 'ready') return;
      worker.removeEventListener('message', h);
      resolve();
    };
    worker.addEventListener('message', h);
    worker.addEventListener('error', () => resolve(), { once: true });
  });
  worker.postMessage({ t: 'warm', libCache });
  return { worker, ready };
}

function isolated() {
  return !!globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
}

/** Start a spare node worker ahead of time (the Terminal calls this when it opens). */
export function prewarmNode() {
  if (isolated() && !warm) warm = spawnWarm();
}

function takeWorker() {
  let w = warm || spawnWarm();
  warm = null;
  // The next process gets a fresh worker; warm it in the background.
  setTimeout(prewarmNode, 0);
  return w;
}

let NOT_ISOLATED = `node: this page is not cross-origin isolated, so node processes can't block on the filesystem.
  In Webfoundry: Settings → Hardened isolation.
  When deployed: serve COOP: same-origin and COEP: credentialless (see _headers).
`;

/**
 * @param {string[]} argv arguments after `node`
 * @param {object} ctx
 * @param {string} ctx.cwd absolute cwd ('/home/x')
 * @param {Record<string,string>} ctx.env exported shell env
 * @param {{name,uid,gid,gids,home,shell}} ctx.actor
 * @param {string|null} ctx.stdin piped stdin (null when none)
 * @param {AbortSignal} [ctx.signal] Ctrl-C / kill
 * @param {{ out: (s: string) => void, err: (s: string) => void }} [ctx.live] stream output instead of buffering
 * @param {(cmd: string, o: { cwd?: string, env?: object, stdin?: string }) => Promise<{code,stdout,stderr}>} ctx.exec
 * @param {number} ctx.pid  @param {number} [ctx.ppid]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runNode(argv, ctx) {
  if (!isolated()) {
    if (ctx.live) {
      ctx.live.err(NOT_ISOLATED);
      return { code: 1, stdout: '', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: NOT_ISOLATED };
  }

  let outChunks = [];
  let errChunks = [];
  let outDec = new TextDecoder();
  let errDec = new TextDecoder();
  let onOut = (b) => (ctx.live ? ctx.live.out(outDec.decode(b, { stream: true })) : outChunks.push(b));
  let onErr = (b) => (ctx.live ? ctx.live.err(errDec.decode(b, { stream: true })) : errChunks.push(b));
  let join = (chunks) => {
    let all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    let o = 0;
    for (let c of chunks) {
      all.set(c, o);
      o += c.length;
    }
    return dec.decode(all);
  };

  let pid = ctx.pid;
  let sab = new SharedArrayBuffer(SAB_SIZE);
  let host = createHost({ actor: ctx.actor, hostname: ctx.env?.HOSTNAME, exec: ctx.exec });
  let worker;
  try {
    let w = takeWorker();
    worker = w.worker;
    // Don't wait for a cold worker to finish preloading: init is queued behind it anyway.
  } catch (err) {
    return { code: 1, stdout: '', stderr: `node: cannot start a worker: ${err?.message || err}\n` };
  }

  return new Promise((resolve) => {
    let done = false;
    let watches = new Map();
    let finish = (code) => {
      if (done) return;
      done = true;
      for (let off of watches.values()) off();
      worker.terminate();
      host.dispose();
      if (ctx.live) {
        let a = outDec.decode();
        let b = errDec.decode();
        if (a) ctx.live.out(a);
        if (b) ctx.live.err(b);
      }
      resolve({ code, stdout: join(outChunks), stderr: join(errChunks) });
    };

    serveWorker(worker, sab, host, (m) => {
      if (m.t === 'out') onOut(m.b);
      else if (m.t === 'err') onErr(m.b);
      else if (m.t === 'exit') finish(m.code);
      else if (m.t === 'tool-cache') toolCache = { ...m.assets, sysroots: toolCache?.sysroots };
      else if (m.t === 'tool-cache-sysroot') toolCache = { ...(toolCache || {}), sysroots: { ...(toolCache?.sysroots || {}), [m.key]: m.tgz } };
      else if (m.t === 'watch') {
        watches.set(m.wid, host.watch(m.path, ({ eventType, filename }) => worker.postMessage({ t: 'watch-ev', wid: m.wid, eventType, filename })));
      } else if (m.t === 'unwatch') {
        watches.get(m.wid)?.();
        watches.delete(m.wid);
      }
    });
    worker.addEventListener('error', (ev) => {
      ev.preventDefault?.();
      onErr(enc.encode(`node: worker crashed: ${ev.message || 'unknown error'}${ev.filename ? ` (${ev.filename}:${ev.lineno})` : ''}\n`));
      finish(70);
    });
    worker.addEventListener('messageerror', () => {
      onErr(enc.encode('node: worker message could not be decoded\n'));
      finish(70);
    });

    // Ctrl-C / kill: deliver the signal; if the process doesn't exit in time
    // (busy in synchronous code, or it ignores the signal) terminate it.
    ctx.signal?.addEventListener('abort', () => {
      let sig = ctx.signal.reason?.signal || 'SIGINT';
      let code = 128 + ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }[sig] || 2);
      if (sig === 'SIGKILL') return finish(code);
      worker.postMessage({ t: 'signal', sig });
      setTimeout(() => finish(code), 1500);
    });

    let stdin = ctx.stdin != null ? enc.encode(ctx.stdin) : new Uint8Array(0);
    worker.postMessage({
      t: 'init',
      argv,
      env: ctx.env,
      cwd: ctx.cwd,
      actor: ctx.actor,
      stdin,
      stdinPiped: ctx.stdin != null,
      // Output streaming straight to the Terminal = a TTY (like node in a real terminal).
      tty: ctx.live ? { columns: Number(ctx.live.columns) || 80, rows: Number(ctx.live.rows) || 24 } : null,
      sab,
      libCache,
      tool: ctx.tool || null,
      toolCache: ctx.tool ? toolCache : null,
      pid,
      ppid: ctx.ppid ?? pid - 1,
    });
  });
}
