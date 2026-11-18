/**
 * Canonical chat objects under var/chats/<id>/ with hardlinked views into
 * each participant's ~/.<app>/… tree.
 *
 * DMs:  home/<user>/.<app>/<peer>/messages.yaml
 * Groups: home/<user>/.<app>/g-<chatId>/messages.yaml
 *
 * Message schema (contact-agnostic):
 *   from: <username>
 *   <username>_read: bool   # per participant
 * Legacy me/them + read is still accepted by ChatStore during migration.
 */
import { PLAYER, PLAYER_HOME } from './session.js';
import * as vfs from './vfs.js';
import { getUser, DEFAULT_DIR_MODE, DEFAULT_FILE_MODE } from './vfs-auth.js';
import {
  readYaml,
  writeYaml,
  ensureDir,
  ensureAppendOnlyListFile,
  uuid,
  nowIso,
  newId,
} from './messaging.js';

export let CHATS_ROOT = 'var/chats';
export let GROUP_VIEW_PREFIX = 'g-';

function appDir(user, app) {
  return 'home/' + user + '/.' + app;
}

function peerView(user, app, peer) {
  return appDir(user, app) + '/' + peer;
}

export function groupViewId(chatId) {
  return GROUP_VIEW_PREFIX + String(chatId || '');
}

export function groupView(user, app, chatId) {
  return appDir(user, app) + '/' + groupViewId(chatId);
}

export function isGroupViewId(id) {
  return String(id || '').startsWith(GROUP_VIEW_PREFIX);
}

export function chatIdFromGroupViewId(id) {
  let s = String(id || '');
  return isGroupViewId(s) ? s.slice(GROUP_VIEW_PREFIX.length) : null;
}

async function chatRoot(chatId) {
  return CHATS_ROOT + '/' + String(chatId);
}

async function readMeta(chatId) {
  return (await readYaml((await chatRoot(chatId)) + '/meta.yaml', null)) || null;
}

async function writeMeta(chatId, meta) {
  await writeYaml((await chatRoot(chatId)) + '/meta.yaml', meta);
}

/** Canonical Relay avatar path for a user. */
export function userAvatarPath(username, app = 'relay') {
  return 'home/' + String(username) + '/.' + String(app || 'relay') + '/avatar.jpg';
}

/** Main portrait under ~/Pictures. */
export function userPortraitPath(username) {
  return 'home/' + String(username) + '/Pictures/portrait.jpg';
}

/**
 * Hardlink peer's ~/.relay/avatar.jpg into viewDir/avatar.jpg (0644 inode).
 * No-op if the peer has no avatar yet. Replaces a stale different-inode file.
 */
export async function linkPeerAvatar(peerUser, viewDir, opts = {}) {
  let app = opts.app || 'relay';
  let src = userAvatarPath(peerUser, app);
  if (!(await vfs.exists(src))) return { linked: false, reason: 'no-avatar' };
  let dest = String(viewDir || '').replace(/\/$/, '') + '/avatar.jpg';
  if (await vfs.exists(dest)) {
    let st = await vfs.getStat(dest);
    let srcSt = await vfs.getStat(src);
    if (st?.ino != null && srcSt?.ino != null && Number(st.ino) === Number(srcSt.ino)) {
      return { linked: true, reused: true, src, dest };
    }
    await vfs.withLock(dest, (lease) => vfs.remove(dest, { lease }), {
      mode: 'w',
      actor: opts.actor,
    });
  }
  await vfs.withLocks(
    [src, dest],
    (leases) => vfs.link(src, dest, { srcLease: leases[src], lease: leases[dest] }),
    { mode: 'w', actor: opts.actor },
  );
  // Keep subject ownership + world-readable; contacts must not overwrite.
  try {
    let srcSt = await vfs.getStat(src);
    if (srcSt) {
      await vfs.setStat(src, {
        ...srcSt,
        mode: 0o644,
        kind: 'file',
      });
    }
  } catch {}
  return { linked: true, src, dest };
}

/**
 * Ensure ~/Pictures/portrait.jpg and ~/.relay/avatar.jpg share one inode
 * (hardlink avatar → portrait when only one exists, or link missing side).
 */
