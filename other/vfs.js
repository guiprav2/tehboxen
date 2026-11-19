import localforage from 'https://cdn.jsdelivr.net/npm/localforage@1.10.0/+esm';

let STORE_NAME = 'tehboxen-vfs';
let META_KEY = '__tehboxen_vfs_meta__';
let STAT_KEY = '__tehboxen_vfs_stat__';
let USERS_KEY = '__tehboxen_users__';
let GROUPS_KEY = '__tehboxen_groups__';
let LOCKS_KEY = '__tehboxen_locks__';
let SHADOW_KEY = '__tehboxen_shadow__';

export let ROOT_UID = 0;
export let PLAYER_UID = 1000;
/** Grok — built-in world-building assistant; sudoer, not an NPC. */
export let GROK_UID = 999;
export let NOBODY_UID = 65534;
export let DEFAULT_FILE_MODE = 0o644;
export let DEFAULT_DIR_MODE = 0o755;
/** Shared world trees (readable by users + nobody). */
export let SHARED_ROOTS = ['places', 'items', 'websites', 'news', 'var'];
/** Content store for hardlinked files: `__tehboxen_inode__/<ino>`. */
export let INODE_PREFIX = '__tehboxen_inode__/';
/** Max wait while acquiring a lock. */
export let DEFAULT_LOCK_TIMEOUT_MS = 5000;
/** Lease lifetime without renew. */
export let DEFAULT_LOCK_TTL_MS = 30000;

let store = localforage.createInstance({
  name: STORE_NAME,
  storeName: 'files',
});

let listeners = new Set();
let ready = null;
let booting = false;
let statCache = null;
let usersCache = null;
let groupsCache = null;
/** Serialize lock acquire/release against the persisted lock table. */
let lockChain = Promise.resolve();
let lockWaiters = new Map(); // lockKey → Set of resolve fns

async function readyIfNeeded() {
  if (booting) return;
  await ensureReady();
}

