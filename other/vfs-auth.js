/**
 * Users, groups, and POSIX-like permission helpers for Tehboxen VFS.
 * root (uid 0) bypasses all access checks. players (uid 1000+, human: true) and godshand (uid 999)
 * are normal sudoers. No passwords.
 */
import {
  ensureReady,
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
  ROOT_UID,
  PLAYER_UID,
  GODSHAND_UID,
  NOBODY_UID,
  DEFAULT_FILE_MODE,
  DEFAULT_DIR_MODE,
  SHARED_ROOTS,
} from './vfs.js';

export {
  ROOT_UID,
  PLAYER_UID,
  GODSHAND_UID,
  NOBODY_UID,
  DEFAULT_FILE_MODE,
  DEFAULT_DIR_MODE,
  SHARED_ROOTS,
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
  getStat,
  setStat,
  ensureStat,
};

/** Mode bits */
export let S_IRUSR = 0o400;
export let S_IWUSR = 0o200;
export let S_IXUSR = 0o100;
export let S_IRGRP = 0o040;
export let S_IWGRP = 0o020;
export let S_IXGRP = 0o010;
export let S_IROTH = 0o004;
export let S_IWOTH = 0o002;
export let S_IXOTH = 0o001;

export function isRoot(uid) {
  return Number(uid) === ROOT_UID;
}

export async function groupsForUser(username) {
  await ensureReady();
  let name = String(username || '');
  let groups = await listGroups();
  let out = [];
  for (let g of Object.values(groups)) {
    if (g.members?.includes(name) || g.name === name) out.push(g);
  }
  return out.sort((a, b) => a.gid - b.gid);
}

export async function primaryGid(username) {
  let u = await getUser(username);
  return u ? u.gid : 0;
}

/**
 * Can actor (euid/egid + supplemental gids) access path for 'r'|'w'|'x'?
 * Directories use the same bit checks; callers decide traverse vs list.
 */
export async function canAccess(path, want, actor) {
  let uid = Number(actor?.uid ?? 0);
  if (isRoot(uid)) return true;
  let st = await getStat(path);
  if (!st) {
    // Missing stat: allow read of unknown, deny write — callers usually ensureStat first.
    return want === 'r';
  }
  let mode = st.mode & 0o777;
  let bit =
    want === 'r' ? 4 : want === 'w' ? 2 : want === 'x' ? 1 : 0;
  if (!bit) return false;

  if (uid === st.uid) return ((mode >> 6) & bit) === bit;
  let gids = new Set([Number(actor?.gid ?? -1), ...(actor?.gids || []).map(Number)]);
  if (gids.has(st.gid)) return ((mode >> 3) & bit) === bit;
  return (mode & bit) === bit;
}

export async function assertAccess(path, want, actor, label = path) {
  if (await canAccess(path, want, actor)) return;
  let err = new Error(`${label}: Permission denied`);
  err.code = 1;
  err.errno = 'EACCES';
  throw err;
}

/** Format mode like ls: drwxr-xr-x / -rw-r--r-- */
export function formatMode(mode, kind = 'file') {
  let m = mode & 0o777;
  let type = kind === 'dir' ? 'd' : '-';
  let s = '';
  for (let shift of [6, 3, 0]) {
    let part = (m >> shift) & 7;
    s += part & 4 ? 'r' : '-';
    s += part & 2 ? 'w' : '-';
    s += part & 1 ? 'x' : '-';
  }
  return type + s;
}

export function parseModeSpec(spec, current = 0o644) {
  let text = String(spec || '').trim();
  if (/^[0-7]{3,4}$/.test(text)) return parseInt(text, 8) & 0o7777;

  let mode = current & 0o777;
  let parts = text.split(',');
  for (let part of parts) {
    let m = /^([ugoa]*)([+\-=])([rwx]*)$/.exec(part.trim());
    if (!m) throw Object.assign(new Error(`invalid mode: ${spec}`), { code: 1 });
    let who = m[1] || 'a';
    let op = m[2];
    let bits = 0;
    if (m[3].includes('r')) bits |= 4;
    if (m[3].includes('w')) bits |= 2;
    if (m[3].includes('x')) bits |= 1;
    let mask = 0;
    if (who.includes('u') || who === 'a') mask |= bits << 6;
    if (who.includes('g') || who === 'a') mask |= bits << 3;
    if (who.includes('o') || who === 'a') mask |= bits;
    if (who === 'a' && !m[1]) {
      mask = (bits << 6) | (bits << 3) | bits;
    }
    if (op === '+') mode |= mask;
    else if (op === '-') mode &= ~mask;
    else if (op === '=') {
      let clear = 0;
      if (who.includes('u') || who === 'a' || !m[1]) clear |= 0o700;
      if (who.includes('g') || who === 'a' || !m[1]) clear |= 0o070;
      if (who.includes('o') || who === 'a' || !m[1]) clear |= 0o007;
      if (!m[1]) clear = 0o777;
      mode = (mode & ~clear) | mask;
    }
  }
  return mode & 0o777;
}

export async function resolveUserRef(ref) {
  let text = String(ref || '');
  if (/^\d+$/.test(text)) {
    let uid = Number(text);
    let users = await listUsers();
    let found = Object.values(users).find(u => u.uid === uid);
    return found || { uid, gid: uid, name: String(uid), home: 'home/' + uid, shell: '/bin/boxsh' };
  }
  let u = await getUser(text);
  if (!u) return null;
  return u;
}

export async function resolveGroupRef(ref) {
  let text = String(ref || '');
  if (/^\d+$/.test(text)) {
    let gid = Number(text);
    let groups = await listGroups();
    let found = Object.values(groups).find(g => g.gid === gid);
    return found || { gid, name: String(gid), members: [] };
  }
  return getGroup(text);
}

export async function actorFromUser(username) {
  let u = await getUser(username);
  if (!u) return null;
  let groups = await groupsForUser(u.name);
  let gids = [...new Set([Number(u.gid), ...groups.map(g => Number(g.gid))])];
  return {
    name: u.name,
    uid: u.uid,
    gid: u.gid,
    gids,
    home: u.home,
    shell: u.shell,
  };
}