export async function syncUserPortraitAvatar(username, opts = {}) {
  let app = opts.app || 'relay';
  let portrait = userPortraitPath(username);
  let avatar = userAvatarPath(username, app);
  let hasP = await vfs.exists(portrait);
  let hasA = await vfs.exists(avatar);
  if (!hasP && !hasA) return { ok: false, reason: 'missing' };
  if (hasP && hasA) {
    let a = await vfs.getStat(avatar);
    let p = await vfs.getStat(portrait);
    if (a?.ino != null && p?.ino != null && Number(a.ino) === Number(p.ino)) {
      await vfs.setStat(portrait, { ...p, mode: 0o644 });
      return { ok: true, shared: true };
    }
    // Prefer portrait as canonical: replace avatar with hardlink to portrait.
    await vfs.withLock(avatar, (lease) => vfs.remove(avatar, { lease }), {
      mode: 'w',
      actor: opts.actor,
    });
    await vfs.withLocks(
      [portrait, avatar],
      (leases) =>
        vfs.link(portrait, avatar, {
          srcLease: leases[portrait],
          lease: leases[avatar],
        }),
      { mode: 'w', actor: opts.actor },
    );
  } else if (hasP && !hasA) {
    await ensureDir('home/' + username + '/.' + app);
    await vfs.withLocks(
      [portrait, avatar],
      (leases) =>
        vfs.link(portrait, avatar, {
          srcLease: leases[portrait],
          lease: leases[avatar],
        }),
      { mode: 'w', actor: opts.actor },
    );
  } else if (!hasP && hasA) {
    await ensureDir('home/' + username + '/Pictures');
    await vfs.withLocks(
      [avatar, portrait],
      (leases) =>
        vfs.link(avatar, portrait, {
          srcLease: leases[avatar],
          lease: leases[portrait],
        }),
      { mode: 'w', actor: opts.actor },
    );
  }
  for (let p of [portrait, avatar]) {
    if (!(await vfs.exists(p))) continue;
    let st = await vfs.getStat(p);
    let u = await getUser(username);
    await vfs.setStat(p, {
      ...(st || {}),
      mode: 0o644,
      uid: Number(u?.uid ?? st?.uid),
      gid: Number(u?.gid ?? st?.gid),
      kind: 'file',
    });
  }
  return { ok: true, portrait, avatar };
}

/** True when dest already shares canons inode (hardlinked). */
async function isMessagesHardlink(canonPath, destPath) {
  let cSt = await vfs.getStat(canonPath);
  let dSt = await vfs.getStat(destPath);
  if (
    cSt?.ino != null &&
    dSt?.ino != null &&
    Number(cSt.ino) === Number(dSt.ino)
  ) {
    return true;
  }
  // Optional: store-marker fallback when vfs.getIno is available (post-reload).
  if (typeof vfs.getIno === 'function') {
    let cIno = await vfs.getIno(canonPath);
    let dIno = await vfs.getIno(destPath);
    return cIno != null && dIno != null && Number(cIno) === Number(dIno);
  }
  return false;
}

/** Hardlink canonical messages.yaml into a participant view folder. */
async function linkMessagesView(root, view) {
  await ensureDir(view);
  await ensureDir(view + '/files');
  let src = root + '/messages.yaml';
  let dest = view + '/messages.yaml';
  if (!(await vfs.exists(src))) {
    await ensureAppendOnlyListFile(src);
  }
  if (await vfs.exists(dest)) {
    if (await isMessagesHardlink(src, dest)) {
      // Heal missing/stale ino on stats so later write/append keep the link.
      let cSt = await vfs.getStat(src);
      let ino =
        cSt?.ino != null
          ? Number(cSt.ino)
          : typeof vfs.getIno === 'function'
            ? await vfs.getIno(src)
            : null;
      for (let p of [src, dest]) {
        let st = await vfs.getStat(p);
        if (ino != null && (st?.ino == null || Number(st.ino) !== Number(ino))) {
          await vfs.setStat(p, { ...(st || {}), kind: 'file', ino: Number(ino) });
        }
      }
      return;
    }
    // Divergent file (or orphaned stat) — drop and re-link to canon.
    await vfs.withLock(dest, (lease) => vfs.remove(dest, { lease }), { mode: 'w' });
  }
  await vfs.withLocks(
    [src, dest],
    (leases) => vfs.link(src, dest, { srcLease: leases[src], lease: leases[dest] }),
    { mode: 'w' },
  );
}

