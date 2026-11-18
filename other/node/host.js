/**
 * Main-thread side of node's system calls.
 *
 * A node process runs in a Worker; every fs / process operation it needs is
 * a "syscall" handled here against the real VFS (other/vfs.js) with the
 * process user's permissions. Nothing is snapshotted: directory listings come
 * from a shared, incrementally maintained index, and file contents are read
 * per call, so node_modules-sized trees cost nothing until they're touched.
 *
 * Paths are absolute POSIX paths ('/home/x/a.js'); VFS keys have no leading
 * slash. Errors are thrown as { code, syscall, path, dest, message } objects
 * shaped like Node's fs errors.
 */
import * as vfs from '../vfs.js';
import { resolveLinkTarget } from '../vfs.js';

let enc = new TextEncoder();

/* ---------- shared directory index ---------- */

let index = null; // Map<dirKey, Map<name, 'file'|'dir'|'symlink'>>
let indexReady = null;
let indexDirty = false;
let unsubscribe = null;

function ensureDir(idx, key) {
  if (!idx.has(key)) idx.set(key, new Map());
  if (!key) return;
  let i = key.lastIndexOf('/');
  let parent = i === -1 ? '' : key.slice(0, i);
  let name = key.slice(i + 1);
  ensureDir(idx, parent);
  idx.get(parent).set(name, 'dir');
}

function addEntry(idx, key, kind) {
  if (kind === 'dir') return ensureDir(idx, key);
  let i = key.lastIndexOf('/');
  let parent = i === -1 ? '' : key.slice(0, i);
  ensureDir(idx, parent);
  let cur = idx.get(parent).get(key.slice(i + 1));
  if (cur !== 'dir') idx.get(parent).set(key.slice(i + 1), kind);
}

function removeEntry(idx, key) {
  let i = key.lastIndexOf('/');
  let parent = i === -1 ? '' : key.slice(0, i);
  idx.get(parent)?.delete(key.slice(i + 1));
  for (let k of [...idx.keys()]) if (k === key || k.startsWith(key + '/')) idx.delete(k);
}

async function buildIndex() {
  let idx = new Map([['', new Map()]]);
  for (let { path, kind } of await vfs.listKinds()) {
    if (path === '') continue;
    if (path.endsWith('/.keep') || path === '.keep') continue;
    addEntry(idx, path, kind);
  }
  return idx;
}

/** The directory index, built once per page and kept current from VFS change events. */
export async function getIndex() {
  if (index && !indexDirty) return index;
  if (indexReady && !indexDirty) return indexReady;
  indexDirty = false;
  indexReady = buildIndex().then((idx) => (index = idx));
  unsubscribe ??= vfs.onChange(async (ev) => {
    let key = String(ev?.path || '').replace(/\/\.keep$/, '');
    if (!index || ev.type === 'move' || ev.type === 'clear') {
      indexDirty = true;
      return;
    }
    if (ev.type === 'remove') {
      if (String(ev.path).endsWith('/.keep')) removeEntry(index, key);
      else removeEntry(index, key);
      return;
    }
    if (ev.type === 'write') {
      if (String(ev.path).endsWith('/.keep')) return addEntry(index, key, 'dir');
      // Apply synchronously (readers right after a write must see it); refine symlinks after.
      addEntry(index, key, ev.kind || 'file');
      if (!ev.kind && (await vfs.isSymlink(key).catch(() => false))) addEntry(index, key, 'symlink');
    }
  });
  return indexReady;
}

/* ---------- errors ---------- */

let MSG = {
  ENOENT: 'no such file or directory', EACCES: 'permission denied', EEXIST: 'file already exists',
  ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory', EINVAL: 'invalid argument',
  ENOTEMPTY: 'directory not empty', EPERM: 'operation not permitted', ELOOP: 'too many symbolic links encountered',
  EXDEV: 'cross-device link not permitted',
  EBUSY: 'resource busy or locked',
};
let ERRNO = { EBUSY: -16, ENOENT: -2, EACCES: -13, EEXIST: -17, ENOTDIR: -20, EISDIR: -21, EINVAL: -22, ENOTEMPTY: -39, EPERM: -1, ELOOP: -40, EXDEV: -18 };

