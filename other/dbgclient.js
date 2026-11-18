/**
 * Browser-side Tehboxen debug client.
 * Always tries to connect to bin/dbgserver.mjs on boot, streams VFS events,
 * and runs RPC ops (shell / vfs.* / ping / eval) inside the page.
 *
 * Auth is loopback bind + Origin allowlist on the server — no shared secret
 * over HTTP (a token on /health would not be secret to other local processes).
 *
 * Optional overrides: ?dbgHost= / ?dbgPort=, or localStorage tehboxenDbgHost / Port.
 */
import { PLAYER, PLAYER_HOME } from './session.js';
import * as vfs from './vfs.js';
import { createVfsFs } from './vfs.js';
// shell.js pulls CDN deps — load it lazily so a connect-only boot can't fail
// if those imports are slow or blocked.

let DEFAULT_PORT = 8766;

/** Webfoundry preview uses hostnames like `tehboxen-<uuid>.localhost`. */
function defaultHost() {
  return '127.0.0.1';
}

let started = false;
/** @type {WebSocket | null} */
let ws = null;
/** @type {(() => void) | null} */
let unsubVfs = null;
/** @type {Map<string, any>} */
let shells = new Map();
let reconnectTimer = null;
/** @type {Promise<void> | null} */
let connectLock = null;
let cfg = { host: defaultHost(), port: DEFAULT_PORT };
let loggedWaiting = false;
let backoffMs = 1500;
let intentionalClose = false;
/** True only after server `hello`. */
let authenticated = false;

function readConfig() {
  let host = defaultHost();
  let port = DEFAULT_PORT;
  try {
    let q = new URLSearchParams(location.search || '');
    if (q.get('dbgHost')) host = q.get('dbgHost');
    if (q.get('dbgPort')) port = Number(q.get('dbgPort')) || port;
  } catch {}
  try {
    let h = localStorage.getItem('tehboxenDbgHost');
    let p = localStorage.getItem('tehboxenDbgPort');
    if (h) host = h;
    if (p) port = Number(p) || port;
  } catch {}
  return { host, port };
}

async function ensureShell(username) {
  let key = username || PLAYER;
  // Refresh actor every time so uid/gid remaps (and group membership) stick
  // without requiring a hard reload of the cached shell instance.
  if (shells.has(key)) {
    let sh = shells.get(key);
    try {
      await sh.become(key === 'nobody' ? 'nobody' : key);
    } catch {}
    return sh;
  }
  await vfs.ensureReady();
  let { createShell } = await import('./shell.js');
  let { actorFromUser, SHARED_ROOTS } = await import('./vfs-auth.js');
  let fs = createVfsFs();
  let sh = createShell(fs, {
    home: key === 'nobody' ? '' : 'home/' + key,
  });
  if (key === 'nobody') {
    let nobody = await actorFromUser('nobody');
    if (nobody) await sh.become('nobody');
    // nobody: no home login dir
    sh._sharedOnly = true;
    sh._sharedRoots = SHARED_ROOTS;
  } else {
    try {
      await sh.become(key);
    } catch {
      try {
        await sh.loadRc();
      } catch {}
    }
  }
  shells.set(key, sh);
  return sh;
}

function isSharedPath(path, roots) {
  let p = String(path || '').replace(/^\/+/, '');
  return (roots || []).some((r) => p === r || p.startsWith(r + '/'));
}

/** dbg actor id for unlockAll on disconnect (per-username). */
function dbgActor(username) {
  return 'dbg:' + (username || 'nobody');
}

/** Require an explicit lease object from RPC args (no auto-lock). */
function requireLease(args, op) {
  let lease = args?.lease;
  if (!lease || typeof lease !== 'object' || !lease.id) {
    throw Object.assign(
      new Error(
        op +
          ' requires args.lease from vfs.lock (no auto-lock — lock, then pass lease)',
      ),
      { code: 'ELOCK_REQUIRED' },
    );
  }
  return lease;
}