function normalize(path) {
  let p = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
  let parts = [];
  for (let part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join('/');
}

function isReservedKey(key) {
  return (
    key === META_KEY ||
    key === STAT_KEY ||
    key === USERS_KEY ||
    key === GROUPS_KEY ||
    key === LOCKS_KEY ||
    key === SHADOW_KEY ||
    String(key || '').startsWith(INODE_PREFIX)
  );
}

/* ---------------- advisory / mandatory content locks ---------------- */

export class LockTimeoutError extends Error {
  constructor(path, mode) {
    super(
      `LockTimeout: could not acquire ${mode === 'w' ? 'exclusive' : 'shared'} lock on /${path} within ${DEFAULT_LOCK_TIMEOUT_MS}ms`,
    );
    this.name = 'LockTimeoutError';
    this.code = 'ELOCK_TIMEOUT';
    this.path = path;
    this.mode = mode;
  }
}

export class LockRequiredError extends Error {
  constructor(path, op) {
    super(
      `LockRequired: ${op} /${path} needs an explicit lease (use vfs.lock / withLock — no auto-lock)`,
    );
    this.name = 'LockRequiredError';
    this.code = 'ELOCK_REQUIRED';
    this.path = path;
    this.op = op;
  }
}

export class LockExpiredError extends Error {
  constructor(path, op) {
    super(
      `LockExpired: lease for /${path} is missing or expired during ${op}. ` +
        `Reacquire the lock and re-read the file before writing — do not write from a stale snapshot.`,
    );
    this.name = 'LockExpiredError';
    this.code = 'ELOCK_EXPIRED';
    this.path = path;
    this.op = op;
  }
}

function newLeaseId() {
  return (
    'l-' +
    Date.now().toString(36) +
    '-' +
    Math.random().toString(36).slice(2, 10)
  );
}

async function loadLocks() {
  return (await store.getItem(LOCKS_KEY)) || {};
}

async function saveLocks(table) {
  await store.setItem(LOCKS_KEY, table);
}

function sweepHolders(holders, now = Date.now()) {
  return (holders || []).filter((h) => Number(h.expiresAt) > now);
}

async function lockKeyForPath(path) {
  let key = normalize(path);
  if (!key) return '';
  let st = await getStat(key);
  if (st?.ino != null) return 'ino:' + Number(st.ino);
  return 'path:' + key;
}

function normalizeMode(mode) {
  let m = String(mode || 'w').toLowerCase();
  if (m === 'r' || m === 'shared' || m === 'read') return 'r';
  return 'w';
}

function canGrant(holders, mode) {
  let live = sweepHolders(holders);
  if (!live.length) return true;
  if (mode === 'r') return live.every((h) => h.mode === 'r');
  return false; // exclusive needs empty
}

function wakeLockKey(lockKey) {
  let set = lockWaiters.get(lockKey);
  if (!set || !set.size) return;
  for (let fn of [...set]) {
    try {
      fn();
    } catch {}
  }
  set.clear();
}

function waitLockWake(lockKey, timeoutMs) {
  return new Promise((resolve) => {
    let set = lockWaiters.get(lockKey);
    if (!set) {
      set = new Set();
      lockWaiters.set(lockKey, set);
    }
    let done = false;
    let finish = () => {
      if (done) return;
      done = true;
      set.delete(finish);
      clearTimeout(timer);
      resolve();
    };
    set.add(finish);
    let timer = setTimeout(finish, Math.min(100, Math.max(10, timeoutMs)));
  });
}

async function runLockOp(fn) {
  let prev = lockChain;
  let release;
  lockChain = new Promise((r) => {
    release = r;
  });
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * Acquire a shared (`r`) or exclusive (`w`) lease on a path (inode-aware).
 * Waits up to timeoutMs (default 5s). Lease expires after ttlMs without renew.
 */
export async function lock(path, opts = {}) {
  await ensureReady();
  let key = normalize(path);
  if (!key) throw new Error('lock: empty path');
  let mode = normalizeMode(opts.mode);
  let timeoutMs = Number(opts.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS);
  let ttlMs = Number(opts.ttlMs ?? DEFAULT_LOCK_TTL_MS);
  let actor = String(opts.actor || 'anonymous');
  let deadline = Date.now() + Math.max(0, timeoutMs);

  while (true) {
    let lease = await runLockOp(async () => {
      let lockKey = await lockKeyForPath(key);
      let table = await loadLocks();
      let entry = table[lockKey] || { holders: [] };
      entry.holders = sweepHolders(entry.holders);
      if (!canGrant(entry.holders, mode)) {
        table[lockKey] = entry;
        await saveLocks(table);
        return null;
      }
      let id = newLeaseId();
      let holder = {
        id,
        actor,
        mode,
        path: key,
        lockKey,
        expiresAt: Date.now() + ttlMs,
      };
      entry.holders.push(holder);
      table[lockKey] = entry;
      await saveLocks(table);
      return {
        id,
        path: key,
        lockKey,
        mode,
        actor,
        expiresAt: holder.expiresAt,
      };
    });
    if (lease) return lease;
    if (Date.now() >= deadline) throw new LockTimeoutError(key, mode);
    let lockKey = await lockKeyForPath(key);
    await waitLockWake(lockKey, deadline - Date.now());
  }
}

export async function renew(lease, opts = {}) {
  if (!lease?.id) throw new Error('renew: invalid lease');
  let ttlMs = Number(opts.ttlMs ?? DEFAULT_LOCK_TTL_MS);
  return runLockOp(async () => {
    let table = await loadLocks();
    let lockKey = lease.lockKey || (await lockKeyForPath(lease.path));
    let entry = table[lockKey];
    if (!entry) throw new LockExpiredError(lease.path, 'renew');
    entry.holders = sweepHolders(entry.holders);
    let h = entry.holders.find((x) => x.id === lease.id);
    if (!h) throw new LockExpiredError(lease.path, 'renew');
    h.expiresAt = Date.now() + ttlMs;
    table[lockKey] = entry;
    await saveLocks(table);
    lease.expiresAt = h.expiresAt;
    return lease;
  });
}

export async function unlock(leaseOrId, pathHint) {
  let id = typeof leaseOrId === 'object' ? leaseOrId?.id : leaseOrId;
  if (!id) return false;
  return runLockOp(async () => {
    let table = await loadLocks();
    let hintPath =
      (typeof leaseOrId === 'object' && leaseOrId.path) || pathHint || '';
    let keys = Object.keys(table);
    if (typeof leaseOrId === 'object' && leaseOrId.lockKey) {
      keys = [leaseOrId.lockKey, ...keys.filter((k) => k !== leaseOrId.lockKey)];
    } else if (hintPath) {
      let lk = await lockKeyForPath(hintPath);
      keys = [lk, ...keys.filter((k) => k !== lk)];
    }
    let found = false;
    for (let lockKey of keys) {
      let entry = table[lockKey];
      if (!entry) continue;
      let before = entry.holders?.length || 0;
      entry.holders = sweepHolders(entry.holders).filter((h) => h.id !== id);
      if (entry.holders.length !== before) found = true;
      if (!entry.holders.length) delete table[lockKey];
      else table[lockKey] = entry;
      if (found) {
        await saveLocks(table);
        wakeLockKey(lockKey);
        return true;
      }
    }
    await saveLocks(table);
    return false;
  });
}

export async function unlockAll(actor) {
  let who = String(actor || '');
  if (!who) return 0;
  return runLockOp(async () => {
    let table = await loadLocks();
    let n = 0;
    let woken = new Set();
    for (let lockKey of Object.keys(table)) {
      let entry = table[lockKey];
      let live = sweepHolders(entry.holders);
      let keep = live.filter((h) => h.actor !== who);
      n += live.length - keep.length;
      if (!keep.length) {
        delete table[lockKey];
        woken.add(lockKey);
      } else {
        table[lockKey] = { holders: keep };
        if (keep.length !== live.length) woken.add(lockKey);
      }
    }
    await saveLocks(table);
    for (let k of woken) wakeLockKey(k);
    return n;
  });
}

export async function listLocks() {
  await ensureReady();
  let table = await loadLocks();
  let out = [];
  let now = Date.now();
  for (let [lockKey, entry] of Object.entries(table)) {
    for (let h of sweepHolders(entry.holders, now)) {
      out.push({ ...h, lockKey, ttlLeftMs: h.expiresAt - now });
    }
  }
  return out;
}

/**
 * Assert lease is still valid and strong enough for op.
 * @param {'r'|'w'} need
 */
export async function assertLease(path, lease, need, op = 'io') {
  if (booting) return;
  let key = normalize(path);
  if (!lease?.id) throw new LockRequiredError(key, op);
  let want = normalizeMode(need);
  return runLockOp(async () => {
    let lockKey = lease.lockKey || (await lockKeyForPath(key));
    // If path now has an inode, prefer that key (create then lock edge).
    let curKey = await lockKeyForPath(key);
    let table = await loadLocks();
    let entry = table[lockKey] || table[curKey];
    if (!entry) throw new LockExpiredError(key, op);
    entry.holders = sweepHolders(entry.holders);
    let h = entry.holders.find((x) => x.id === lease.id);
    if (!h) throw new LockExpiredError(key, op);
    if (want === 'w' && h.mode !== 'w') {
      throw new LockRequiredError(key, op + ' (exclusive lease required)');
    }
    // Re-key holder if file gained an inode since lock(path).
    if (curKey !== lockKey && table[lockKey]) {
      entry.holders = entry.holders.filter((x) => x.id !== lease.id);
      if (!entry.holders.length) delete table[lockKey];
      else table[lockKey] = entry;
      let dest = table[curKey] || { holders: [] };
      dest.holders = sweepHolders(dest.holders);
      h.lockKey = curKey;
      h.path = key;
      dest.holders.push(h);
      table[curKey] = dest;
      await saveLocks(table);
      lease.lockKey = curKey;
    }
    return h;
  });
}

export async function withLock(path, fn, opts = {}) {
  let mode = normalizeMode(opts.mode ?? 'w');
  let lease = await lock(path, { ...opts, mode });
  try {
    return await fn(lease);
  } finally {
    try {
      await unlock(lease);
    } catch {}
  }
}

/** Acquire exclusive (default) leases on many paths in sorted order. */
export async function withLocks(paths, fn, opts = {}) {
  let mode = normalizeMode(opts.mode ?? 'w');
  let uniq = [
    ...new Set((paths || []).map((p) => normalize(p)).filter(Boolean)),
  ].sort();
  let leases = [];
  try {
    for (let p of uniq) {
      leases.push(await lock(p, { ...opts, mode }));
    }
    let byPath = Object.fromEntries(leases.map((l) => [l.path, l]));
    return await fn(byPath, leases);
  } finally {
    for (let i = leases.length - 1; i >= 0; i--) {
      try {
        await unlock(leases[i]);
      } catch {}
    }
  }
}

function isLinkMarker(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !(value instanceof Blob) &&
    value.__tehboxen_hl__ != null
  );
}

function isSymlinkMarker(value) {
  return (
    value != null &&
    typeof value === 'object' &&
    !(value instanceof Blob) &&
    value.__tehboxen_symlink__ != null
  );
}

/** Resolve a symlink target string relative to the link's directory. */
export function resolveLinkTarget(linkPath, target) {
  let t = String(target || '').replace(/^\/+/, '');
  if (!t) return '';
  if (!t.startsWith('.')) return normalize(t);
  let base = normalize(linkPath);
  let dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/')) : '';
  return normalize(dir ? dir + '/' + t : t);
}

function inodeKey(ino) {
  return INODE_PREFIX + String(ino);
}

async function allocIno() {
  let meta = (await store.getItem(META_KEY)) || {};
  let n = Number(meta.nextIno) || 1;
  meta = { ...meta, nextIno: n + 1 };
  await store.setItem(META_KEY, meta);
  return n;
}

async function contentKeyFor(path) {
  let key = normalize(path);
  if (!key) return key;
  let st = await getStat(key);
  if (st?.ino != null) return inodeKey(st.ino);
  return key;
}

async function pathsForIno(ino) {
  let stats = await loadStats();
  let id = Number(ino);
  return Object.keys(stats).filter((k) => Number(stats[k]?.ino) === id);
}

async function bumpInoNlink(ino) {
  let paths = await pathsForIno(ino);
  let nlink = paths.length;
  let stats = await loadStats();
  let now = Date.now();
  for (let p of paths) {
    if (!stats[p]) continue;
    stats[p] = { ...stats[p], nlink, mtime: now };
  }
  statCache = stats;
  await saveStats();
  return nlink;
}

/**
 * Promote a regular path to inode-backed storage (idempotent).
 * @returns {Promise<number>} inode number
 */
async function ensureInode(path) {
  let key = normalize(path);
  if (!key) throw new Error('Cannot inode empty path');
  let st = await getStat(key);
  if (st?.ino != null) return Number(st.ino);
  let value = await store.getItem(key);
  if (value == null) throw new Error('No such file: ' + key);
  if (isLinkMarker(value)) {
    let ino = Number(value.__tehboxen_hl__);
    await setStat(key, { ...(st || {}), kind: 'file', ino, nlink: st?.nlink || 1 });
    return ino;
  }
  let ino = await allocIno();
  await store.setItem(inodeKey(ino), value);
  await store.setItem(key, { __tehboxen_hl__: ino });
  await setStat(key, {
    ...(st || {}),
    kind: 'file',
    mode: st?.mode ?? DEFAULT_FILE_MODE,
    uid: st?.uid ?? ROOT_UID,
    gid: st?.gid ?? ROOT_UID,
    ino,
    nlink: 1,
    mtime: Date.now(),
  });
  return ino;
}

function notify(type, path, kind) {
  for (let fn of listeners) {
    try {
      fn(kind ? { type, path, kind } : { type, path });
    } catch {}
  }
}

async function ensureReady() {
  if (!ready) ready = boot();
  return ready;
}

async function putRaw(path, text, meta) {
  let key = normalize(path);
  if (!key) return;
  await store.setItem(key, String(text ?? ''));
  if (meta) await setStat(key, meta);
  else await ensureStat(key, guessKind(key));
  notify('write', key);
}

function guessKind(path) {
  return path.endsWith('/.keep') || path === '.keep' ? 'dir' : 'file';
}

function dirPathFromKeep(path) {
  if (path === '.keep') return '';
  if (path.endsWith('/.keep')) return path.slice(0, -'/.keep'.length);
  return null;
}

async function boot() {
  booting = true;
  try {
    let meta = await store.getItem(META_KEY);
    let hasHome = (await store.getItem('home/.keep')) != null;
    // Re-seed when meta was written but boot deadlocked before files landed.
    if (!meta || !hasHome) {
      await store.setItem(META_KEY, { seeded: true, version: 2 });
      await putRaw('home/.keep', '', {
        kind: 'dir',
        mode: DEFAULT_DIR_MODE,
        uid: ROOT_UID,
        gid: ROOT_UID,
      });
    }

    await ensureAuthSeed();
    // Backfill stats for legacy plain-string entries.
    await backfillStats();
  } finally {
    booting = false;
  }
}

async function ensureAuthSeed() {
  let users = (await store.getItem(USERS_KEY)) || {};
  let groups = (await store.getItem(GROUPS_KEY)) || {};
  let usersChanged = false;
  let groupsChanged = false;
  let meta = (await store.getItem(META_KEY)) || {};
  let authVersion = Number(meta.authVersion || 0);

  // root (uid 0). Human accounts are created from the login screen (other/accounts.js).
  if (!users.root) {
    users.root = {
      name: 'root',
      uid: ROOT_UID,
      gid: ROOT_UID,
      home: 'root',
      shell: '/bin/boxsh',
      gecos: 'Root',
    };
    usersChanged = true;
  }

  // grok — built-in world builder (uid 999), sudoer.
  if (!users.grok) {
    users.grok = {
      name: 'grok',
      uid: GROK_UID,
      gid: GROK_UID,
      home: 'home/grok',
      shell: '/bin/boxsh',
      gecos: 'Grok',
    };
    usersChanged = true;
  }

  if (!users.nobody) {
    users.nobody = {
      name: 'nobody',
      uid: NOBODY_UID,
      gid: NOBODY_UID,
      home: '',
      shell: '/bin/boxsh',
      gecos: 'Nobody',
    };
    usersChanged = true;
  }

  if (!groups.root) {
    groups.root = { name: 'root', gid: ROOT_UID, members: ['root'] };
    groupsChanged = true;
  } else if (!groups.root.members?.includes('root')) {
    groups.root.members = [...new Set([...(groups.root.members || []), 'root'])];
    groupsChanged = true;
  }

  if (!groups.grok) {
    groups.grok = { name: 'grok', gid: GROK_UID, members: ['grok'] };
    groupsChanged = true;
  } else if (!groups.grok.members?.includes('grok')) {
    groups.grok.members = [...new Set([...(groups.grok.members || []), 'grok'])];
    groupsChanged = true;
  }

  if (!groups.sudo) {
    groups.sudo = { name: 'sudo', gid: 27, members: ['grok'] };
    groupsChanged = true;
  } else {
    let sudoMem = new Set(groups.sudo.members || []);
    let sudoBefore = sudoMem.size;
    sudoMem.add('grok');
    if (sudoMem.size !== sudoBefore) {
      groups.sudo.members = [...sudoMem];
      groupsChanged = true;
    }
  }

  if (!groups.world) {
    groups.world = {
      name: 'world',
      gid: 100,
      members: ['grok', 'nobody', 'root'],
    };
    groupsChanged = true;
  } else {
    let need = ['grok', 'nobody', 'root'];
    let mem = new Set(groups.world.members || []);
    let before = mem.size;
    for (let n of need) mem.add(n);
    if (mem.size !== before) {
      groups.world.members = [...mem];
      groupsChanged = true;
    }
  }

  if (!groups.nobody) {
    groups.nobody = { name: 'nobody', gid: NOBODY_UID, members: ['nobody'] };
    groupsChanged = true;
  }

  if (usersChanged) await store.setItem(USERS_KEY, users);
  if (groupsChanged) await store.setItem(GROUPS_KEY, groups);
  usersCache = users;
  groupsCache = groups;

  if (authVersion < 3) {
    await migrateAuthV3(null);
    meta = { ...meta, authVersion: 3, seeded: true, version: Math.max(2, Number(meta.version) || 2) };
    await store.setItem(META_KEY, meta);
  }

  await ensureGrokHome(users.grok);
  await ensureSharedWorldDirs(users.root);
  // dbg / ensureDir / writeYaml often write as root; keep homes owned by their user.
  await repairHomeOwnerships();
}

/** Re-own every path under prefix (inclusive) to uid/gid. */
export async function chownTree(prefix, uid, gid) {
  let stats = await loadStats();
  let changed = false;
  let pfx = normalize(prefix);
  for (let key of Object.keys(stats)) {
    if (key === pfx || key.startsWith(pfx + '/')) {
      stats[key] = {
        ...stats[key],
        uid: Number(uid),
        gid: Number(gid),
      };
      changed = true;
    }
  }
  // Also ensure the home dir keep exists with ownership.
  let keep = pfx ? pfx + '/.keep' : '.keep';
  if ((await store.getItem(keep)) != null || (await store.getItem(pfx)) != null) {
    await ensureStat(pfx, 'dir');
    stats = await loadStats();
    if (stats[pfx]) {
      stats[pfx] = { ...stats[pfx], uid: Number(uid), gid: Number(gid), kind: 'dir' };
      changed = true;
    }
  }
  if (changed) {
    statCache = stats;
    await saveStats();
  }
}

/**
 * Force each real user's home tree to that user's uid/gid.
 * Idempotent; safe to run every boot (stats-only walk).
 */
export async function repairHomeOwnerships() {
  let users = await listUsers();
  for (let u of Object.values(users || {})) {
    if (!u?.name || u.name === 'nobody' || u.name === 'root') continue;
    let home = String(u.home || 'home/' + u.name).replace(/^\/+/, '');
    if (!home || home === 'root' || !home.startsWith('home/')) continue;
    await chownTree(home, u.uid, u.gid);
    let st = await getStat(home);
    if (st) {
      await setStat(home, {
        ...st,
        kind: 'dir',
        mode: st.mode != null ? st.mode : 0o750,
        uid: Number(u.uid),
        gid: Number(u.gid),
      });
    }
  }
}

/** Parent directory path, or '' for top-level. */
function parentPathOf(path) {
  let key = normalize(path);
  if (!key || !key.includes('/')) return '';
  return key.slice(0, key.lastIndexOf('/'));
}

/**
 * Walk ancestors for uid/gid. Used when creating a path without an explicit owner
 * so files under home/<user>/ inherit that user instead of defaulting to root.
 */
async function ownerFromAncestors(path) {
  let cur = parentPathOf(path);
  while (true) {
    if (cur) {
      let st = await getStat(cur);
      if (st && (st.uid != null || st.gid != null)) {
        return {
          uid: Number(st.uid ?? ROOT_UID),
          gid: Number(st.gid ?? ROOT_UID),
        };
      }
    }
    if (!cur) break;
    if (!cur.includes('/')) break;
    cur = cur.slice(0, cur.lastIndexOf('/'));
  }
  return { uid: ROOT_UID, gid: ROOT_UID };
}

/**
 * Resolve uid/gid for a create/update: explicit meta → existing → parent tree → root.
 * For `.keep` markers, inherit from the directory's parent (the dir being created).
 */
async function resolveOwner(path, meta, existing) {
  if (meta?.uid != null || existing?.uid != null) {
    return {
      uid: Number(meta?.uid ?? existing?.uid ?? ROOT_UID),
      gid: Number(meta?.gid ?? existing?.gid ?? ROOT_UID),
    };
  }
  let key = normalize(path);
  let keepDir = dirPathFromKeep(key);
  let probe = keepDir != null ? keepDir : key;
  return ownerFromAncestors(probe);
}

async function migrateAuthV3() {
  // Legacy BambiOS single-player migration; tehboxen stores start at v3.
}

/** Ensure home/grok skeleton exists (idempotent). */
async function ensureGrokHome(grokUser) {
  if (!grokUser) return;
  let uid = Number(grokUser.uid);
  let gid = Number(grokUser.gid);
  let home = grokUser.home || 'home/grok';
  if ((await store.getItem(home + '/.keep')) == null) {
    await putRaw(home + '/.keep', '', { kind: 'dir', mode: 0o750, uid, gid });
  } else {
    let st = await getStat(home);
    if (st) await setStat(home, { ...st, kind: 'dir', mode: 0o750, uid, gid });
  }
  if ((await store.getItem(home + '/.relay/.keep')) == null) {
    await putRaw(home + '/.relay/.keep', '', {
      kind: 'dir',
      mode: DEFAULT_DIR_MODE,
      uid,
      gid,
    });
  }
  if ((await store.getItem(home + '/profile.yaml')) == null) {
    await putRaw(
      home + '/profile.yaml',
      'id: grok\nname: Grok\nabout: world builder\n',
      { kind: 'file', mode: DEFAULT_FILE_MODE, uid, gid },
    );
  }
}

async function ensureSharedWorldDirs(rootUser) {
  let uid = Number(rootUser?.uid ?? ROOT_UID);
  let world = (await listGroups()).world;
  let gid = Number(world?.gid ?? 100);
  for (let name of SHARED_ROOTS) {
    let keep = name + '/.keep';
    if ((await store.getItem(keep)) == null) {
      await putRaw(keep, '', {
        kind: 'dir',
        mode: 0o755,
        uid,
        gid,
      });
    } else {
      await ensureStat(name, 'dir');
      let st = await getStat(name);
      if (st && (st.gid !== gid || (st.mode & 0o777) !== 0o755)) {
        await setStat(name, { ...st, kind: 'dir', mode: 0o755, uid, gid });
      }
    }
  }
  // /tmp: world-writable with the sticky bit, like any Unix box.
  if ((await store.getItem('tmp/.keep')) == null) {
    await putRaw('tmp/.keep', '', { kind: 'dir', mode: 0o1777, uid: ROOT_UID, gid: ROOT_UID });
  } else {
    let st = await getStat('tmp');
    if (!st || (st.mode & 0o7777) !== 0o1777) await setStat('tmp', { ...(st || {}), kind: 'dir', mode: 0o1777, uid: ROOT_UID, gid: ROOT_UID });
  }
  // Vanilla starter: only the shared safehouse — empty place.yaml, no cover art.
  // World packs / live design fill the rest; boot never invents cafes or cast.
  let apt = 'places/safehouse';
  if ((await store.getItem(apt + '/.keep')) == null) {
    await putRaw(apt + '/.keep', '', { kind: 'dir', mode: 0o755, uid, gid });
  }
  let placeMeta = apt + '/place.yaml';
  if ((await store.getItem(placeMeta)) == null) {
    await putRaw(
      placeMeta,
      'name: Safehouse\nabout: Shared crash space for new operators. Bring your own rig.\npicture: ""\n',
      { kind: 'file', mode: 0o644, uid, gid },
    );
  }
  let presence = apt + '/presence.yaml';
  if ((await store.getItem(presence)) == null) {
    await putRaw(
      presence,
      '# who is here\nusers: []\n',
      { kind: 'file', mode: 0o644, uid, gid },
    );
  }
}

async function loadStats() {
  if (!statCache) {
    statCache = (await store.getItem(STAT_KEY)) || {};
  }
  return statCache;
}

// The stats table is one store entry; concurrent saves coalesce into a single
// write loop so N writes don't serialize the whole table N times.
let statDirty = false;
let statWriter = null;
function saveStats() {
  statDirty = true;
  statWriter ??= (async () => {
    try {
      while (statDirty) {
        statDirty = false;
        await store.setItem(STAT_KEY, statCache || {});
      }
    } finally {
      statWriter = null;
    }
  })();
  return statWriter;
}

async function backfillStats() {
  let stats = await loadStats();
  let changed = false;
  let now = Date.now();
  await store.iterate((value, key) => {
    if (isReservedKey(key)) return;
    let dir = dirPathFromKeep(key);
    if (dir != null) {
      if (!stats[dir]) {
        stats[dir] = {
          kind: 'dir',
          mode: DEFAULT_DIR_MODE,
          uid: ROOT_UID,
          gid: ROOT_UID,
          mtime: now,
        };
        changed = true;
      }
      return;
    }
    if (!stats[key]) {
      stats[key] = {
        kind: 'file',
        mode: DEFAULT_FILE_MODE,
        uid: ROOT_UID,
        gid: ROOT_UID,
        mtime: now,
      };
      changed = true;
    }
  });
  if (changed) {
    statCache = stats;
    await saveStats();
  }
}

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function list() {
  await ensureReady();
  let paths = [];
  await store.iterate((value, key) => {
    if (isReservedKey(key)) return;
    paths.push(key);
  });
  return paths.sort();
}

export async function read(path, opts = {}) {
  await ensureReady();
  let key = normalize(path);
  if (!key) return null;
  await assertLease(key, opts.lease, 'r', 'read');
  let raw0 = await store.getItem(key);
  if (isSymlinkMarker(raw0)) return null; // use readlink()
  let st0 = await getStat(key);
  if (st0?.kind === 'symlink') return null;
  let ck = await contentKeyFor(key);
  let value = await store.getItem(ck);
  if (value == null) {
    // Path may be a dangling marker or legacy empty
    let raw = raw0 != null ? raw0 : await store.getItem(key);
    if (isLinkMarker(raw)) {
      value = await store.getItem(inodeKey(raw.__tehboxen_hl__));
    } else {
      value = raw;
    }
  }
  if (value == null) return null;
  if (isLinkMarker(value) || isSymlinkMarker(value)) return null;
  if (typeof value === 'string') return value;
  if (value instanceof Blob) return await value.text();
  if (value?.text != null) return String(value.text);
  return null;
}

export async function readBlob(path, opts = {}) {
  await ensureReady();
  let key = normalize(path);
  await assertLease(key, opts.lease, 'r', 'readBlob');
  let ck = await contentKeyFor(key);
  let value = await store.getItem(ck);
  if (value == null) {
    let raw = await store.getItem(key);
    if (isLinkMarker(raw)) value = await store.getItem(inodeKey(raw.__tehboxen_hl__));
    else value = raw;
  }
  if (value == null || isLinkMarker(value)) return null;
  if (value instanceof Blob) return value;
  if (typeof value === 'string') {
    return new Blob([value], { type: 'text/plain' });
  }
  if (value?.blob instanceof Blob) return value.blob;
  if (value?.text != null) {
    return new Blob([String(value.text)], {
      type: value.type || 'text/plain',
    });
  }
  return null;
}

/**
 * Resolve the inode for a path: prefer stat.ino, else a store hardlink marker.
 * Keeps write/append from replacing `{__tehboxen_hl__}` with independent content
 * when stats lost their ino field.
 */
async function resolveIno(key, existing) {
  if (existing?.ino != null && !Number.isNaN(Number(existing.ino))) {
    return Number(existing.ino);
  }
  let raw = await store.getItem(key);
  if (isLinkMarker(raw)) {
    let n = Number(raw.__tehboxen_hl__);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Public: inode for a path from stats or `{__tehboxen_hl__}` store marker. */
export async function getIno(path) {
  await ensureReady();
  let key = normalize(path);
  if (!key) return null;
  return resolveIno(key, await getStat(key));
}

export async function write(path, text, meta = {}) {
  await ensureReady();
  let key = normalize(path);
  if (!key) throw new Error('Cannot write empty path');
  await assertLease(key, meta.lease, 'w', 'write');
  let existing = await getStat(key);
  let keepDir = dirPathFromKeep(key);
  let asDir = keepDir != null;
  let payload = String(text ?? '');
  let ino = asDir ? null : await resolveIno(key, existing);
  if (!asDir && ino != null) {
    await store.setItem(inodeKey(ino), payload);
    await store.setItem(key, { __tehboxen_hl__: ino });
    let now = Date.now();
    let owner = await resolveOwner(key, meta, existing);
    for (let p of await pathsForIno(ino)) {
      let st = await getStat(p);
      await setStat(p, {
        ...(st || {}),
        mode: meta?.mode ?? st?.mode ?? DEFAULT_FILE_MODE,
        uid: meta?.uid ?? st?.uid ?? owner.uid,
        gid: meta?.gid ?? st?.gid ?? owner.gid,
        mtime: now,
        kind: 'file',
        ino,
      });
      notify('write', p);
    }
    return;
  }
  let owner = await resolveOwner(key, meta, existing);
  await store.setItem(key, payload);
  await setStat(key, {
    mode:
      meta?.mode ??
      existing?.mode ??
      (asDir ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE),
    mtime: Date.now(),
    ...(meta || {}),
    // .keep marker shares the directory's stat entry — never kind:file
    kind: asDir ? 'dir' : 'file',
    // Owner after meta spread so omitted uid/gid still inherit from parent.
    uid: meta?.uid ?? owner.uid,
    gid: meta?.gid ?? owner.gid,
  });
  notify('write', key);
}

/**
 * Append bytes to a file (create if missing). Serialized per inode/path so
 * concurrent same-tab appends cannot clobber each other. Prefer this over
 * read→modify→write for logs and messages.yaml.
 *
 * Not a kernel O_APPEND: cross-context races are still possible if two
 * isolated JS realms append without coordinating — keep a single writer
 * policy (append-only, never rewrite) on top.
 */
let appendChains = new Map();

export async function append(path, text, meta = {}) {
  await ensureReady();
  let key = normalize(path);
  if (!key) throw new Error('Cannot append to empty path');
  await assertLease(key, meta.lease, 'w', 'append');
  let existing = await getStat(key);
  let resolvedIno = await resolveIno(key, existing);
  let lockKey = resolvedIno != null ? 'ino:' + resolvedIno : 'path:' + key;
  let prev = appendChains.get(lockKey) || Promise.resolve();
  let run = async () => {
    // Re-check lease inside the chain — may have expired while queued.
    await assertLease(key, meta.lease, 'w', 'append');
    let st = await getStat(key);
    let ino = await resolveIno(key, st);
    let cur = '';
    if (ino != null) {
      let v = await store.getItem(inodeKey(ino));
      if (typeof v === 'string') cur = v;
      else if (v && typeof v === 'object' && typeof v.text === 'string') cur = v.text;
      else if (v != null) cur = String(v);
    } else {
      let v = await store.getItem(key);
      if (typeof v === 'string') cur = v;
      else if (v != null && typeof v !== 'object') cur = String(v);
    }
    let chunk = String(text ?? '');
    if (!chunk) return;
    // Ensure YAML list items / log lines separate cleanly.
    if (cur && !cur.endsWith('\n')) cur += '\n';
    await write(key, cur + chunk, meta);
  };
  let done = prev.then(run, run);
  appendChains.set(
    lockKey,
    done.then(
      () => {},
      () => {},
    ),
  );
  return done;
}

/** writeBlob(path, blob, meta?) or writeBlob(path, blob, mimeType, meta?) */
export async function writeBlob(path, blob, typeOrMeta, maybeMeta) {
  await ensureReady();
  let key = normalize(path);
  if (!key) throw new Error('Cannot write empty path');
  let type;
  let meta;
  if (typeOrMeta && typeof typeOrMeta === 'object' && !(typeOrMeta instanceof Blob)) {
    meta = typeOrMeta;
    type = undefined;
  } else {
    type = typeOrMeta;
    meta = maybeMeta && typeof maybeMeta === 'object' ? maybeMeta : {};
  }
  meta = meta || {};
  await assertLease(key, meta.lease, 'w', 'writeBlob');
  let value =
    blob instanceof Blob
      ? blob
      : new Blob([blob], { type: type || 'application/octet-stream' });
  let existing = await getStat(key);
  let keepDir = dirPathFromKeep(key);
  let asDir = keepDir != null;
  let ino = asDir ? null : await resolveIno(key, existing);
  if (!asDir && ino != null) {
    await store.setItem(inodeKey(ino), value);
    await store.setItem(key, { __tehboxen_hl__: ino });
    let now = Date.now();
    let owner = await resolveOwner(key, meta, existing);
    for (let p of await pathsForIno(ino)) {
      let st = await getStat(p);
      await setStat(p, {
        ...(st || {}),
        mode: meta?.mode ?? st?.mode ?? DEFAULT_FILE_MODE,
        uid: meta?.uid ?? st?.uid ?? owner.uid,
        gid: meta?.gid ?? st?.gid ?? owner.gid,
        mtime: now,
        kind: 'file',
        ino,
      });
      notify('write', p);
    }
    return;
  }
  let owner = await resolveOwner(key, meta, existing);
  await store.setItem(key, value);
  await setStat(key, {
    mode:
      meta?.mode ??
      existing?.mode ??
      (asDir ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE),
    mtime: Date.now(),
    ...(meta || {}),
    kind: asDir ? 'dir' : 'file',
    uid: meta?.uid ?? owner.uid,
    gid: meta?.gid ?? owner.gid,
  });
  notify('write', key);
}

export async function remove(path, opts = {}) {
  await ensureReady();
  let raw = String(path || '');
  let forceDir =
    raw.endsWith('/') || raw.endsWith('/.keep') || raw === '.keep';
  let key = normalize(path);
  if (!key) return;
  await assertLease(key, opts.lease ?? opts.meta?.lease, 'w', 'remove');
  let stats = await loadStats();
  // normalize() strips trailing slashes, so detect dirs before / via isDirPath
  if (forceDir || (await isDirPath(key))) {
    let prefix = key + '/';
    let paths = await list();
    for (let p of paths) {
      if (p === key || p.startsWith(prefix)) {
        await removeOneFile(p, stats);
      }
    }
    delete stats[key];
    await saveStats();
    notify('remove', key);
    return;
  }
  await removeOneFile(key, stats);
  await saveStats();
}

async function removeOneFile(key, stats) {
  let st = stats[key] || (await getStat(key));
  let ino = st?.ino;
  await store.removeItem(key);
  delete stats[key];
  let d = dirPathFromKeep(key);
  if (d != null) delete stats[d];
  notify('remove', key);
  if (ino != null) {
    let left = Object.keys(stats).filter((k) => Number(stats[k]?.ino) === Number(ino));
    if (!left.length) {
      await store.removeItem(inodeKey(ino));
    } else {
      let nlink = left.length;
      let now = Date.now();
      for (let p of left) {
        stats[p] = { ...stats[p], nlink, mtime: now };
      }
    }
  }
}

/**
 * Move a file or directory tree. Requires exclusive leases on both paths:
 * `{ lease }` (dest) and `{ srcLease }` (source). Uses store ops directly
 * after assert — does not re-enter gated read/write.
 */
export async function move(from, to, opts = {}) {
  await ensureReady();
  let src = normalize(from);
  let dest = normalize(to);
  if (!src || !dest) throw new Error('Invalid move paths');
  await assertLease(src, opts.srcLease ?? opts.fromLease, 'w', 'move');
  await assertLease(dest, opts.lease ?? opts.destLease, 'w', 'move');
  let stats = await loadStats();

  if (src.endsWith('/') || (await isDirPath(src))) {
    let prefix = src.endsWith('/') ? src : src + '/';
    let destPrefix = dest.endsWith('/') ? dest : dest + '/';
    let paths = await list();
    let matched = paths.filter(
      p => p === src || p.startsWith(prefix) || p === src.replace(/\/$/, ''),
    );
    for (let p of matched) {
      let next =
        p === src || p === src.replace(/\/$/, '')
          ? dest.replace(/\/$/, '')
          : destPrefix + p.slice(prefix.length);
      let value = await store.getItem(p);
      await store.setItem(next, value);
      await store.removeItem(p);
      if (stats[p]) {
        stats[next] = { ...stats[p], mtime: Date.now() };
        delete stats[p];
      }
      let sd = dirPathFromKeep(p);
      let nd = dirPathFromKeep(next);
      if (sd != null && stats[sd]) {
        let destDir = nd != null ? nd : next.replace(/\/$/, '');
        stats[destDir] = { ...stats[sd], kind: 'dir', mtime: Date.now() };
        delete stats[sd];
      }
      notify('move', next);
    }
    if (stats[src]) {
      stats[dest.replace(/\/$/, '')] = {
        ...stats[src],
        kind: 'dir',
        mtime: Date.now(),
      };
      delete stats[src];
    }
    await saveStats();
    return;
  }

  let value = await store.getItem(src);
  if (value == null) throw new Error('No such file: ' + src);
  await store.setItem(dest, value);
  await store.removeItem(src);
  if (stats[src]) {
    stats[dest] = { ...stats[src], mtime: Date.now() };
    delete stats[src];
  }
  await saveStats();
  notify('move', dest);
}

async function isDirPath(path) {
  let key = normalize(path);
  let paths = await list();
  let prefix = key + '/';
  return paths.some(p => p.startsWith(prefix) || p === key + '/.keep');
}

export async function exists(path) {
  await ensureReady();
  let key = normalize(path);
  if (!key) return false;
  if ((await store.getItem(key)) != null) return true;
  return isDirPath(key);
}

export async function isDirectory(path) {
  await ensureReady();
  return isDirPath(path);
}

export async function clear() {
  await store.clear();
  ready = null;
  statCache = null;
  usersCache = null;
  groupsCache = null;
  notify('clear', '');
  await ensureReady();
}

export async function seed(files = {}) {
  await ensureReady();
  for (let [path, content] of Object.entries(files)) {
    await withLock(
      path,
      async (lease) => {
        if (content instanceof Blob) await writeBlob(path, content, { lease });
        else await write(path, content, { lease });
      },
      { mode: 'w' },
    );
  }
}

/* ---------- stats ---------- */

export async function getStat(path) {
  await readyIfNeeded();
  let key = normalize(path);
  let dir = dirPathFromKeep(key);
  let stats = await loadStats();
  let hit = dir != null ? stats[dir] : stats[key];
  if (hit) return hit;
  // Refresh from IDB once — multiple ESM copies (cache-bust imports) can
  // diverge in-memory while sharing the same localforage store.
  statCache = null;
  stats = await loadStats();
  return dir != null ? stats[dir] || null : stats[key] || null;
}

export async function setStat(path, patch = {}) {
  await readyIfNeeded();
  let key = normalize(path);
  let dir = dirPathFromKeep(key);
  let statKey = dir != null ? dir : key;
  if (!statKey && dir === '') statKey = ''; // root — unused
  let stats = await loadStats();
  let prev = stats[statKey] || {};
  // .keep always maps to the directory entry
  let kind =
    dir != null
      ? 'dir'
      : patch.kind ||
        prev.kind ||
        (guessKind(key) === 'dir' ? 'dir' : 'file');
  let next = {
    kind,
    mode:
      patch.mode != null
        ? Number(patch.mode) & 0o7777
        : prev.mode != null
          ? prev.mode
          : kind === 'dir'
            ? DEFAULT_DIR_MODE
            : DEFAULT_FILE_MODE,
    uid: patch.uid != null ? Number(patch.uid) : (prev.uid ?? ROOT_UID),
    gid: patch.gid != null ? Number(patch.gid) : (prev.gid ?? ROOT_UID),
    mtime: patch.mtime != null ? Number(patch.mtime) : Date.now(),
  };
  // Hardlink metadata (optional)
  let ino = patch.ino != null ? Number(patch.ino) : prev.ino;
  if (ino != null && !Number.isNaN(ino)) next.ino = ino;
  let nlink = patch.nlink != null ? Number(patch.nlink) : prev.nlink;
  if (nlink != null && !Number.isNaN(nlink)) next.nlink = nlink;
  // Explicit clear when patch sets ino: null
  if (Object.prototype.hasOwnProperty.call(patch, 'ino') && patch.ino == null) {
    delete next.ino;
    delete next.nlink;
  }
  // Symlink target (optional)
  let target =
    patch.target != null
      ? String(patch.target)
      : prev.target != null
        ? String(prev.target)
        : null;
  if (target != null && kind === 'symlink') next.target = target;
  // The symlink text exactly as the creator wrote it (target may be normalized for resolution).
  let linkText = patch.linkText != null ? String(patch.linkText) : prev.linkText;
  if (linkText != null && kind === 'symlink') next.linkText = linkText;
  if (Object.prototype.hasOwnProperty.call(patch, 'target') && patch.target == null) {
    delete next.target;
  }
  stats[statKey] = next;
  statCache = stats;
  await saveStats();
  return stats[statKey];
}

export async function ensureStat(path, kind, owner) {
  let st = await getStat(path);
  if (st) return st;
  let k = kind || (dirPathFromKeep(normalize(path)) != null ? 'dir' : 'file');
  return setStat(path, {
    kind: k,
    mode: k === 'dir' ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE,
    uid: owner?.uid ?? ROOT_UID,
    gid: owner?.gid ?? ROOT_UID,
  });
}

export async function sizeOf(path) {
  let key = normalize(path);
  let ck = await contentKeyFor(key);
  let value = await store.getItem(ck);
  if (value == null) {
    let raw = await store.getItem(key);
    if (isLinkMarker(raw)) value = await store.getItem(inodeKey(raw.__tehboxen_hl__));
    else value = raw;
  }
  if (value == null || isLinkMarker(value)) return 0;
  if (typeof value === 'string') return value.length;
  if (value instanceof Blob) return value.size;
  if (value?.text != null) return String(value.text).length;
  return 0;
}

/* ---------- users / groups ---------- */

export async function listUsers() {
  await readyIfNeeded();
  if (!usersCache) usersCache = (await store.getItem(USERS_KEY)) || {};
  return { ...usersCache };
}

export async function getUser(name) {
  let users = await listUsers();
  return users[String(name || '')] || null;
}

export async function saveUser(user) {
  await readyIfNeeded();
  let users = await listUsers();
  let name = String(user.name || '');
  if (!name) throw new Error('user name required');
  users[name] = {
    name,
    uid: Number(user.uid),
    gid: Number(user.gid),
    home: String(user.home || 'home/' + name).replace(/^\/+/, ''),
    shell: String(user.shell || '/bin/boxsh'),
    gecos: String(user.gecos || name),
    ...(user.human ? { human: true } : {}),
  };
  usersCache = users;
  await store.setItem(USERS_KEY, users);
  return users[name];
}

export async function removeUser(name) {
  await readyIfNeeded();
  let users = await listUsers();
  let key = String(name || '');
  if (key === 'root') throw new Error('cannot remove user root');
  if (!users[key]) return false;
  delete users[key];
  usersCache = users;
  await store.setItem(USERS_KEY, users);
  let groups = await listGroups();
  let changed = false;
  for (let g of Object.values(groups)) {
    if (g.members?.includes(key)) {
      g.members = g.members.filter(m => m !== key);
      changed = true;
    }
  }
  if (changed) {
    groupsCache = groups;
    await store.setItem(GROUPS_KEY, groups);
  }
  return true;
}

/** Human (player) accounts: created from the login screen, never NPCs. */
export async function listHumans() {
  let users = await listUsers();
  return Object.values(users).filter((u) => u.human).map((u) => u.name).sort();
}

export async function isHuman(name) {
  return !!(await getUser(name))?.human;
}

/* ---------- shadow (password hashes; never exposed via list/read) ---------- */

function b64(bytes) {
  let s = '';
  for (let b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function unb64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}

async function pbkdf2(password, salt, iterations) {
  let key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

/** Hash format: `$pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>` (like /etc/shadow). */
export async function hashPassword(password, iterations = 100000) {
  let salt = crypto.getRandomValues(new Uint8Array(16));
  let hash = await pbkdf2(password, salt, iterations);
  return `$pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

export async function setPassword(name, password) {
  await readyIfNeeded();
  let shadow = (await store.getItem(SHADOW_KEY)) || {};
  let next = { ...shadow };
  if (password == null || password === '') next = Object.fromEntries(Object.entries(shadow).filter(([k]) => k !== name));
  else next[name] = await hashPassword(password);
  await store.setItem(SHADOW_KEY, next);
}

/** True when the password matches; accounts without a hash accept only ''. */
export async function verifyPassword(name, password) {
  await readyIfNeeded();
  let shadow = (await store.getItem(SHADOW_KEY)) || {};
  let entry = shadow[name];
  if (!entry) return !password;
  let [, algo, iter, salt, hash] = String(entry).split('$');
  if (algo !== 'pbkdf2-sha256') return false;
  let got = b64(await pbkdf2(password, unb64(salt), Number(iter)));
  return got === hash;
}

export async function listGroups() {
  await readyIfNeeded();
  if (!groupsCache) groupsCache = (await store.getItem(GROUPS_KEY)) || {};
  return { ...groupsCache };
}

export async function getGroup(name) {
  let groups = await listGroups();
  return groups[String(name || '')] || null;
}

export async function saveGroup(group) {
  await readyIfNeeded();
  let groups = await listGroups();
  let name = String(group.name || '');
  if (!name) throw new Error('group name required');
  groups[name] = {
    name,
    gid: Number(group.gid),
    members: [...new Set((group.members || []).map(String))],
  };
  groupsCache = groups;
  await store.setItem(GROUPS_KEY, groups);
  return groups[name];
}

export async function removeGroup(name) {
  await readyIfNeeded();
  let groups = await listGroups();
  let key = String(name || '');
  if (key === 'sudo' || key === 'world') throw new Error('cannot remove system group ' + key);
  if (!groups[key]) return false;
  delete groups[key];
  groupsCache = groups;
  await store.setItem(GROUPS_KEY, groups);
  return true;
}

/**
 * Next ordinary uid (≥1001). Ignores nobody (65534) and other high system ids
 * so NPC allocation does not follow nobody+1.
 */
export async function nextUid() {
  let users = await listUsers();
  let max = 1000; // uid 1000 is reserved for the first player
  for (let u of Object.values(users)) {
    let id = Number(u.uid) || 0;
    if (id > max && id < NOBODY_UID) max = id;
  }
  return max + 1;
}

/** Next ordinary gid (≥1001). Same high-id skip as nextUid. */
export async function nextGid() {
  let groups = await listGroups();
  let max = 1000;
  for (let g of Object.values(groups)) {
    let id = Number(g.gid) || 0;
    if (id > max && id < NOBODY_UID) max = id;
  }
  return max + 1;
}

/** FS adapter matching webfoundry shellfs / Agent.js projectFs(). */
/**
 * FS adapter for the shell / kitty. Single-op helpers take a short lease
 * automatically (dbg RPCs do not — they require an explicit lease arg).
 */
export function createVfsFs() {
  let actor = 'shell';
  return {
    list,
    read: (path, opts = {}) => {
      if (opts?.lease) return read(path, opts);
      return withLock(path, (lease) => read(path, { ...opts, lease }), {
        mode: 'r',
        actor,
      });
    },
    write: (path, text, meta = {}) => {
      if (meta?.lease) return write(path, text, meta);
      return withLock(
        path,
        (lease) => write(path, text, { ...meta, lease }),
        { mode: 'w', actor },
      );
    },
    remove: (path, opts = {}) => {
      if (opts?.lease || opts?.meta?.lease) return remove(path, opts);
      let key = normalize(path);
      return withLock(key, (lease) => remove(path, { ...opts, lease }), {
        mode: 'w',
        actor,
      });
    },
    move: (from, to, opts = {}) => {
      if (opts?.lease && (opts?.srcLease || opts?.fromLease)) {
        return move(from, to, opts);
      }
      return withLocks(
        [from, to],
        (leases) =>
          move(from, to, {
            ...opts,
            srcLease: leases[normalize(from)],
            lease: leases[normalize(to)],
          }),
        { mode: 'w', actor },
      );
    },
    getStat,
    setStat,
    ensureStat,
    sizeOf,
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
    link: (existingPath, newPath, opts = {}) => {
      if (opts?.lease && (opts?.srcLease || opts?.fromLease)) {
        return link(existingPath, newPath, opts);
      }
      return withLocks(
        [existingPath, newPath],
        (leases) =>
          link(existingPath, newPath, {
            ...opts,
            srcLease: leases[normalize(existingPath)],
            lease: leases[normalize(newPath)],
          }),
        { mode: 'w', actor },
      );
    },
    symlink: (target, path, opts = {}) => {
      if (opts?.lease) return symlink(target, path, opts);
      return withLock(
        path,
        (lease) => symlink(target, path, { ...opts, lease }),
        { mode: 'w', actor },
      );
    },
    readlink,
    isSymlink,
    lock,
    unlock,
    renew,
    withLock,
    withLocks,
    listLocks,
  };
}

export function imageExt(path) {
  return /\.(png|jpe?g|jfif|gif|webp|svg|bmp|ico|avif|heic|heif|tiff?|apng)$/i.test(
    path || '',
  );
}

export function videoExt(path) {
  return /\.(mp4|webm|ogv|mov|m4v|mkv|avi|3gp)$/i.test(path || '');
}

/** Images and videos (anything Media Viewer can show). */
export function mediaExt(path) {
  return imageExt(path) || videoExt(path);
}

/**
 * Create a symbolic link. `target` is stored as given (absolute VFS path or
 * relative like `../gym`). Pass `{ force: true }` to overwrite (ln -sF).
 */
export async function symlink(target, path, opts = {}) {
  await ensureReady();
  let dest = normalize(path);
  let tgt = String(target ?? '');
  if (!dest) throw new Error('Invalid symlink path');
  if (!tgt) throw new Error('Invalid symlink target');
  await assertLease(dest, opts.lease, 'w', 'symlink');
  if (await exists(dest)) {
    if (!opts.force) throw new Error('File exists: ' + dest);
    await remove(dest, { lease: opts.lease });
  }
  let parent = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '';
  if (parent && !(await isDirPath(parent))) {
    let keep = parent + '/.keep';
    // Parent create uses the same exclusive lease only if paths share a key;
    // otherwise take a nested lock on the keep marker.
    await withLock(keep, (lease) => write(keep, '', { lease }), {
      mode: 'w',
      actor: opts.actor,
    });
  }
  await store.setItem(dest, { __tehboxen_symlink__: tgt });
  let existing = await getStat(dest);
  let owner = await resolveOwner(dest, opts, existing);
  await setStat(dest, {
    kind: 'symlink',
    mode: 0o777,
    uid: opts.uid ?? owner.uid,
    gid: opts.gid ?? owner.gid,
    target: tgt,
    mtime: Date.now(),
  });
  notify('write', dest);
  return { path: dest, target: tgt };
}

/** Read the raw symlink target string (does not resolve). */
export async function readlink(path) {
  await ensureReady();
  let key = normalize(path);
  if (!key) return null;
  let st = await getStat(key);
  if (st?.kind === 'symlink' && st.target != null) return String(st.target);
  let value = await store.getItem(key);
  if (isSymlinkMarker(value)) return String(value.__tehboxen_symlink__);
  // Legacy text marker: "symlink → places/cafe\n"
  if (typeof value === 'string') {
    let m = value.match(/^\s*symlink\s*→\s*(.+?)\s*$/);
    if (m) return m[1];
  }
  return null;
}

/** True when path is a symlink (including legacy text markers). */
export async function isSymlink(path) {
  await ensureReady();
  let key = normalize(path);
  let st = await getStat(key);
  if (st?.kind === 'symlink') return true;
  let value = await store.getItem(key);
  if (isSymlinkMarker(value)) return true;
  if (typeof value === 'string' && /^\s*symlink\s*→\s*/.test(value)) return true;
  return false;
}

/**
 * Create a hard link: `newPath` shares the inode/content of `existingPath`.
 * Directories cannot be hardlinked.
 * Requires shared/exclusive lease on src (`srcLease`) and exclusive on dest (`lease`).
 */
export async function link(existingPath, newPath, opts = {}) {
  await ensureReady();
  let src = normalize(existingPath);
  let dest = normalize(newPath);
  if (!src || !dest) throw new Error('Invalid link paths');
  if (src === dest) throw new Error('link: same path');
  await assertLease(src, opts.srcLease ?? opts.fromLease, 'r', 'link');
  await assertLease(dest, opts.lease ?? opts.destLease, 'w', 'link');
  if (await isDirPath(src)) throw new Error('link: cannot hardlink a directory');
  if ((await store.getItem(src)) == null && !(await getStat(src))?.ino) {
    throw new Error('No such file: ' + src);
  }
  if (await exists(dest)) throw new Error('File exists: ' + dest);
  let ino = await ensureInode(src);
  let srcStat = (await getStat(src)) || {};
  // Ensure parent dir exists for dest
  let parent = dest.includes('/') ? dest.slice(0, dest.lastIndexOf('/')) : '';
  if (parent && !(await isDirPath(parent))) {
    let keep = parent + '/.keep';
    await withLock(keep, (lease) => write(keep, '', { lease }), {
      mode: 'w',
      actor: opts.actor,
    });
  }
  await store.setItem(dest, { __tehboxen_hl__: ino });
  await setStat(dest, {
    kind: 'file',
    mode: srcStat.mode ?? DEFAULT_FILE_MODE,
    uid: srcStat.uid ?? ROOT_UID,
    gid: srcStat.gid ?? ROOT_UID,
    ino,
    mtime: Date.now(),
  });
  await bumpInoNlink(ino);
  notify('write', dest);
  return { path: dest, ino };
}

/**
 * Copy a file, or a directory recursively.
 * Requires shared lease on src (`srcLease`) and exclusive on dest (`lease`).
 * Directory copies use store-level reads/writes under those top-level leases
 * (child paths are not individually locked in Phase 1).
 */
export async function copy(from, to, opts = {}) {
  await ensureReady();
  let src = normalize(from);
  let dest = normalize(to);
  if (!src || !dest) throw new Error('Invalid copy paths');
  if (dest === src || dest.startsWith(src + '/')) {
    throw new Error('Cannot copy a folder into itself');
  }
  await assertLease(src, opts.srcLease ?? opts.fromLease, 'r', 'copy');
  await assertLease(dest, opts.lease ?? opts.destLease, 'w', 'copy');

  async function rawReadText(key) {
    let value = await store.getItem(key);
    if (value == null) {
      let st = await getStat(key);
      if (st?.ino != null) value = await store.getItem(inodeKey(st.ino));
    } else if (isLinkMarker(value)) {
      value = await store.getItem(inodeKey(value.__tehboxen_hl__));
    }
    if (value == null) return null;
    if (typeof value === 'string') return value;
    if (value instanceof Blob) return await value.text();
    if (typeof value === 'object' && typeof value.text === 'string') return value.text;
    return String(value);
  }

  async function rawReadBlob(key) {
    let value = await store.getItem(key);
    if (value == null) {
      let st = await getStat(key);
      if (st?.ino != null) value = await store.getItem(inodeKey(st.ino));
    } else if (isLinkMarker(value)) {
      value = await store.getItem(inodeKey(value.__tehboxen_hl__));
    }
    if (value == null) return null;
    if (value instanceof Blob) return value;
    if (typeof value === 'string') return new Blob([value], { type: 'text/plain' });
    return new Blob([String(value)], { type: 'application/octet-stream' });
  }

  async function rawWrite(key, text) {
    await store.setItem(key, String(text ?? ''));
    let existing = await getStat(key);
    let keepDir = dirPathFromKeep(key);
    await setStat(key, {
      mode: existing?.mode ?? (keepDir != null ? DEFAULT_DIR_MODE : DEFAULT_FILE_MODE),
      uid: existing?.uid ?? ROOT_UID,
      gid: existing?.gid ?? ROOT_UID,
      mtime: Date.now(),
      kind: keepDir != null ? 'dir' : 'file',
    });
    notify('write', key);
  }

  async function rawWriteBlob(key, blob) {
    let value = blob instanceof Blob ? blob : new Blob([blob]);
    await store.setItem(key, value);
    let existing = await getStat(key);
    await setStat(key, {
      mode: existing?.mode ?? DEFAULT_FILE_MODE,
      uid: existing?.uid ?? ROOT_UID,
      gid: existing?.gid ?? ROOT_UID,
      mtime: Date.now(),
      kind: 'file',
    });
    notify('write', key);
  }

  function shouldWriteAsBlob(path, blob) {
    if (!blob) return false;
    let t = blob.type || '';
    if (t && t !== 'text/plain') return true;
    // Empty/missing MIME: still treat known media extensions as binary so
    // copy does not corrupt images via rawWrite(text).
    return mediaExt(path) || imageExt(path) || videoExt(path);
  }

  if (await isDirPath(src)) {
    let prefix = src + '/';
    let paths = (await list()).filter((p) => p.startsWith(prefix));
    if (!paths.length) paths = [prefix + '.keep'];
    for (let p of paths) {
      let next = dest + '/' + p.slice(prefix.length);
      let blob = await rawReadBlob(p);
      if (shouldWriteAsBlob(p, blob)) await rawWriteBlob(next, blob);
      else await rawWrite(next, (await rawReadText(p)) ?? '');
    }
    if (!paths.includes(prefix + '.keep')) await rawWrite(dest + '/.keep', '');
    return;
  }
  let blob = await rawReadBlob(src);
  let text = await rawReadText(src);
  if (blob == null && text == null) {
    throw new Error('No such file: ' + src);
  }
  if (shouldWriteAsBlob(src, blob)) await rawWriteBlob(dest, blob);
  else await rawWrite(dest, text ?? '');
}

export function zipExt(path) {
  return /\.zip$/i.test(path || '');
}

export function textExt(path) {
  let p = String(path || '');
  if (
    /(^|\/)(\.env|\.gitignore|Dockerfile|Makefile)(\.|$)/i.test(p)
  ) {
    return true;
  }
  return /\.(txt|md|markdown|ya?ml|json|js|mjs|cjs|ts|tsx|jsx|html?|css|scss|less|xml|csv|log|sh|bash|zsh|env|ini|toml|rs|py|go|c|h|cpp|hpp|java|kt|swift|rb|php|sql|conf|cfg|vue|svelte|astro)$/i.test(
    p,
  );
}

/** Which Tehboxen app should open this path, or null if none. */
export function appForPath(path) {
  if (zipExt(path)) return 'winzip';
  if (mediaExt(path)) return 'mediaViewer';
  if (textExt(path)) return 'editor';
  return null;
}

/**
 * Serialize the entire localforage VFS store for export.
 * Each entry: { key, t: 'text'|'blob'|'json', value?, mime?, base64? }
 */
/**
 * Every path with its kind, from one store cursor (no content reads):
 * `{ path, kind }` where kind is 'file' | 'symlink' | 'dir' (a `.keep` marker).
 * Used by the node runtime's directory index.
 */
export async function listKinds() {
  await ensureReady();
  let out = [];
  await store.iterate((value, key) => {
    if (isReservedKey(key)) return;
    let dir = dirPathFromKeep(key);
    if (dir != null) out.push({ path: dir, kind: 'dir' });
    else out.push({ path: key, kind: isSymlinkMarker(value) ? 'symlink' : 'file' });
  });
  return out;
}

/**
 * Bulk write for trusted host code (package installs, archive extraction):
 * stores every file, creates missing parent directories (with `.keep`),
 * updates stats once and notifies per path. Skips content locks, so callers
 * must own the target tree (e.g. a fresh node_modules package directory).
 * @param {Array<{ path: string, data: string|Blob|Uint8Array, mode?: number }>} entries
 * @param {{ uid?: number, gid?: number, dirMode?: number }} [opts]
 */
export async function writeMany(entries, opts = {}) {
  await ensureReady();
  let stats = await loadStats();
  let now = Date.now();
  let uid = opts.uid ?? ROOT_UID;
  let gid = opts.gid ?? ROOT_UID;
  let written = [];
  let dirs = new Set();
  // Content writes go to IndexedDB in parallel; stats are saved once at the end.
  let pending = [];
  for (let e of entries) {
    let key = normalize(e.path);
    if (!key) continue;
    let data = e.data instanceof Uint8Array ? new Blob([e.data]) : e.data ?? '';
    let prev = stats[key];
    pending.push(prev?.ino != null ? store.setItem(inodeKey(prev.ino), data) : store.setItem(key, data));
    stats[key] = {
      ...(prev?.ino != null ? { ino: prev.ino, nlink: prev.nlink } : {}),
      kind: 'file',
      mode: (e.mode ?? prev?.mode ?? DEFAULT_FILE_MODE) & 0o7777,
      uid: prev?.uid ?? uid,
      gid: prev?.gid ?? gid,
      mtime: now,
    };
    written.push(key);
    let parts = key.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  await Promise.all(pending);
  let newDirs = [];
  for (let dir of [...dirs].sort()) {
    if (stats[dir]?.kind === 'dir' || (await store.getItem(dir + '/.keep')) != null) continue;
    await store.setItem(dir + '/.keep', '');
    stats[dir] = { kind: 'dir', mode: opts.dirMode ?? DEFAULT_DIR_MODE, uid, gid, mtime: now };
    newDirs.push(dir);
  }
  statCache = stats;
  await saveStats();
  for (let dir of newDirs) notify('write', dir + '/.keep', 'dir');
  for (let key of written) notify('write', key, 'file');
  return written.length;
}

/** Root-only callers: raw shadow entries ({ user: hash }). */
export async function readShadow() {
  await ensureReady();
  return { ...((await store.getItem(SHADOW_KEY)) || {}) };
}

export async function dumpStore() {
  await ensureReady();
  let entries = [];
  let keys = await store.keys();
  for (let key of keys) {
    let value = await store.getItem(key);
    if (value instanceof Blob) {
      let buf = await value.arrayBuffer();
      let bytes = new Uint8Array(buf);
      let bin = '';
      let chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      entries.push({
        key,
        t: 'blob',
        mime: value.type || 'application/octet-stream',
        base64: btoa(bin),
      });
    } else if (typeof value === 'string') {
      entries.push({ key, t: 'text', value });
    } else {
      entries.push({ key, t: 'json', value: value ?? null });
    }
  }
  return {
    format: 'tehboxen-vfs',
    version: 1,
    created: new Date().toISOString(),
    count: entries.length,
    entries,
  };
}

function blobFromBase64(b64, mime) {
  let bin = atob(String(b64 || ''));
  let bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'application/octet-stream' });
}

function resetRuntimeCaches() {
  ready = null;
  booting = false;
  statCache = null;
  usersCache = null;
  groupsCache = null;
}

/** Wipe every key in the VFS store and drop in-memory caches. */
export async function wipeStore() {
  resetRuntimeCaches();
  await store.clear();
}

/**
 * Import a dumpStore() snapshot.
 * mode 'replace': clear store, then write all entries.
 * mode 'merge': overwrite keys present in the pack (files + inodes);
 *   for STAT/USERS/GROUPS objects, shallow-merge so pack keys win;
 *   META merges with nextIno = max(local, pack).
 */
export async function importStore(snapshot, opts = {}) {
  let mode = opts.mode === 'merge' ? 'merge' : 'replace';
  let entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  if (snapshot && snapshot.format && snapshot.format !== 'tehboxen-vfs') {
    throw new Error('Unsupported pack format: ' + snapshot.format);
  }

  if (mode === 'replace') {
    await wipeStore();
  } else {
    // Keep store, but drop caches so reads see new data.
    statCache = null;
    usersCache = null;
    groupsCache = null;
  }

  let applyOne = async (ent) => {
    let key = String(ent?.key || '');
    if (!key) return;
    if (ent.t === 'blob') {
      await store.setItem(key, blobFromBase64(ent.base64, ent.mime));
      return;
    }
    if (ent.t === 'text') {
      await store.setItem(key, String(ent.value ?? ''));
      return;
    }
    // json
    let incoming = ent.value;
    if (
      mode === 'merge' &&
      incoming &&
      typeof incoming === 'object' &&
      !Array.isArray(incoming)
    ) {
      if (key === STAT_KEY || key === USERS_KEY || key === GROUPS_KEY) {
        let cur = (await store.getItem(key)) || {};
        await store.setItem(key, { ...cur, ...incoming });
        return;
      }
      if (key === META_KEY) {
        let cur = (await store.getItem(key)) || {};
        let nextIno = Math.max(
          Number(cur.nextIno) || 1,
          Number(incoming.nextIno) || 1,
        );
        await store.setItem(key, { ...cur, ...incoming, nextIno });
        return;
      }
    }
    await store.setItem(key, incoming ?? null);
  };

  for (let ent of entries) {
    await applyOne(ent);
  }

  resetRuntimeCaches();
  await ensureReady();
  return {
    mode,
    count: entries.length,
  };
}

/** Wipe + re-run boot seed (demo home/auth). Caller should reload the page. */
export async function factoryReset() {
  await wipeStore();
  await ensureReady();
}

export { normalize, ensureReady };