/**
 * One-time content heal: if a view has a richer messages list than canon,
 * copy it into canon before re-linking (avoids wiping history on hardlink repair).
 */
async function healCanonFromViews(root, views, opts = {}) {
  let canon = root + '/messages.yaml';
  let candidates = [canon, ...views.map((v) => String(v).replace(/\/$/, '') + '/messages.yaml')];
  let best = [];
  let bestPath = canon;
  for (let mp of candidates) {
    if (!(await vfs.exists(mp))) continue;
    let list = [];
    try {
      list = (await readYaml(mp, [])) || [];
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    if (list.length > best.length) {
      best = list;
      bestPath = mp;
    }
  }
  if (!(await vfs.exists(canon))) {
    await ensureDir(root);
    await ensureDir(root + '/files');
    if (best.length) await writeYaml(canon, best, { actor: opts.actor });
    else await ensureAppendOnlyListFile(canon);
    return { healed: !!best.length, bestPath, len: best.length };
  }
  if (bestPath !== canon && best.length) {
    let cur = [];
    try {
      cur = (await readYaml(canon, [])) || [];
    } catch {
      cur = [];
    }
    if (!Array.isArray(cur) || cur.length < best.length) {
      await writeYaml(canon, best, { actor: opts.actor || 'chats-repair' });
      return { healed: true, bestPath, len: best.length };
    }
  }
  return { healed: false, bestPath, len: best.length };
}

/**
 * Re-link every var/chats/<id>/messages.yaml into its participant home views.
 * Merges divergent view content into canon (richest list wins) before linking.
 */
export async function repairAllChatHardlinks(opts = {}) {
  await vfs.ensureReady();
  let appFilter = opts.app || null;
  let all = await vfs.list();
  let prefix = CHATS_ROOT + '/';
  let repaired = [];
  let skipped = [];
  for (let p of all) {
    if (!p.startsWith(prefix) || !p.endsWith('/meta.yaml')) continue;
    let meta = (await readYaml(p, null)) || {};
    if (!meta || !Array.isArray(meta.participants) || meta.participants.length < 2) {
      skipped.push({ path: p, reason: 'bad-meta' });
      continue;
    }
    if (appFilter && meta.app && meta.app !== appFilter) continue;
    let chatId = meta.id || p.slice(prefix.length).split('/')[0];
    let root = CHATS_ROOT + '/' + chatId;
    let app = meta.app || 'relay';
    let kind = meta.kind || (meta.participants.length > 2 ? 'group' : 'dm');

    let views = [];
    if (kind === 'group' || meta.participants.length > 2) {
      for (let user of meta.participants) {
        views.push(groupView(user, app, chatId));
      }
    } else {
      let [a, b] = meta.participants;
      views.push(peerView(a, app, b), peerView(b, app, a));
    }

    await healCanonFromViews(root, views, { actor: opts.actor || 'chats-repair' });

    for (let view of views) {
      await ensureDir(view);
      await ensureDir(view + '/files');
      await linkMessagesView(root, view);
    }
    await chownChatFiles(chatFilePaths(root, views), meta.participants[0]);
    repaired.push({ chatId, kind, participants: meta.participants, views: views.length });
  }
  return { repaired, skipped, count: repaired.length };
}

async function writeGroupProfile(view, meta) {
  let title = meta.title || 'Group';
  await writeYaml(view + '/profile.yaml', {
    kind: 'group',
    chatId: meta.id,
    name: title,
    title,
    participants: [...(meta.participants || [])],
    createdBy: meta.createdBy || '',
    color: meta.color || '#34B7F1',
  });
}

async function refreshGroupProfiles(meta, app) {
  let chatId = meta.id;
  for (let user of meta.participants || []) {
    let view = groupView(user, app, chatId);
    if (await vfs.exists(view)) await writeGroupProfile(view, meta);
  }
}

/**
 * Make chat files writable by all world members. Hardlink views keep their own
 * path stats, so pass every messages.yaml path that should stay in sync.
 */
export async function chownChatFiles(paths, ownerUser) {
  let list = Array.isArray(paths) ? paths : [paths];
  let u = await getUser(ownerUser);
  let uid = Number(u?.uid ?? 1000);
  let world = null;
  try {
    let { getGroup } = await import('./vfs-auth.js');
    world = await getGroup('world');
  } catch {}
  let gid = Number(world?.gid ?? u?.gid ?? uid);
  for (let p of list) {
    if (!p || !(await vfs.exists(p))) continue;
    try {
      // 0666: any participant can append through their view hardlink.
      await vfs.setStat(p, { uid, gid, mode: 0o666 });
    } catch {}
  }
}

function chatFilePaths(root, viewPaths = []) {
  let out = [root + '/messages.yaml', root + '/meta.yaml'];
  for (let view of viewPaths) out.push(String(view).replace(/\/$/, '') + '/messages.yaml');
  return out;
}

/**
 * Normalize a raw message into the contact-agnostic shape.
 * @param {object} m
 * @param {{ self?: string, peer?: string }} ctx  self = former "me", peer = former "them"
 */
export function normalizeMessage(m, ctx = {}) {
  if (!m || typeof m !== 'object') return null;
  let self = ctx.self || PLAYER;
  let peer = ctx.peer || 'them';
  let fromRaw = String(m.from ?? '').toLowerCase();
  let from =
    fromRaw === 'me' ? self : fromRaw === 'them' ? peer : String(m.from ?? peer);
  let out = { ...m, from };
  if (out.id == null || out.id === '') out.id = newId();
  if (out.time == null) out.time = nowIso();
  // Per-user read flags
  let participants = [...new Set([self, peer, ...(ctx.participants || [])])];
  for (let u of participants) {
    let key = u + '_read';
    if (out[key] == null) {
      if (u === from) out[key] = true;
      else if (m.read === true && u === self) out[key] = true;
      else out[key] = false;
    }
  }
  // Drop legacy single read once migrated (keep during transition for old UIs)
  return out;
}

export function isMine(m, selfUser) {
  let from = String(m?.from ?? '').toLowerCase();
  let self = String(selfUser || PLAYER).toLowerCase();
  return from === 'me' || from === self;
}

export function isUnreadFor(m, selfUser) {
  if (isMine(m, selfUser)) return false;
  let key = String(selfUser || PLAYER) + '_read';
  if (m && m[key] === true) return false;
  if (m && m.read === true) return false; // legacy
  return true;
}

export async function markReadFor(messages, selfUser) {
  let key = String(selfUser || PLAYER) + '_read';
  return (messages || []).map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (isMine(m, selfUser)) return m;
    if (m[key] === true && m.read === true) return m;
    return { ...m, [key]: true, read: true };
  });
}