async function assertRpcPath(username, path, want) {
  let { actorFromUser, assertAccess, getStat } = await import('./vfs-auth.js');
  let { SHARED_ROOTS } = await import('./vfs-auth.js');
  let p = String(path || '').replace(/^\/+/, '');
  if (!username || username === 'nobody') {
    if (!isSharedPath(p, SHARED_ROOTS)) {
      let err = new Error('Permission denied (anonymous RPC is shared-dirs only)');
      err.code = 'EACCES';
      throw err;
    }
    if (want === 'w') {
      let err = new Error('Permission denied (anonymous RPC is read-only)');
      err.code = 'EACCES';
      throw err;
    }
    return;
  }
  let actor = await actorFromUser(username);
  if (!actor) {
    let err = new Error('Unknown user: ' + username);
    err.code = 'ENOENT';
    throw err;
  }
  if (want === 'w') {
    let st = await getStat(p);
    if (!st) {
      // Creating a new path: require write on the nearest existing ancestor
      // (intermediate dirs may not exist yet; ensureDir creates them later).
      let cur = p;
      while (cur.includes('/')) {
        cur = cur.slice(0, cur.lastIndexOf('/'));
        let pst = await getStat(cur);
        if (pst) {
          await assertAccess(cur, 'w', actor);
          return;
        }
      }
      return;
    }
  }
  await assertAccess(p, want === 'w' ? 'w' : 'r', actor);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function forwardVfsEvent(ev) {
  send({
    type: 'vfs',
    op: ev?.type,
    path: ev?.path,
    ts: Date.now(),
  });
}

function desktopNotify({ title, text, icon, accentTw }) {
  try {
    if (typeof rawctrls !== 'undefined' && rawctrls?.desktop?.actions?.notify) {
      rawctrls.desktop.actions.notify({ title, text, icon, accentTw });
      if (typeof d !== 'undefined' && d?.update) d.update();
      return;
    }
    if (typeof post === 'function') {
      post('desktop.notify', { title, text, icon, accentTw });
    }
  } catch (err) {
    console.warn('[dbgclient] notify failed', err);
  }
}

function notifyConnected() {
  desktopNotify({
    title: 'Debug bridge',
    text: 'Connected to dbgserver at ' + cfg.host + ':' + cfg.port,
    icon: 'nf-md-bug',
    accentTw: 'bg-emerald-500',
  });
}

function notifyDisconnected(reason) {
  let detail = reason ? ' (' + reason + ')' : '';
  desktopNotify({
    title: 'Debug bridge',
    text: 'Disconnected from dbgserver' + detail,
    icon: 'nf-md-bug',
    accentTw: 'bg-teal-500',
  });
}

function closeReason(ev) {
  if (intentionalClose) return 'stopped';
  if (ev?.code === 4001) return 'unauthorized';
  if (ev?.reason) return String(ev.reason);
  if (ev?.code === 1000) return '';
  if (ev?.code) return 'code ' + ev.code;
  return '';
}

async function handleRpc(msg) {
  let id = msg.id;
  let op = msg.op || msg.method;
  let args = msg.args || {};
  let user = msg.user ?? args.user ?? null;
  if (user === '' || user === undefined) user = null;
  try {
    let result = await runOp(op, args, user);
    send({ type: 'rpc_result', id, result });
  } catch (err) {
    // Prefer message when code is a bare number (vfs-auth uses code:1 for EACCES).
    let code = err?.code;
    let error =
      (typeof code === 'string' && code) ||
      err?.errno ||
      err?.message ||
      (code != null ? String(code) : null) ||
      String(err);
    send({
      type: 'rpc_error',
      id,
      error,
      errno: err?.errno || (typeof code === 'string' ? code : undefined),
    });
  }
}

async function runOp(op, args, user) {
  await vfs.ensureReady();
  // Default RPC identity: nobody (shared dirs only). Pass user:"<player>" etc. to act as someone.
  let username = user == null ? 'nobody' : String(user);

  switch (op) {
    case 'ping':
      return { pong: true, ts: Date.now(), user: username };

    case 'shell': {
      if (username === 'nobody') {
        throw Object.assign(new Error('shell requires user='), { code: 'EACCES' });
      }
      let sh = await ensureShell(username);
      let { formatResult } = await import('./shell.js');
      let cmd = String(args.cmd ?? args.command ?? '');
      if (args.cwd != null) {
        let cwd = String(args.cwd).replace(/^\/+/, '');
        await sh.run('cd /' + cwd);
      }
      let result = await sh.run(cmd);
      return {
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        text: formatResult(result),
        cwd: sh.cwd,
        user: sh.user,
      };
    }

    case 'vfs.lock': {
      let path = String(args.path || '');
      await assertRpcPath(username, path, args.mode === 'r' || args.mode === 'read' ? 'r' : 'w');
      let lease = await vfs.lock(path, {
        mode: args.mode || 'w',
        timeoutMs: args.timeoutMs,
        ttlMs: args.ttlMs,
        actor: dbgActor(username),
      });
      return { lease };
    }

    case 'vfs.unlock': {
      let lease = args.lease || args.id;
      let ok = await vfs.unlock(lease, args.path);
      return { ok };
    }

    case 'vfs.renew': {
      let lease = requireLease(args, 'vfs.renew');
      let next = await vfs.renew(lease, { ttlMs: args.ttlMs });
      return { lease: next };
    }

    case 'vfs.locks': {
      return { locks: await vfs.listLocks() };
    }

    case 'vfs.unlockAll': {
      let actor = args.actor || dbgActor(username);
      let n = await vfs.unlockAll(actor);
      return { unlocked: n, actor };
    }

    case 'vfs.read': {
      let path = String(args.path || '');
      await assertRpcPath(username, path, 'r');
      let lease = requireLease(args, 'vfs.read');
      let text = await vfs.read(path, { lease });
      return { path, text, exists: text != null };
    }

    case 'vfs.write': {
      let path = String(args.path || '');
      await assertRpcPath(username, path, 'w');
      let lease = requireLease(args, 'vfs.write');
      await vfs.write(path, String(args.text ?? args.content ?? ''), { lease });
      return { path, ok: true };
    }

    case 'vfs.append': {
      let path = String(args.path || '');
      await assertRpcPath(username, path, 'w');
      let lease = requireLease(args, 'vfs.append');
      await vfs.append(path, String(args.text ?? args.content ?? ''), { lease });
      return { path, ok: true };
    }

    case 'vfs.list': {
      let all = await vfs.list();
      let prefix = String(args.path || args.prefix || '').replace(/^\/+|\/+$/g, '');
      let { SHARED_ROOTS } = await import('./vfs-auth.js');
      let paths = prefix
        ? all.filter((p) => p === prefix || p.startsWith(prefix + '/'))
        : all;
      if (username === 'nobody') {
        paths = paths.filter((p) => isSharedPath(p, SHARED_ROOTS));
      }
      return { paths };
    }

    case 'vfs.exists': {
      let path = String(args.path || '');
      await assertRpcPath(username, path, 'r');
      return { path, exists: await vfs.exists(path) };
    }

    case 'vfs.remove': {
      let path = String(args.path || '');
      await assertRpcPath(username, path, 'w');
      let lease = requireLease(args, 'vfs.remove');
      await vfs.remove(path, { lease });
      return { path, ok: true };
    }

    case 'vfs.stat': {
      let path = String(args.path || '');
      await assertRpcPath(username, path, 'r');
      let st = await vfs.getStat(path);
      return { path, stat: st };
    }

    /**
     * Pull host-staged files into the VFS (scp put).
     * args: { dest, xferId, baseUrl, entries: [{ rel, contentType? }] }
     * Single file: entries=[{rel:''}] writes at dest.
     * Dir: entries=[{rel:'a/b.txt'},…] writes under dest/.
     */
    case 'vfs.put': {
      let dest = String(args.dest || '').replace(/^\/+/, '').replace(/\/+$/, '');
      let xferId = String(args.xferId || '');
      let baseUrl = String(args.baseUrl || '').replace(/\/+$/, '');
      let entries = Array.isArray(args.entries) ? args.entries : [];
      if (!dest || !xferId || !baseUrl || !entries.length) {
        throw Object.assign(new Error('vfs.put requires dest, xferId, baseUrl, entries'), {
          code: 'EINVAL',
        });
      }
      let { ensureDir } = await import('./messaging.js');
      let { actorFromUser } = await import('./vfs-auth.js');
      let actor = username && username !== 'nobody' ? await actorFromUser(username) : null;
      let fileMeta = actor
        ? { uid: actor.uid, gid: actor.gid }
        : undefined;
      let written = [];
      for (let ent of entries) {
        let rel = String(ent?.rel ?? ent?.path ?? '').replace(/^\/+/, '');
        if (rel.includes('..')) {
          throw Object.assign(new Error('vfs.put: invalid rel ' + rel), { code: 'EINVAL' });
        }
        let target = rel ? dest + '/' + rel : dest;
        await assertRpcPath(username, target, 'w');
        let parent = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : '';
        if (parent) {
          await ensureDir(parent);
          // ensureDir writes as root by default; chown ancestors we created under dest
          if (actor && parent.startsWith(dest)) {
            let cur = parent;
            while (cur && cur.startsWith(dest)) {
              let st = await vfs.getStat(cur);
              if (st && st.uid === 0) {
                await vfs.setStat(cur, { uid: actor.uid, gid: actor.gid });
              }
              if (!cur.includes('/')) break;
              cur = cur.slice(0, cur.lastIndexOf('/'));
              if (cur.length < dest.length) break;
            }
          }
        }
        let url = baseUrl + '/xfer/' + encodeURIComponent(xferId) + '/' + rel.split('/').map(encodeURIComponent).join('/');
        // trailing slash for empty rel → /xfer/id/
        if (!rel) url = baseUrl + '/xfer/' + encodeURIComponent(xferId) + '/__file__';
        let res = await fetch(url);
        if (!res.ok) {
          throw Object.assign(new Error('xfer fetch failed: ' + res.status + ' ' + url), {
            code: 'EIO',
          });
        }
        let blob = await res.blob();
        let type = ent?.contentType || blob.type || 'application/octet-stream';
        let meta = { ...(fileMeta || {}), lease: args.lease };
        if (args.lease) {
          await vfs.writeBlob(target, blob, type, meta);
        } else {
          // scp put: short exclusive lock per file (multi-file transfer)
          await vfs.withLock(
            target,
            (lease) => vfs.writeBlob(target, blob, type, { ...(fileMeta || {}), lease }),
            { mode: 'w', actor: dbgActor(username) },
          );
        }
        written.push({ path: target, size: blob.size, type });
      }
      return { dest, written, count: written.length };
    }

    /**
     * Export VFS file(s) as base64 in the RPC result (scp get).
     * Browser→loopback PUT is blocked by Private Network Access, so bytes
     * travel on the existing WebSocket RPC. Server writes staging / streams.
     * args: { path, recursive? }  (xferId/baseUrl ignored if present)
     */
    case 'vfs.get': {
      let src = String(args.path || '').replace(/^\/+/, '').replace(/\/+$/, '');
      let recursive = !!args.recursive;
      if (!src) {
        throw Object.assign(new Error('vfs.get requires path'), { code: 'EINVAL' });
      }
      await assertRpcPath(username, src, 'r');
      let files = [];
      let isDir = await vfs.isDirectory(src);
      if (isDir) {
        if (!recursive) {
          throw Object.assign(new Error('vfs.get: path is a directory (pass recursive)'), {
            code: 'EISDIR',
          });
        }
        let all = await vfs.list();
        let prefix = src + '/';
        let rels = new Set();
        for (let p of all) {
          if (!p.startsWith(prefix)) continue;
          let rest = p.slice(prefix.length);
          if (!rest || rest === '.keep' || rest.endsWith('/.keep')) continue;
          if (await vfs.isDirectory(p)) continue;
          rels.add(rest);
        }
        files = [...rels].sort();
      } else {
        if (!(await vfs.exists(src))) {
          throw Object.assign(new Error('No such file: ' + src), { code: 'ENOENT' });
        }
        files = ['']; // empty rel → single file
      }

      let exported = [];
      for (let rel of files) {
        let full = rel ? src + '/' + rel : src;
        await assertRpcPath(username, full, 'r');
        let blob = args.lease
          ? await vfs.readBlob(full, { lease: args.lease })
          : await vfs.withLock(
              full,
              (lease) => vfs.readBlob(full, { lease }),
              { mode: 'r', actor: dbgActor(username) },
            );
        if (!blob) continue;
        let ab = await blob.arrayBuffer();
        let bytes = new Uint8Array(ab);
        let b64 = '';
        let chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        b64 = btoa(b64);
        let baseName = src.includes('/') ? src.slice(src.lastIndexOf('/') + 1) : src;
        exported.push({
          rel: rel || baseName,
          path: full,
          size: blob.size,
          type: blob.type || 'application/octet-stream',
          single: !rel,
          data: b64,
        });
      }
      return {
        path: src,
        isDir,
        files: exported,
        count: exported.length,
      };
    }

    case 'eval': {
      if (username === 'nobody') {
        throw Object.assign(new Error('eval requires user='), { code: 'EACCES' });
      }
      let body = String(args.body || args.code || '');
      let AsyncFn = Object.getPrototypeOf(async function () {}).constructor;
      let fn = new AsyncFn('vfs', 'args', 'state', 'post', 'user', body);
      let value = await fn(vfs, args, globalThis.state, globalThis.post, username);
      return { value };
    }

    default:
      throw Object.assign(new Error('unknown_op: ' + op), { code: 'unknown_op' });
  }
}

function scheduleReconnect() {
  if (!started || intentionalClose) return;
  if (reconnectTimer) return;
  let wait = backoffMs;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => {});
  }, wait);
  backoffMs = Math.min(backoffMs * 1.5, 15000);
}

