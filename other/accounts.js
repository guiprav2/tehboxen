/**
 * Human (player) accounts for the login screen.
 *
 * A player is a normal VFS user flagged `human: true`: own uid/gid, private
 * home, member of `sudo` and `world`. Password hashes live in the shadow
 * store (vfs.setPassword / verifyPassword), never in the users db.
 * NPCs are created with provisionNpc (other/npc.js) and are never human.
 */
import * as vfs from './vfs.js';
import {
  PLAYER_UID,
  getUser,
  saveUser,
  getGroup,
  saveGroup,
  listUsers,
  nextUid,
  nextGid,
  listHumans,
  setPassword,
  verifyPassword,
  chownTree,
} from './vfs.js';
import { writeSession, clearSession } from './session.js';

export let NAME_RE = /^[a-z_][a-z0-9_-]{1,23}$/;

/** System and service names a player cannot take. */
export let RESERVED_NAMES = new Set([
  'root', 'nobody', 'godshand', 'guest', 'daemon', 'bin', 'sys', 'adm', 'admin',
  'www-data', 'mail', 'sshd', 'systemd', 'postgres', 'mysql', 'node', 'operator',
]);

export function validateName(name) {
  let n = String(name || '').trim();
  if (!n) return 'Pick a handle.';
  if (!NAME_RE.test(n)) return 'Handles are 2–24 chars: lowercase letters, digits, _ or -, not starting with a digit.';
  if (RESERVED_NAMES.has(n)) return `"${n}" is reserved by the system.`;
  return '';
}

export function validatePassword(pw) {
  if (String(pw || '').length < 6) return 'Passphrase must be at least 6 characters.';
  return '';
}

/** Public account list for the login screen (no secrets). */
export async function listAccounts() {
  await vfs.ensureReady();
  let users = await listUsers();
  let names = await listHumans();
  return names.map((n) => ({ name: n, gecos: users[n]?.gecos || n, uid: users[n]?.uid }));
}

async function writeAs(path, text, uid, gid, mode = 0o644) {
  await vfs.withLock(path, (lease) => vfs.write(path, text, { lease }), { mode: 'w' });
  await vfs.setStat(path, { kind: 'file', mode, uid, gid });
}

async function mkdirAs(dir, uid, gid, mode = 0o755) {
  await writeAs(dir + '/.keep', '', uid, gid);
  await vfs.setStat(dir, { kind: 'dir', mode, uid, gid });
}

/**
 * Create a human account and its home. Throws with a user-facing message.
 * @param {{ name: string, gecos?: string, password: string }} opts
 */
export async function createAccount(opts = {}) {
  await vfs.ensureReady();
  let name = String(opts.name || '').trim();
  let err = validateName(name) || validatePassword(opts.password);
  if (err) throw new Error(err);
  if (await getUser(name)) throw new Error(`Handle "${name}" is taken.`);

  let humans = await listHumans();
  let users = await listUsers();
  let uidTaken = Object.values(users).some((u) => Number(u.uid) === PLAYER_UID);
  let uid = !humans.length && !uidTaken ? PLAYER_UID : await nextUid();
  let gid;
  let existing = await getGroup(name);
  if (existing) gid = existing.gid;
  else {
    let groups = await vfs.listGroups();
    let gidTaken = Object.values(groups).some((g) => Number(g.gid) === uid);
    gid = gidTaken ? await nextGid() : uid;
    await saveGroup({ name, gid, members: [name] });
  }

  let home = 'home/' + name;
  let gecos = String(opts.gecos || '').trim() || name;
  await saveUser({ name, uid, gid, home, shell: '/bin/boxsh', gecos, human: true });
  await setPassword(name, opts.password);

  for (let gname of ['sudo', 'world']) {
    let g = await getGroup(gname);
    if (g && !g.members?.includes(name)) await saveGroup({ ...g, members: [...(g.members || []), name] });
  }

  await mkdirAs(home, uid, gid, 0o750);
  await writeAs(
    home + '/README.md',
    [
      `# ${gecos}'s box`,
      '',
      'Welcome to Tehboxen. This home lives on your virtual disk.',
      '',
      '- `node script.js` runs JavaScript (CommonJS or ES modules, top-level await) against this filesystem.',
      '- `kitty` in Terminal is the agent CLI; put API keys in `~/.kittygpt/.env`.',
      '- Your crew reaches you on Relay. Mail lands in BoxMail.',
      '',
    ].join('\n'),
    uid,
    gid,
  );
  await writeAs(
    home + '/.boxshrc',
    [
      '# ~/.boxshrc — sourced by Tehboxen Terminal on startup',
      '# export MOTD="Welcome back"',
      '# export PS1="\\[\\e[38;2;80;250;123m\\]\\u@\\h\\[\\e[0m\\]:\\[\\e[38;2;139;233;253m\\]\\w\\[\\e[0m\\]$ "',
      '',
    ].join('\n'),
    uid,
    gid,
  );
  await mkdirAs(home + '/.kittygpt', uid, gid, 0o700);
  await mkdirAs(home + '/code', uid, gid);
  await writeAs(
    home + '/code/hello.mjs',
    [
      "import os from 'node:os';",
      "import { readdir } from 'node:fs/promises';",
      '',
      "let files = await readdir(process.env.HOME);",
      'console.log(`hello from ${os.hostname()} — ${files.length} entries in ~`);',
      '',
    ].join('\n'),
    uid,
    gid,
  );
  await chownTree(home, uid, gid);

  try {
    let { moveTo } = await import('./places.js');
    await moveTo(name, 'safehouse', { force: true, log: false });
  } catch (e) {
    console.warn('createAccount: place user', e);
  }
  return { name, uid, gid, home, gecos };
}

/** Check credentials; on success stores the session. */
export async function login(name, password) {
  await vfs.ensureReady();
  let user = await getUser(String(name || '').trim());
  if (!user || !user.human) throw new Error('Unknown handle or wrong passphrase.');
  if (!(await verifyPassword(user.name, String(password || '')))) {
    throw new Error('Unknown handle or wrong passphrase.');
  }
  writeSession(user.name);
  return user;
}

export function logout() {
  clearSession();
}