/**
 * Create canonical chat + hardlinked messages.yaml into each home.
 * @param {{ participants: string[], app?: string, chatId?: string, messages?: any[], peerProfiles?: Record<string, object> }} opts
 */
export async function createChat(opts = {}) {
  await vfs.ensureReady();
  let participants = [...new Set((opts.participants || []).map(String))].sort();
  if (participants.length < 2) throw new Error('createChat: need ≥2 participants');
  let app = opts.app || 'relay';
  let chatId = opts.chatId || uuid();
  let root = CHATS_ROOT + '/' + chatId;

  for (let u of participants) {
    if (!(await getUser(u))) throw new Error('createChat: unknown user ' + u);
  }

  await ensureDir(root);
  await ensureDir(root + '/files');
  await writeYaml(root + '/meta.yaml', {
    id: chatId,
    app,
    kind: 'dm',
    participants,
    created: nowIso(),
  });

  let messages = Array.isArray(opts.messages) ? opts.messages : [];
  // Create-once only; afterward messages.yaml is append-only (empty file, not `[]`).
  let msgPath = root + '/messages.yaml';
  if (!(await vfs.exists(msgPath))) {
    if (messages.length) await writeYaml(msgPath, messages);
    else await ensureAppendOnlyListFile(msgPath);
  }

  // Hardlink messages into each participant's view of every other peer.
  // For a 1:1 chat, each side gets one peer folder.
  let views = [];
  for (let user of participants) {
    for (let peer of participants) {
      if (peer === user) continue;
      let view = peerView(user, app, peer);
      views.push(view);
      await ensureDir(view);
      await ensureDir(view + '/files');
      // Profile projection (copy, not hardlink — each side may annotate)
      let profile =
        opts.peerProfiles?.[peer] ||
        (await readYaml('home/' + peer + '/profile.yaml', {}).catch(() => ({}))) ||
        {};
      let publicProfile = {
        name: profile.name || peer,
        phone: profile.phone || '',
        about: profile.about || '',
        color: profile.color || '',
        user: peer,
        avatar: 'avatar.jpg',
      };
      if (!(await vfs.exists(view + '/profile.yaml'))) {
        await writeYaml(view + '/profile.yaml', publicProfile);
      } else {
        let cur = (await readYaml(view + '/profile.yaml', {})) || {};
        if (!cur.avatar) {
          await writeYaml(view + '/profile.yaml', { ...cur, avatar: 'avatar.jpg' });
        }
      }
      await linkMessagesView(root, view);
      await syncUserPortraitAvatar(peer, { app }).catch(() => {});
      await linkPeerAvatar(peer, view, { app });
    }
  }
  await chownChatFiles(chatFilePaths(root, views), participants[0]);

  return { chatId, root, participants, app, kind: 'dm' };
}