function hostCandidates() {
  let primary = cfg.host || defaultHost();
  let alts =
    primary === 'localhost'
      ? ['127.0.0.1']
      : primary === '127.0.0.1'
        ? ['localhost']
        : ['127.0.0.1', 'localhost'];
  return [primary, ...alts.filter((h) => h !== primary)];
}

async function probeServer() {
  for (let host of hostCandidates()) {
    try {
      let res = await fetch(`http://${host}:${cfg.port}/health`, {
        cache: 'no-store',
        mode: 'cors',
      });
      if (!res.ok) continue;
      let data = await res.json();
      if (data?.ok) {
        cfg.host = host;
        try {
          localStorage.setItem('tehboxenDbgHost', host);
        } catch {}
        return true;
      }
    } catch {
      // try next host
    }
  }
  return false;
}

async function beacon(stage) {
  for (let host of hostCandidates()) {
    try {
      await fetch(
        `http://${host}:${cfg.port}/beacon?stage=${encodeURIComponent(stage)}`,
        { method: 'POST', cache: 'no-store', mode: 'cors' },
      );
      return;
    } catch {}
  }
}

async function connect() {
  if (!started || intentionalClose) return;
  if (connectLock) return connectLock;

  connectLock = (async () => {
    try {
      if (!started || intentionalClose) return;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      let next = readConfig();
      cfg.host = next.host;
      cfg.port = next.port;

      let up = await probeServer();
      if (!up) {
        if (!loggedWaiting) {
          loggedWaiting = true;
          console.info(
            '[dbgclient] waiting for dbgserver on ' + cfg.host + ':' + cfg.port,
          );
        }
        scheduleReconnect();
        return;
      }

      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return;
      }

      // No token — server authenticates via loopback + Origin allowlist.
      let url = `ws://${cfg.host}:${cfg.port}/tehboxen`;
      let socket;
      let helloWait;
      let helloResolve;
      try {
        socket = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      ws = socket;
      helloWait = new Promise((resolve) => {
        helloResolve = resolve;
      });

      socket.addEventListener('open', () => {
        loggedWaiting = false;
        console.info('[dbgclient] socket open, awaiting hello…');
      });

      socket.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === 'hello') {
          if (!authenticated) {
            authenticated = true;
            backoffMs = 1500;
            console.info('[dbgclient] authenticated', url);
            send({ type: 'event', eventType: 'client', op: 'ready', ts: Date.now() });
            notifyConnected();
          }
          if (helloResolve) helloResolve(true);
          return;
        }
        if (msg.type === 'rpc') handleRpc(msg);
      });

      socket.addEventListener('close', (ev) => {
        if (helloResolve) helloResolve(false);
        if (ws === socket) ws = null;
        let wasAuth = authenticated;
        authenticated = false;
        // Drop any dbg-held leases so a crashed agent cannot block the VFS.
        vfs.unlockAll('dbg:nobody').catch(() => {});
        for (let key of shells.keys()) {
          vfs.unlockAll(dbgActor(key)).catch(() => {});
        }
        if (wasAuth && !intentionalClose) {
          notifyDisconnected(closeReason(ev));
        }
        if (!intentionalClose && started) scheduleReconnect();
      });

      socket.addEventListener('error', () => {
        // close will fire afterward and schedule reconnect
      });

      // Wait briefly for hello so callers/beacons see authenticated state.
      await Promise.race([
        helloWait,
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } finally {
      connectLock = null;
    }
  })();

  return connectLock;
}

async function beaconAndConnect() {
  await beacon('start');
  await connect();
  await beacon(authenticated ? 'connected' : 'waiting');
}

/**
 * Start the debug client (always-on). Safe to call multiple times.
 * @returns {Promise<boolean>}
 */
export async function startDbgClient() {
  intentionalClose = false;
  if (!started) {
    started = true;
    backoffMs = 1500;
    cfg = readConfig();
    await vfs.ensureReady();
    if (!unsubVfs) {
      unsubVfs = vfs.onChange(forwardVfsEvent);
    }
  }
  await beaconAndConnect();
  return true;
}

export function stopDbgClient() {
  intentionalClose = true;
  started = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (unsubVfs) {
    unsubVfs();
    unsubVfs = null;
  }
  if (ws) {
    try {
      ws.close(1000, 'stop');
    } catch {}
    ws = null;
  }
}

export function isDbgConnected() {
  return !!(authenticated && ws && ws.readyState === WebSocket.OPEN);
}