export function sysError(code, syscall, path, dest) {
  let message = `${code}: ${MSG[code] || code}, ${syscall}${path != null ? ` '${path}'` : ''}${dest != null ? ` -> '${dest}'` : ''}`;
  return { __syserr: true, code, errno: ERRNO[code] ?? -1, syscall, path, dest, message };
}

/* ---------- host ---------- */

let keyOf = (abs) => String(abs).replace(/^\/+/, '').replace(/\/+$/, '');
let absOf = (key) => '/' + key;
let parentKey = (key) => (key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '');
let baseName = (key) => key.slice(key.lastIndexOf('/') + 1);

function utf8Len(str) {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * @param {object} o
 * @param {{name,uid,gid,gids,home}} o.actor
 * @param {string} [o.hostname]
 * @param {(cmd: string, opts: object) => Promise<{code,stdout,stderr}>} o.exec
 */
export function createHost(o) {
  let actor = o.actor;
  let isRoot = Number(actor.uid) === 0;
  let gids = new Set([Number(actor.gid), ...(actor.gids || []).map(Number)]);
  let fsAdapter = vfs.createVfsFs();

  /* ---------- open-file locks ----------
   * Read-only opens hold a shared 'r' lease, write / read-write opens an
   * exclusive 'w' lease, until the last fd on the file closes or the process
   * ends (dispose). Leases are renewed while held; the VFS TTL only frees
   * them if the page itself dies. The process's own I/O reuses its leases.
   */
  let actorTag = `node:${actor.name}:${Math.random().toString(36).slice(2, 8)}`;
  let held = new Map(); // lock key (VFS key) → { lease, mode, count }
  let renewTimer = null;
  let renewAll = () => {
    for (let h of held.values()) vfs.renew(h.lease).catch(() => {});
  };
  let ensureRenewal = () => {
    if (held.size && !renewTimer) renewTimer = setInterval(renewAll, 10000);
    if (!held.size && renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  };
  let acquire = async (key, mode) => {
    try {
      return await vfs.lock(key, { mode, actor: actorTag });
    } catch (err) {
      if (err instanceof vfs.LockTimeoutError) throw sysError('EBUSY', 'open', absOf(key));
      throw err;
    }
  };
  async function openLock(key, write) {
    let h = held.get(key);
    let mode = write ? 'w' : 'r';
    if (h && (h.mode === 'w' || mode === 'r')) {
      h.count++;
      return;
    }
    if (h) {
      // Upgrade r → w: drop our shared lease first (it would block our own exclusive request).
      await vfs.unlock(h.lease).catch(() => {});
      try {
        h.lease = await acquire(key, 'w');
        h.mode = 'w';
        h.count++;
      } catch (err) {
        h.lease = await acquire(key, 'r');
        throw err;
      }
      return;
    }
    held.set(key, { lease: await acquire(key, mode), mode, count: 1 });
    ensureRenewal();
  }
  async function closeLock(key) {
    let h = held.get(key);
    if (!h) return;
    if (--h.count > 0) return;
    held.delete(key);
    await vfs.unlock(h.lease).catch(() => {});
    ensureRenewal();
  }
  /** Our held lease for key, or for another name of the same inode (hardlinks share one lock). */
  async function findHeld(key) {
    let h = held.get(key);
    if (h || !held.size) return h;
    let ino = await vfs.getIno(key).catch(() => null);
    if (ino == null) return undefined;
    for (let [k, x] of held) if ((await vfs.getIno(k).catch(() => null)) === ino) return x;
    return undefined;
  }

  /** Run fn with a lease on key: ours if this process holds a strong enough one, else a short-lived one. */
  async function withKey(key, mode, fn) {
    let h = await findHeld(key);
    if (h && (h.mode === 'w' || mode === 'r')) return fn(h.lease);
    if (h) {
      // We hold 'r' but need to write: upgrade for the duration, then go back to 'r'.
      await vfs.unlock(h.lease).catch(() => {});
      let lease = await acquire(key, 'w');
      try {
        return await fn(lease);
      } finally {
        await vfs.unlock(lease).catch(() => {});
        h.lease = await acquire(key, 'r');
      }
    }
    return vfs.withLock(key, fn, { mode, actor: actorTag });
  }
  /** Before unlink / rename: locks follow names, so let go of ours on this path (and below). */
  async function dropLocks(key) {
    for (let [k, h] of [...held]) {
      if (k === key || k.startsWith(key + '/')) {
        held.delete(k);
        await vfs.unlock(h.lease).catch(() => {});
      }
    }
    ensureRenewal();
  }

  /* virtual files */
  let virtual = {
    'etc/passwd': { mode: 0o644, uid: 0, gid: 0, text: async () => {
      let users = await vfs.listUsers();
      return Object.values(users).sort((a, b) => a.uid - b.uid).map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.gecos || ''}:/${u.home || ''}:${u.shell || '/bin/boxsh'}`).join('\n') + '\n';
    } },
    'etc/group': { mode: 0o644, uid: 0, gid: 0, text: async () => {
      let groups = await vfs.listGroups();
      return Object.values(groups).sort((a, b) => a.gid - b.gid).map((g) => `${g.name}:x:${g.gid}:${(g.members || []).join(',')}`).join('\n') + '\n';
    } },
    'etc/shadow': { mode: 0o640, uid: 0, gid: 42, text: async () => {
      let users = await vfs.listUsers();
      let shadow = await vfs.readShadow();
      return Object.values(users).map((u) => `${u.name}:${shadow[u.name] || (u.human ? '!' : '*')}:19700:0:99999:7:::`).join('\n') + '\n';
    } },
    'etc/hostname': { mode: 0o644, uid: 0, gid: 0, text: async () => (o.hostname || 'tehboxen') + '\n' },
    'etc/os-release': { mode: 0o644, uid: 0, gid: 0, text: async () => 'NAME="Tehboxen"\nID=tehboxen\nPRETTY_NAME="Tehboxen (simulated)"\nVERSION_ID="1"\n' },
  };
  let devices = new Set(['dev/null', 'dev/zero', 'dev/random', 'dev/urandom', 'dev/tty', 'dev/stdin', 'dev/stdout', 'dev/stderr']);
  let virtualDirs = new Set(['etc', 'dev', 'tmp', 'proc']);

  async function kindOf(key) {
    if (key === '') return 'dir';
    if (virtual[key] || devices.has(key)) return 'file';
    let idx = await getIndex();
    let parent = idx.get(parentKey(key));
    let k = parent?.get(baseName(key));
    if (k) return k;
    if (idx.has(key)) return 'dir';
    if (virtualDirs.has(key)) return 'dir';
    return null;
  }

  async function statOf(key) {
    let v = virtual[key];
    if (v) return { mode: v.mode, uid: v.uid, gid: v.gid };
    if (devices.has(key)) return { mode: 0o666, uid: 0, gid: 0 };
    if (virtualDirs.has(key) && !(await vfs.getStat(key))) return { mode: key === 'tmp' ? 0o1777 : 0o755, uid: 0, gid: 0 };
    return (await vfs.getStat(key)) || null;
  }

  async function can(key, want) {
    if (isRoot) return true;
    let st = await statOf(key);
    let kind = await kindOf(key);
    if (!st) return want === 'r' || (want === 'x' && kind === 'dir') || (want === 'w' && key === 'tmp');
    let mode = Number(st.mode ?? (kind === 'dir' ? 0o755 : 0o644)) & 0o777;
    let bit = want === 'r' ? 4 : want === 'w' ? 2 : 1;
    if (Number(actor.uid) === Number(st.uid)) return ((mode >> 6) & bit) === bit;
    if (gids.has(Number(st.gid))) return ((mode >> 3) & bit) === bit;
    return (mode & bit) === bit;
  }

  async function traverse(key, syscall, display) {
    if (isRoot) return;
    let acc = '';
    for (let part of parentKey(key).split('/').filter(Boolean)) {
      acc = acc ? acc + '/' + part : part;
      if ((await kindOf(acc)) === 'dir' && !(await can(acc, 'x'))) throw sysError('EACCES', syscall, display);
    }
  }

  async function need(key, want, syscall, display) {
    await traverse(key, syscall, display);
    if (!(await can(key, want))) throw sysError('EACCES', syscall, display);
  }

  async function needCreate(key, syscall, display) {
    let parent = parentKey(key);
    let pk = await kindOf(parent);
    if (pk !== 'dir') throw sysError(pk ? 'ENOTDIR' : 'ENOENT', syscall, display);
    await traverse(key, syscall, display);
    if (!(await can(parent, 'w')) || !(await can(parent, 'x'))) throw sysError('EACCES', syscall, display);
  }

  /** Resolve symlinks in every component (and the last one unless noFollowLast). */
  async function realKey(key, syscall, display, noFollowLast = false, depth = 0) {
    if (depth > 40) throw sysError('ELOOP', syscall, display);
    let parts = key.split('/').filter(Boolean);
    let acc = '';
    for (let i = 0; i < parts.length; i++) {
      acc = acc ? acc + '/' + parts[i] : parts[i];
      let last = i === parts.length - 1;
      if (last && noFollowLast) break;
      if ((await kindOf(acc)) === 'symlink') {
        let target = resolveLinkTarget(acc, await vfs.readlink(acc));
        let rest = parts.slice(i + 1).join('/');
        return realKey(rest ? target + '/' + rest : target, syscall, display, noFollowLast, depth + 1);
      }
    }
    return acc;
  }

  async function sizeOf(key, kind) {
    if (kind === 'dir') return 4096;
    if (virtual[key]) return utf8Len(await virtual[key].text());
    if (devices.has(key)) return 0;
    if (kind === 'symlink') return String(await vfs.readlink(key)).length;
    let st = await vfs.getStat(key);
    if (st?.size != null) return Number(st.size);
    return vfs.sizeOf(key);
  }

  async function statResult(key, kind) {
    let st = (await statOf(key)) || {};
    return {
      kind: devices.has(key) ? 'chr' : kind,
      mode: Number(st.mode ?? (kind === 'dir' ? 0o755 : kind === 'symlink' ? 0o777 : 0o644)) & 0o7777,
      uid: Number(st.uid ?? 0),
      gid: Number(st.gid ?? 0),
      mtime: Number(st.mtime) || Date.now(),
      ino: st.ino ?? null,
      nlink: st.nlink || 1,
      size: await sizeOf(key, kind),
    };
  }

  async function readBytes(key) {
    if (virtual[key]) return enc.encode(await virtual[key].text());
    if (key === 'dev/null') return new Uint8Array(0);
    if (key === 'dev/zero') return new Uint8Array(65536);
    if (key === 'dev/random' || key === 'dev/urandom') return crypto.getRandomValues(new Uint8Array(4096));
    let blob = await withKey(key, 'r', (lease) => vfs.readBlob(key, { lease }));
    if (!blob) return new Uint8Array(0);
    return new Uint8Array(await blob.arrayBuffer());
  }

  async function writeBytes(key, data, meta) {
    // Text stays a string in the VFS (so apps, grep and the editor keep working); binary becomes a Blob.
    let text = typeof data === 'string' ? data : null;
    if (text == null) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {}
      if (text != null && text.includes('\u0000')) text = null;
    }
    if (text != null) return withKey(key, 'w', (lease) => vfs.write(key, text, { ...(meta || {}), lease }));
    return withKey(key, 'w', (lease) => vfs.writeBlob(key, new Blob([data]), { ...(meta || {}), lease }));
  }

  let ops = {
    async stat({ path, follow = true }) {
      let raw = keyOf(path);
      let key = await realKey(raw, follow ? 'stat' : 'lstat', path, !follow);
      let kind = await kindOf(key);
      if (!kind) throw sysError('ENOENT', follow ? 'stat' : 'lstat', path);
      await traverse(key, 'stat', path);
      return statResult(key, kind);
    },

    async access({ path, mode = 0 }) {
      let key = await realKey(keyOf(path), 'access', path);
      if (!(await kindOf(key))) throw sysError('ENOENT', 'access', path);
      await traverse(key, 'access', path);
      for (let [bit, want] of [[4, 'r'], [2, 'w'], [1, 'x']]) if (mode & bit && !(await can(key, want))) throw sysError('EACCES', 'access', path);
      return true;
    },

    async realpath({ path }) {
      let key = await realKey(keyOf(path), 'realpath', path);
      if (!(await kindOf(key))) throw sysError('ENOENT', 'realpath', path);
      return absOf(key);
    },

    async readdir({ path }) {
      let key = await realKey(keyOf(path), 'scandir', path);
      let kind = await kindOf(key);
      if (!kind) throw sysError('ENOENT', 'scandir', path);
      if (kind !== 'dir') throw sysError('ENOTDIR', 'scandir', path);
      await need(key, 'r', 'scandir', path);
      let idx = await getIndex();
      let out = [...(idx.get(key) || new Map())].filter(([n]) => n !== '.keep');
      if (key === '') for (let d of virtualDirs) if (!out.some(([n]) => n === d)) out.push([d, 'dir']);
      if (key === 'etc') for (let f of Object.keys(virtual)) if (!out.some(([n]) => n === baseName(f))) out.push([baseName(f), 'file']);
      if (key === 'dev') for (let f of devices) out.push([baseName(f), 'chr']);
      return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, k]) => ({ name, kind: k }));
    },

    async readFile({ path }) {
      let key = await realKey(keyOf(path), 'open', path);
      let kind = await kindOf(key);
      if (!kind) throw sysError('ENOENT', 'open', path);
      if (kind === 'dir') throw sysError('EISDIR', 'read');
      await need(key, 'r', 'open', path);
      return readBytes(key);
    },

    async writeFile({ path, data, mode = 0o666, flag = 'w' }) {
      let key = await realKey(keyOf(path), 'open', path);
      if (key === 'dev/null') return true;
      if (virtual[key] || devices.has(key)) throw sysError('EACCES', 'open', path);
      let kind = await kindOf(key);
      if (kind === 'dir') throw sysError('EISDIR', 'open', path);
      let meta;
      if (!kind) {
        await needCreate(key, 'open', path);
        meta = { mode: Number(mode) & ~0o022 & 0o777, uid: Number(actor.uid), gid: Number(actor.gid) };
      } else {
        if (String(flag).includes('x')) throw sysError('EEXIST', 'open', path);
        await need(key, 'w', 'open', path);
      }
      let next = data;
      if (String(flag).startsWith('a') && kind) {
        let prev = await readBytes(key);
        let add = typeof data === 'string' ? enc.encode(data) : data;
        next = new Uint8Array(prev.length + add.length);
        next.set(prev);
        next.set(add, prev.length);
      }
      await writeBytes(key, next, meta);
      return true;
    },

    async mkdir({ path, recursive = false, mode = 0o777 }) {
      let key = keyOf(path);
      let m = Number(mode) & ~0o022 & 0o777;
      let make = async (k) => {
        await fsAdapter.write(k + '/.keep', '', { uid: Number(actor.uid), gid: Number(actor.gid), mode: m });
        await vfs.setStat(k, { kind: 'dir', mode: m, uid: Number(actor.uid), gid: Number(actor.gid) });
        addEntry(await getIndex(), k, 'dir');
      };
      if (recursive) {
        let acc = '';
        let first;
        for (let part of key.split('/').filter(Boolean)) {
          acc = acc ? acc + '/' + part : part;
          let real = await realKey(acc, 'mkdir', path);
          let kind = await kindOf(real);
          if (kind === 'dir') continue;
          if (kind) throw sysError('EEXIST', 'mkdir', path);
          await needCreate(real, 'mkdir', path);
          await make(real);
          first ??= absOf(real);
        }
        return first ?? null;
      }
      let real = await realKey(key, 'mkdir', path);
      if (await kindOf(real)) throw sysError('EEXIST', 'mkdir', path);
      await needCreate(real, 'mkdir', path);
      await make(real);
      return null;
    },

    async rm({ path, recursive = false, force = false, dirOnly = false, fileOnly = false, syscall = 'rm' }) {
      let raw = keyOf(path);
      let key = await realKey(raw, syscall, path, true);
      let kind = await kindOf(key);
      if (!kind) {
        if (force) return false;
        throw sysError('ENOENT', syscall, path);
      }
      if (virtual[key] || devices.has(key) || virtualDirs.has(key)) throw sysError('EPERM', syscall, path);
      if (dirOnly && kind !== 'dir') throw sysError('ENOTDIR', syscall, path);
      if (fileOnly && kind === 'dir') throw sysError('EISDIR', syscall, path);
      await traverse(key, syscall, path);
      if (!(await can(parentKey(key), 'w'))) throw sysError('EACCES', syscall, path);
      if (kind === 'dir') {
        let idx = await getIndex();
        let kids = [...(idx.get(key) || new Map()).keys()].filter((n) => n !== '.keep');
        if (kids.length && !recursive) throw sysError('ENOTEMPTY', syscall, path);
        await dropLocks(key);
        await fsAdapter.remove(key + '/');
      } else {
        // The file (or another name of its inode) may be locked by this process: remove under that lease.
        await dropLocks(key);
        await withKey(key, 'w', (lease) => vfs.remove(key, { lease }));
      }
      removeEntry(await getIndex(), key);
      return true;
    },

    async rename({ from, to }) {
      let src = await realKey(keyOf(from), 'rename', from, true);
      let destParent = await realKey(parentKey(keyOf(to)), 'rename', from);
      let dest = (destParent ? destParent + '/' : '') + baseName(keyOf(to));
      let kind = await kindOf(src);
      if (!kind) throw sysError('ENOENT', 'rename', from, to);
      await traverse(src, 'rename', from);
      if (!(await can(parentKey(src), 'w'))) throw sysError('EACCES', 'rename', from, to);
      let destKind = await kindOf(dest);
      if (destKind === 'dir' && kind !== 'dir') throw sysError('EISDIR', 'rename', from, to);
      if (!destKind) await needCreate(dest, 'rename', to);
      else {
        await traverse(dest, 'rename', to);
        if (!(await can(parentKey(dest), 'w'))) throw sysError('EACCES', 'rename', from, to);
        if (destKind !== 'dir') await fsAdapter.remove(dest);
      }
      await dropLocks(src);
      await dropLocks(dest);
      await fsAdapter.move(kind === 'dir' ? src + '/' : src, dest);
      indexDirty = true;
      return true;
    },

    async symlink({ target, path }) {
      let key = keyOf(path);
      if (await kindOf(key)) throw sysError('EEXIST', 'symlink', target, path);
      await needCreate(key, 'symlink', path);
      let t = String(target);
      let stored = t.startsWith('/') ? t.replace(/^\/+/, '') : t.startsWith('.') ? t : './' + t;
      await fsAdapter.symlink(stored, key, { uid: Number(actor.uid), gid: Number(actor.gid) });
      await vfs.setStat(key, { kind: 'symlink', linkText: t });
      addEntry(await getIndex(), key, 'symlink');
      return true;
    },

    async readlink({ path }) {
      let raw = keyOf(path);
      let key = await realKey(raw, 'readlink', path, true);
      let kind = await kindOf(key);
      if (kind !== 'symlink') throw sysError(kind ? 'EINVAL' : 'ENOENT', 'readlink', path);
      let st = await vfs.getStat(key);
      if (st?.linkText != null) return st.linkText;
      let t = String(await vfs.readlink(key));
      return t.startsWith('.') ? t : '/' + t.replace(/^\/+/, '');
    },

    async link({ existing, path }) {
      let src = await realKey(keyOf(existing), 'link', existing);
      let dest = keyOf(path);
      let kind = await kindOf(src);
      if (kind !== 'file') throw sysError(kind ? 'EPERM' : 'ENOENT', 'link', existing, path);
      if (await kindOf(dest)) throw sysError('EEXIST', 'link', existing, path);
      await need(src, 'r', 'link', existing);
      await needCreate(dest, 'link', path);
      // The source may be open (and locked) by this very process: reuse that lease.
      await withKey(src, 'w', (srcLease) => vfs.withLock(dest, (lease) => vfs.link(src, dest, { srcLease, lease }), { mode: 'w', actor: actorTag }));
      addEntry(await getIndex(), dest, 'file');
      return true;
    },

    async chmod({ path, mode }) {
      let key = await realKey(keyOf(path), 'chmod', path);
      let kind = await kindOf(key);
      if (!kind) throw sysError('ENOENT', 'chmod', path);
      let st = (await statOf(key)) || {};
      if (!isRoot && Number(st.uid) !== Number(actor.uid)) throw sysError('EPERM', 'chmod', path);
      await vfs.setStat(key, { ...st, kind: kind === 'dir' ? 'dir' : 'file', mode: Number(mode) & 0o7777 });
      return true;
    },

    async chown({ path, uid, gid }) {
      let key = await realKey(keyOf(path), 'chown', path);
      if (!(await kindOf(key))) throw sysError('ENOENT', 'chown', path);
      if (!isRoot) throw sysError('EPERM', 'chown', path);
      let st = (await statOf(key)) || {};
      await vfs.setStat(key, { ...st, uid: uid === -1 ? st.uid : Number(uid), gid: gid === -1 ? st.gid : Number(gid) });
      return true;
    },

    async utimes({ path, mtime, follow = true }) {
      let key = await realKey(keyOf(path), 'utime', path, !follow);
      if (!(await kindOf(key))) throw sysError('ENOENT', 'utime', path);
      await need(key, 'w', 'utime', path);
      await vfs.setStat(key, { ...((await statOf(key)) || {}), mtime: Number(mtime) });
      return true;
    },

    async lock({ path, write = false }) {
      let key = await realKey(keyOf(path), 'open', path);
      if ((await kindOf(key)) !== 'file' || virtual[key] || devices.has(key)) return false;
      await openLock(key, !!write);
      return true;
    },

    async unlock({ path }) {
      let key = await realKey(keyOf(path), 'close', path).catch(() => keyOf(path));
      await closeLock(key);
      return true;
    },

    exec({ cmd, cwd, env, stdin }) {
      return o.exec(cmd, { cwd, env, stdin });
    },
  };

  return {
    /** Run one syscall; resolves with its value or rejects with a sysError-shaped object. */
    async call(op, args) {
      let fn = ops[op];
      if (!fn) throw { __syserr: true, code: 'ENOSYS', errno: -38, syscall: op, message: `ENOSYS: function not implemented, ${op}` };
      try {
        return await fn(args || {});
      } catch (err) {
        if (err?.__syserr) throw err;
        if (err instanceof vfs.LockTimeoutError) throw sysError('EBUSY', op, args?.path);
        if (err?.errno === 'EACCES' || /Permission denied/.test(String(err?.message))) throw sysError('EACCES', op, args?.path);
        throw { __syserr: true, code: err?.code && typeof err.code === 'string' ? err.code : 'EIO', errno: -5, syscall: op, path: args?.path, message: String(err?.message || err) };
      }
    },
    /** Process ended: release every lease it still holds. */
    async dispose() {
      for (let h of held.values()) await vfs.unlock(h.lease).catch(() => {});
      held.clear();
      ensureRenewal();
    },
    /** Subscribe to VFS changes under a path (fs.watch). Returns an unsubscribe function. */
    watch(path, fn) {
      let key = keyOf(path);
      return vfs.onChange((ev) => {
        let k = String(ev?.path || '').replace(/\/\.keep$/, '');
        if (k === key || k.startsWith(key + '/')) fn({ eventType: ev.type === 'write' ? 'change' : 'rename', filename: k === key ? baseName(key) : k.slice(key.length + 1) });
      });
    },
  };
}