/**
 * Clear a 1:1 conversation (wipe messages.yaml to empty) but **keep** the
 * contact relationship and both home views / avatars / profiles.
 */
export async function clearDmMessages(userA, userB, opts = {}) {
  let a = String(userA || '');
  let b = String(userB || '');
  if (!a || !b || a === b) throw new Error('clearDmMessages: two distinct users required');
  let app = opts.app || 'relay';
  await vfs.ensureReady();

  let root = null;
  let all = await vfs.list();
  let prefix = CHATS_ROOT + '/';
  for (let p of all) {
    if (!p.startsWith(prefix) || !p.endsWith('/meta.yaml')) continue;
    let meta = (await readYaml(p, null)) || {};
    let parts = meta.participants || [];
    if (meta.app === app && parts.includes(a) && parts.includes(b) && parts.length === 2) {
      root = CHATS_ROOT + '/' + (meta.id || p.slice(prefix.length).split('/')[0]);
      break;
    }
  }
  if (!root) throw new Error('clearDmMessages: no chat between ' + a + ' and ' + b);
  let msgPath = root + '/messages.yaml';
  await vfs.withLock(msgPath, (lease) => vfs.write(msgPath, '', { lease }), {
    mode: 'w',
    actor: opts.actor || 'chats-clear',
  });
  return { root, cleared: msgPath };
}

/**
 * Delete a 1:1 **contact** between two users: both home views + var/chats/<id>/.
 * Prefer clearDmMessages when you only want to wipe the convo history.
 */
export async function removeDm(userA, userB, opts = {}) {
  let a = String(userA || '');
  let b = String(userB || '');
  if (!a || !b || a === b) throw new Error('removeDm: two distinct users required');
  let app = opts.app || 'relay';
  await vfs.ensureReady();

  let chatId = null;
  let root = null;
  let all = await vfs.list();
  let prefix = CHATS_ROOT + '/';
  for (let p of all) {
    if (!p.startsWith(prefix) || !p.endsWith('/meta.yaml')) continue;
    let meta = (await readYaml(p, null)) || {};
    let parts = meta.participants || [];
    if (meta.app === app && parts.includes(a) && parts.includes(b) && parts.length === 2) {
      chatId = meta.id || p.slice(prefix.length).split('/')[0];
      root = CHATS_ROOT + '/' + chatId;
      break;
    }
  }

  let removed = [];
  for (let [user, peer] of [
    [a, b],
    [b, a],
  ]) {
    let view = peerView(user, app, peer);
    if (await vfs.exists(view)) {
      await vfs.withLock(view, (lease) => vfs.remove(view + '/', { lease }), {
        mode: 'w',
        actor: opts.actor || 'chats-remove',
      });
      removed.push(view);
    }
  }
  if (root && (await vfs.exists(root))) {
    await vfs.withLock(root, (lease) => vfs.remove(root + '/', { lease }), {
      mode: 'w',
      actor: opts.actor || 'chats-remove',
    });
    removed.push(root);
  }
  return { chatId, removed };
}

/**
 * Ensure a 1:1 contact relationship (chat object + hardlinks).
 */
export async function addContact(userA, userB, opts = {}) {
  let a = String(userA || '');
  let b = String(userB || '');
  if (!a || !b || a === b) throw new Error('addContact: two distinct users required');
  let app = opts.app || 'relay';

  // Reuse existing chat if meta already lists both.
  let all = await vfs.list();
  let prefix = CHATS_ROOT + '/';
  for (let p of all) {
    if (!p.startsWith(prefix) || !p.endsWith('/meta.yaml')) continue;
    let meta = (await readYaml(p, null)) || {};
    let parts = meta.participants || [];
    if (meta.app === app && parts.includes(a) && parts.includes(b) && parts.length === 2) {
      let chatId = meta.id || p.slice(prefix.length).split('/')[0];
      let root = CHATS_ROOT + '/' + chatId;
      let views = [];
      // Re-link views in case a home was wiped or hardlinks were broken by a
      // write that lost stat.ino (see vfs.write resolveIno). Heal richest
      // divergent messages.yaml into canon first so re-link does not wipe history.
      for (let user of [a, b]) {
        let peer = user === a ? b : a;
        views.push(peerView(user, app, peer));
      }
      await healCanonFromViews(root, views, { actor: opts.actor || 'chats-addContact' });
      for (let user of [a, b]) {
        let peer = user === a ? b : a;
        let view = peerView(user, app, peer);
        await ensureDir(view);
        await ensureDir(view + '/files');
        await linkMessagesView(root, view);
        if (!(await vfs.exists(view + '/profile.yaml'))) {
          let profile =
            opts.peerProfiles?.[peer] ||
            (await readYaml('home/' + peer + '/profile.yaml', {}).catch(() => ({}))) ||
            {};
          await writeYaml(view + '/profile.yaml', {
            name: profile.name || peer,
            phone: profile.phone || '',
            about: profile.about || '',
            color: profile.color || '',
            user: peer,
            avatar: 'avatar.jpg',
          });
        }
        await syncUserPortraitAvatar(peer, { app }).catch(() => {});
        await linkPeerAvatar(peer, view, { app });
      }
      await chownChatFiles(chatFilePaths(root, views), a);
      return { chatId, root, participants: [a, b], app, reused: true };
    }
  }

  return createChat({
    participants: [a, b],
    app,
    messages: opts.messages || [],
    peerProfiles: opts.peerProfiles,
  });
}

/**
 * Migrate a legacy phone-folder chat under the player home .relay/<phone>/
 * into a hardlinked chat with an NPC (matched by profile.phone or explicit npcId).
 */
export async function migratePhoneChat(phoneOrId, opts = {}) {
  await vfs.ensureReady();
  let contactId = String(phoneOrId || '');
  let app = opts.app || 'relay';
  let playerRoot = PLAYER_HOME + '/.' + app;
  let dir = playerRoot + '/' + contactId;
  if (!(await vfs.isDirectory(dir))) throw new Error('migratePhoneChat: missing ' + dir);

  let profile = (await readYaml(dir + '/profile.yaml', {})) || {};
  let raw = (await readYaml(dir + '/messages.yaml', [])) || [];
  if (!Array.isArray(raw)) raw = [];

  let npcId = opts.npcId;
  if (!npcId) {
    let phone = String(profile.phone || contactId);
    let { listUsers } = await import('./vfs-auth.js');
    let users = await listUsers();
    for (let u of Object.values(users)) {
      if (['root', PLAYER, 'nobody'].includes(u.name) || u.human) continue;
      let np = (await readYaml('home/' + u.name + '/profile.yaml', {}).catch(() => ({}))) || {};
      if (String(np.phone || '') === phone || u.name === contactId) {
        npcId = u.name;
        break;
      }
    }
  }
  if (!npcId) throw new Error('migratePhoneChat: no NPC for ' + contactId);

  let messages = raw
    .map((m) => normalizeMessage(m, { self: PLAYER, peer: npcId, participants: [PLAYER, npcId] }))
    .filter(Boolean);

  // Copy attachment files into canonical files/ after chat create
  let result = await createChat({
    participants: [PLAYER, npcId],
    app,
    messages,
    peerProfiles: {
      [npcId]: { ...profile, user: npcId },
      [PLAYER]: (await readYaml(playerRoot + '/profile.yaml', {}).catch(() => ({}))) || {},
    },
  });

  let filesPrefix = dir + '/files/';
  let all = await vfs.list();
  for (let p of all) {
    if (!p.startsWith(filesPrefix) || p.endsWith('/.keep')) continue;
    let name = p.slice(filesPrefix.length);
    if (name.includes('/')) continue;
    let dest = result.root + '/files/' + name;
    if (!(await vfs.exists(dest))) {
      await vfs.withLocks(
        [p, dest],
        (leases) => vfs.copy(p, dest, { srcLease: leases[p], lease: leases[dest] }),
        { mode: 'w' },
      );
    }
    // Hardlink into both views
    for (let [user, peer] of [
      [PLAYER, npcId],
      [npcId, PLAYER],
    ]) {
      let viewFile = peerView(user, app, peer) + '/files/' + name;
      if (await vfs.exists(viewFile)) await vfs.withLock(viewFile, (lease) => vfs.remove(viewFile, { lease }), { mode: 'w' });
      await ensureDir(peerView(user, app, peer) + '/files');
      await vfs.withLocks(
        [dest, viewFile],
        (leases) =>
          vfs.link(dest, viewFile, {
            srcLease: leases[dest],
            lease: leases[viewFile],
          }),
        { mode: 'w' },
      );
    }
  }

  // Remove legacy phone folder if it was phone-named (keep slug folders)
  if (contactId !== npcId && opts.removeLegacy !== false) {
    await vfs.withLock(dir, (lease) => vfs.remove(dir + '/', { lease }), { mode: 'w' });
  }

  return { ...result, npcId, legacyId: contactId };
}

/**
 * Create a group chat. Views land at home/<user>/.<app>/g-<chatId>/.
 * @param {{ title: string, participants: string[], createdBy: string, app?: string, chatId?: string, messages?: any[], color?: string }} opts
 */
export async function createGroup(opts = {}) {
  await vfs.ensureReady();
  let createdBy = String(opts.createdBy || '');
  let participants = [...new Set([...(opts.participants || []).map(String), createdBy].filter(Boolean))].sort();
  if (!createdBy) throw new Error('createGroup: createdBy required');
  if (participants.length < 3) throw new Error('createGroup: need ≥3 participants (including creator)');
  let app = opts.app || 'relay';
  let title = String(opts.title || '').trim() || 'Group';
  let chatId = opts.chatId || uuid();
  let root = CHATS_ROOT + '/' + chatId;

  for (let u of participants) {
    if (!(await getUser(u))) throw new Error('createGroup: unknown user ' + u);
  }

  let meta = {
    id: chatId,
    app,
    kind: 'group',
    title,
    participants,
    created: nowIso(),
    createdBy,
    color: opts.color || '#34B7F1',
  };

  await ensureDir(root);
  await ensureDir(root + '/files');
  await writeYaml(root + '/meta.yaml', meta);
  let messages = Array.isArray(opts.messages) ? opts.messages : [];
  // Create-once only; afterward messages.yaml is append-only (empty file, not `[]`).
  let msgPath = root + '/messages.yaml';
  if (!(await vfs.exists(msgPath))) {
    if (messages.length) await writeYaml(msgPath, messages);
    else await ensureAppendOnlyListFile(msgPath);
  }

  let views = [];
  for (let user of participants) {
    let view = groupView(user, app, chatId);
    views.push(view);
    await linkMessagesView(root, view);
    await writeGroupProfile(view, meta);
  }
  await chownChatFiles(chatFilePaths(root, views), createdBy);

  return { chatId, root, participants, app, kind: 'group', title, viewId: groupViewId(chatId) };
}

export async function getChat(chatId) {
  await vfs.ensureReady();
  let id = String(chatId || '');
  if (!id) return null;
  let root = CHATS_ROOT + '/' + id;
  if (!(await vfs.exists(root + '/meta.yaml'))) return null;
  let meta = (await readYaml(root + '/meta.yaml', null)) || {};
  return {
    chatId: meta.id || id,
    root,
    app: meta.app || 'relay',
    kind: meta.kind || (meta.title ? 'group' : 'dm'),
    title: meta.title || '',
    participants: meta.participants || [],
    created: meta.created || '',
    createdBy: meta.createdBy || '',
    color: meta.color || '',
    viewId: meta.kind === 'group' || meta.title ? groupViewId(meta.id || id) : null,
    meta,
  };
}

export async function listChatsFor(user, app = 'relay') {
  await vfs.ensureReady();
  let u = String(user || '');
  let all = await vfs.list();
  let prefix = CHATS_ROOT + '/';
  let out = [];
  for (let p of all) {
    if (!p.startsWith(prefix) || !p.endsWith('/meta.yaml')) continue;
    let meta = (await readYaml(p, null)) || {};
    if ((meta.app || 'relay') !== app) continue;
    let parts = meta.participants || [];
    if (!parts.includes(u)) continue;
    let chatId = meta.id || p.slice(prefix.length).split('/')[0];
    out.push({
      chatId,
      kind: meta.kind || (meta.title ? 'group' : 'dm'),
      title: meta.title || '',
      participants: parts,
      createdBy: meta.createdBy || '',
      viewId: meta.kind === 'group' || meta.title ? groupViewId(chatId) : null,
    });
  }
  return out;
}

export async function addToGroup(chatId, user, opts = {}) {
  await vfs.ensureReady();
  let id = String(chatId || '');
  let who = String(user || '');
  let meta = await readMeta(id);
  if (!meta) throw new Error('addToGroup: unknown chat ' + id);
  if ((meta.kind || (meta.title ? 'group' : 'dm')) !== 'group') {
    throw new Error('addToGroup: not a group');
  }
  if (!(await getUser(who))) throw new Error('addToGroup: unknown user ' + who);
  let parts = [...new Set([...(meta.participants || []).map(String), who])].sort();
  meta.participants = parts;
  let app = meta.app || opts.app || 'relay';
  let root = CHATS_ROOT + '/' + id;
  await writeMeta(id, meta);
  let view = groupView(who, app, id);
  await linkMessagesView(root, view);
  await refreshGroupProfiles(meta, app);
  let views = (meta.participants || []).map((u) => groupView(u, app, id));
  await chownChatFiles(chatFilePaths(root, views), meta.createdBy || who);
  return { chatId: id, participants: parts, viewId: groupViewId(id) };
}

export async function removeFromGroup(chatId, user, opts = {}) {
  await vfs.ensureReady();
  let id = String(chatId || '');
  let who = String(user || '');
  let meta = await readMeta(id);
  if (!meta) throw new Error('removeFromGroup: unknown chat ' + id);
  if ((meta.kind || (meta.title ? 'group' : 'dm')) !== 'group') {
    throw new Error('removeFromGroup: not a group');
  }
  let app = meta.app || opts.app || 'relay';
  let parts = (meta.participants || []).map(String).filter((u) => u !== who);
  if (parts.length < 2) throw new Error('removeFromGroup: group would be too small');
  meta.participants = parts.sort();
  await writeMeta(id, meta);
  let view = groupView(who, app, id);
  if (await vfs.exists(view)) {
    try {
      await vfs.withLock(view, (lease) => vfs.remove(view + '/', { lease }), { mode: 'w' });
    } catch {
      try {
        await vfs.withLock(view + '/messages.yaml', (lease) => vfs.remove(view + '/messages.yaml', { lease }), { mode: 'w' });
        await vfs.withLock(view + '/profile.yaml', (lease) => vfs.remove(view + '/profile.yaml', { lease }), { mode: 'w' });
      } catch {}
    }
  }
  await refreshGroupProfiles(meta, app);
  return { chatId: id, participants: meta.participants, viewId: groupViewId(id) };
}

export async function renameGroup(chatId, title) {
  await vfs.ensureReady();
  let id = String(chatId || '');
  let meta = await readMeta(id);
  if (!meta) throw new Error('renameGroup: unknown chat ' + id);
  if ((meta.kind || (meta.title ? 'group' : 'dm')) !== 'group') {
    throw new Error('renameGroup: not a group');
  }
  meta.title = String(title || '').trim() || meta.title || 'Group';
  let app = meta.app || 'relay';
  await writeMeta(id, meta);
  await refreshGroupProfiles(meta, app);
  return { chatId: id, title: meta.title, viewId: groupViewId(id) };
}
