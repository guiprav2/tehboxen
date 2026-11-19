/**
 * Shared plumbing for the Tehboxen messaging apps (Relay, BoxMail).
 *
 * Every app keeps its data as plain dirs + YAML files under ~/.<app_name>/
 * and reacts to VFS change events, so anything that writes there (the apps
 * themselves, Terminal, kitty, scripts) shows up live, bumps the unread badge
 * and pushes a desktop notification.
 */
import { PLAYER, PLAYER_HOME } from './session.js';
import YAML from 'https://cdn.jsdelivr.net/npm/yaml@2.6.1/+esm';
import * as vfs from './vfs.js';
import { imageExt, videoExt } from './vfs.js';

export let HOME = PLAYER_HOME;

/* ---------------- YAML files ---------------- */

async function yamlReadWithLease(path, fallback, lease) {
  let text = await vfs.read(path, { lease });
  if (text == null || !String(text).trim()) return fallback;
  try {
    let data = YAML.parse(String(text));
    return data ?? fallback;
  } catch (err) {
    console.warn('YAML parse error in /' + path, err);
    throw new Error('Invalid YAML in /' + path + ': ' + (err?.message || err));
  }
}

/**
 * Read YAML. Pass `{ lease }` when already inside withLock; otherwise takes a
 * short shared lock for this read only. For read→modify→write use updateYaml.
 */
export async function readYaml(path, fallback = null, opts = {}) {
  if (opts.lease) return yamlReadWithLease(path, fallback, opts.lease);
  return vfs.withLock(
    path,
    (lease) => yamlReadWithLease(path, fallback, lease),
    { mode: 'r', actor: opts.actor, timeoutMs: opts.timeoutMs },
  );
}

/**
 * Replace YAML file contents. Pass `{ lease }` inside withLock; otherwise takes
 * a short exclusive lock for this write only (full replace — not RMW-safe alone).
 */
export async function writeYaml(path, data, opts = {}) {
  let body = YAML.stringify(data, { lineWidth: 0 });
  if (opts.lease) {
    await vfs.write(path, body, { lease: opts.lease, ...(opts.meta || {}) });
    return;
  }
  await vfs.withLock(
    path,
    (lease) => vfs.write(path, body, { lease, ...(opts.meta || {}) }),
    { mode: 'w', actor: opts.actor, timeoutMs: opts.timeoutMs },
  );
}

/** Exclusive RMW helper: lock → read → fn → write → unlock. */
export async function updateYaml(path, fn, opts = {}) {
  return vfs.withLock(
    path,
    async (lease) => {
      let cur = await yamlReadWithLease(path, opts.fallback ?? null, lease);
      let next = await fn(cur, lease);
      if (next !== undefined) {
        await vfs.write(path, YAML.stringify(next, { lineWidth: 0 }), {
          lease,
          ...(opts.meta || {}),
        });
      }
      return next;
    },
    { mode: 'w', actor: opts.actor, timeoutMs: opts.timeoutMs },
  );
}

/**
 * Create-once an append-only YAML list file as empty text.
 * Never write `[]` — that breaks the next `appendYamlItem` (`[]\n- item:`).
 */
export async function ensureAppendOnlyListFile(path, opts = {}) {
  if (await vfs.exists(path)) return false;
  let run = async (lease) => {
    await vfs.write(path, '', { lease, ...(opts.meta || {}) });
  };
  if (opts.lease) {
    await run(opts.lease);
    return true;
  }
  await vfs.withLock(path, run, {
    mode: 'w',
    actor: opts.actor,
    timeoutMs: opts.timeoutMs,
  });
  return true;
}

/**
 * Append one YAML list item (e.g. a chat message) without rewriting the file.
 * messages.yaml is append-only: never patch or rewrite it after creation.
 * Heals a mistaken create-once `[]` body so append stays valid YAML.
 */
export async function appendYamlItem(path, item, opts = {}) {
  let chunk = YAML.stringify([item], { lineWidth: 0 });
  let run = async (lease) => {
    let cur = await vfs.read(path, { lease });
    let t = cur == null ? '' : String(cur);
    let trimmed = t.trim();
    if (!trimmed || trimmed === '[]') {
      // Empty or broken create-once — write the first item as the whole file.
      await vfs.write(path, chunk, { lease });
    } else {
      await vfs.append(path, chunk, { lease });
    }
    if (String(path).endsWith('/messages.yaml')) {
      try {
        let st = await vfs.getStat(path);
        if (st && (st.mode & 0o066) !== 0o066) {
          await vfs.setStat(path, { ...st, mode: (st.mode | 0o666) });
        }
      } catch {}
    }
  };
  if (opts.lease) return run(opts.lease);
  return vfs.withLock(path, run, {
    mode: 'w',
    actor: opts.actor,
    timeoutMs: opts.timeoutMs,
  });
}

/** Parse messages.yaml as a YAML sequence (legacy full dumps + append-only). */
export async function readEventList(path) {
  let data = await readYaml(path, []);
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  return [];
}

/** @deprecated use readEventList */
export async function readMessageList(path) {
  return readEventList(path);
}

export function isReceiptEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (String(ev.type || '') === 'receipt') return true;
  // Shape discriminate: receipt has msg+by and no chat text/from
  return ev.msg != null && ev.by != null && ev.from == null && ev.text == null;
}

export function isMessageEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  if (isReceiptEvent(ev)) return false;
  return ev.from != null || ev.text != null || ev.files != null;
}

/** Split an append-only event stream into chat messages + receipt index. */
export function foldMessageEvents(events) {
  let messages = [];
  /** @type {Map<string, Set<string>>} msgId -> set of usernames who read */
  let readBy = new Map();
  for (let ev of events || []) {
    if (isReceiptEvent(ev)) {
      let mid = String(ev.msg || '');
      let by = String(ev.by || '');
      if (!mid || !by) continue;
      let set = readBy.get(mid);
      if (!set) {
        set = new Set();
        readBy.set(mid, set);
      }
      set.add(by);
      continue;
    }
    if (isMessageEvent(ev)) messages.push(ev);
  }
  return { messages, readBy };
}

/**
 * Append a chat message event to messages.yaml (create parent dir if needed).
 * Blocks when the sender NPC's current FSM state has phone_attention: false
 * (e.g. sleeping) — players (no NPC profile) and root are always allowed.
 */
export async function appendMessage(path, msg) {
  let event = { ...msg };
  if (event.type == null) event.type = 'message';
  let from = String(event.from || '');
  if (from && from !== PLAYER && from !== 'root' && from !== 'me') {
    try {
      let { loadProfile, phoneAttention, stateDefFor } = await import('./npc-life.js');
      let prof = await loadProfile(from);
      if (prof && !phoneAttention(prof)) {
        let fsm = prof.runtime?.state || 'unknown';
        let def = stateDefFor(prof, fsm);
        throw Object.assign(
          new Error(
            'Cannot send Relay as ' +
              from +
              ': phone_attention is false in state "' +
              fsm +
              '"' +
              (def?.description ? ' (' + def.description + ')' : '') +
              '. Wait until they wake / leave this state.',
          ),
          { code: 'EPHONE_OFF', user: from, state: fsm },
        );
      }
    } catch (err) {
      if (err?.code === 'EPHONE_OFF') throw err;
      // Profile load failures: do not silently allow NPC spam — rethrow others.
      if (err?.message && /Cannot send Relay/.test(err.message)) throw err;
      console.warn('appendMessage phone_attention check', from, err);
    }
  }
  await ensureDir(path.replace(/\/[^/]+$/, ''));
  await appendYamlItem(path, event);

  // Declarative FSM edges on the message *recipient*.
  // Chat paths are home/<owner>/.<app>/<peer>/messages.yaml — sends usually go through
  // the sender's view, so the recipient is <peer> (the contact folder), not <owner>.
  // Groups (g-*) skip auto edges for now.
  if (event.type === 'message' && event.text) {
    try {
      let parts = String(path || '').split('/');
      // home / <owner> / .<app> / <peer> / messages.yaml
      if (parts[0] === 'home' && parts[1] && String(parts[2] || '').startsWith('.') && parts[3]) {
        let owner = parts[1];
        let peer = parts[3];
        let sender = String(event.from || '');
        let recipient = null;
        if (String(peer).startsWith('g-')) {
          recipient = null;
        } else if (sender && sender === owner) {
          recipient = peer; // normal send from own view
        } else if (sender && sender === peer) {
          recipient = owner; // append via the other hardlinked view
        } else if (sender) {
          // Fallback: whoever isn't the sender
          recipient = sender === owner ? peer : owner;
        }
        if (recipient && sender && sender !== recipient) {
          let { considerMessageTransition } = await import('./npc-life.js');
          await considerMessageTransition(recipient, {
            from: sender,
            text: event.text,
            app: String(parts[2] || '').slice(1),
            path,
          });
        }
      }
    } catch (err) {
      console.warn('appendMessage considerMessageTransition', path, err);
    }
  }
}

/**
 * Append a read-receipt event into the same messages.yaml stream.
 * Never rewrite or patch prior items.
 */
export async function appendReceipt(messagesPath, receipt) {
  await ensureDir(messagesPath.replace(/\/[^/]+$/, ''));
  await appendYamlItem(messagesPath, {
    type: 'receipt',
    msg: receipt.msg,
    by: receipt.by,
    at: receipt.at || nowIso(),
  });
}

/* ---------------- dirs ---------------- */

/** Names of the direct child directories of dir. */
export function childDirs(allPaths, dir) {
  let prefix = dir + '/';
  let out = new Set();
  for (let p of allPaths) {
    if (!p.startsWith(prefix)) continue;
    let rest = p.slice(prefix.length);
    let i = rest.indexOf('/');
    if (i > 0) out.add(rest.slice(0, i));
  }
  return [...out].sort();
}

/** Names of the direct child files of dir. */
export function childFiles(allPaths, dir) {
  let prefix = dir + '/';
  return allPaths
    .filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
    .map((p) => p.slice(prefix.length))
    .filter((n) => n !== '.keep')
    .sort();
}

export async function ensureDir(dir, opts = {}) {
  if (await vfs.isDirectory(dir)) return;
  let keep = dir + '/.keep';
  let meta = { ...(opts.meta || {}) };
  if (opts.uid != null) meta.uid = opts.uid;
  if (opts.gid != null) meta.gid = opts.gid;
  let run = (lease) => vfs.write(keep, '', { lease, ...meta });
  if (opts.lease) return run(opts.lease);
  return vfs.withLock(keep, run, {
    mode: 'w',
    actor: opts.actor,
    timeoutMs: opts.timeoutMs,
  });
}

/* ---------------- file URLs ---------------- */

/** path → { mtime, url } */
let urlCache = new Map();

/** Drop cached object URLs (e.g. after bulk avatar replace). */
export function clearFileUrlCache() {
  for (let hit of urlCache.values()) {
    try {
      URL.revokeObjectURL(hit.url);
    } catch {}
  }
  urlCache.clear();
}

/** Object URL for a VFS file, cached until the file changes. */
export async function fileUrl(path, opts = {}) {
  let st = await vfs.getStat(path);
  let mtime = st?.mtime || 0;
  let hit = urlCache.get(path);
  if (hit && hit.mtime === mtime) return hit.url;
  let load = async (lease) => vfs.readBlob(path, { lease });
  let blob = opts.lease
    ? await load(opts.lease)
    : await vfs.withLock(path, load, { mode: 'r', actor: opts.actor });
  if (!blob) return '';
  if (hit) {
    try {
      URL.revokeObjectURL(hit.url);
    } catch {}
  }
  // Blobs stored from strings or octet-stream lose their type; fix it so <img>/<video> work.
  let type = mimeFor(path) || blob.type;
  if (type && blob.type !== type) blob = new Blob([blob], { type });
  let url = URL.createObjectURL(blob);
  urlCache.set(path, { mtime, url });
  return url;
}

function mimeFor(path) {
  let ext = String(path).split('.').pop().toLowerCase();
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      avif: 'image/avif',
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      webm: 'video/webm',
      mov: 'video/quicktime',
      ogv: 'video/ogg',
    }[ext] || ''
  );
}

/** Resolve a message's file names (relative to filesDir) to displayable records. */
export async function resolveFiles(names, filesDir) {
  let out = [];
  for (let raw of [].concat(names || [])) {
    let name = typeof raw === 'string' ? raw : raw?.name || raw?.path;
    if (!name) continue;
    let path = String(name).startsWith('/')
      ? String(name).replace(/^\/+/, '')
      : filesDir + '/' + String(name).replace(/^\.?\/+/, '');
    let isImage = imageExt(path);
    let isVideo = videoExt(path);
    let url = '';
    if (isImage || isVideo) {
      try {
        url = (await vfs.exists(path)) ? await fileUrl(path) : '';
      } catch {}
    }
    out.push({ name: path.split('/').pop(), path, isImage, isVideo, url });
  }
  return out;
}

/* ---------------- time ---------------- */

export function toTs(value) {
  if (value == null || value === '') return 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  let t = Date.parse(String(value));
  return Number.isNaN(t) ? 0 : t;
}

/** Short label: time today, weekday this week, else date. Non-dates are shown as-is. */
export function timeLabel(value) {
  let ts = toTs(value);
  if (!ts) return value == null ? '' : String(value);
  let dt = new Date(ts);
  let now = new Date();
  if (dt.toDateString() === now.toDateString()) {
    return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  let days = (now - dt) / 86400000;
  if (days < 6) return dt.toLocaleDateString([], { weekday: 'short' });
  return dt.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix = 'm') {
  let rnd;
  try {
    rnd = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
  } catch {
    rnd = Math.random().toString(36).slice(2, 12);
  }
  return prefix + Date.now().toString(36) + rnd;
}

export function uuid() {
  try {
    return crypto.randomUUID();
  } catch {
    let h = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
    return `${h()}${h()}-${h()}-4${h().slice(1)}-a${h().slice(1)}-${h()}${h()}${h()}`;
  }
}

/** Stable identity for a message that may have no id. */
export function msgKey(m) {
  if (m?.id != null && m.id !== '') return 'id:' + m.id;
  let files = [].concat(m?.files || []).join(',');
  return ['k', m?.from, m?.time, m?.text, files].join('|');
}

/**
 * Host-project URL for seeding only (`media/...` on disk).
 * In-app display must use VFS `fileUrl` / blob URLs — never this.
 */
export function hostProjectUrl(mediaPath) {
  let clean = String(mediaPath || '')
    .replace(/^\.\.\//, '')
    .replace(/^\//, '');
  if (
    typeof rootPrefix === 'string' &&
    /^\/(files|preview)\b/.test(rootPrefix)
  ) {
    return rootPrefix.replace(/\/$/, '') + '/' + clean;
  }
  return '../' + clean;
}

/** Fetch a host project file (media/...) into the VFS once. */
export async function seedMedia(mediaPath, dest, opts = {}) {
  try {
    let res = await fetch(hostProjectUrl(mediaPath));
    if (!res.ok) return false;
    let blob = await res.blob();
    let run = (lease) => vfs.writeBlob(dest, blob, { lease });
    if (opts.lease) await run(opts.lease);
    else await vfs.withLock(dest, run, { mode: 'w', actor: opts.actor });
    return true;
  } catch (err) {
    console.warn('seedMedia', mediaPath, err);
    return false;
  }
}

export let PICTURES = HOME + '/Pictures';

/**
 * Copy OS chrome assets from host media/ into the VFS on first boot.
 * Wallpapers → ~/Pictures/; app-specific files (e.g. God's Hand avatar) are seeded
 * by their app. Runtime UI always reads the VFS copies.
 */
export async function seedOsMedia() {
  await ensureDir(PICTURES);
  let wallpapers = [
    'circuit-grid.jpg',
    'glyph-rain.jpg',
    'hexdump.jpg',
  ];
  for (let name of wallpapers) {
    let dest = PICTURES + '/' + name;
    if (!(await vfs.exists(dest))) {
      await seedMedia('media/wallpapers/' + name, dest);
    }
  }
}

/** Scroll an app's open chat to its newest message after the next render. */
export function scrollChatToEnd(appId) {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      for (let el of document.querySelectorAll(`[data-chat-scroll="${appId}"]`)) {
        el.scrollTop = el.scrollHeight;
      }
    }),
  );
}

/* ---------------- per-contact chat store ---------------- */

/**
 * Relay-style store: <root>/<contactId>/{profile.yaml, messages.yaml, files/}
 * messages.yaml is an APPEND-ONLY YAML event stream (message + receipt items).
 * Never rewrite it after create — use appendMessage / appendReceipt / vfs.append.
 * plus <root>/profile.yaml for the user's own profile.
 *
 * Preferred event schema (contact-agnostic):
 *   type: message | receipt
 *   message: { id, from: <username>, time, text?, files? }
 *   receipt: { msg, by, at }  # append-only; never mutate prior message items
 * Legacy `from: me|them` + `read:` is still accepted.
 */
export class ChatStore {
  constructor({ root, appId, onChange, selfUser = PLAYER }) {
    this.root = root;
    this.appId = appId;
    this.onChange = onChange;
    this.selfUser = selfUser;
    this.me = {};
    /** contactId → { profile, messages, error } */
    this.chats = {};
    this._known = {};
    this._timers = {};
    this._unsub = null;
    this._writing = 0;
  }

  dir(id) {
    return this.root + '/' + id;
  }

  async loadAll() {
    let all = await vfs.list();
    this.me = (await readYaml(this.root + '/profile.yaml', {}).catch(() => ({}))) || {};
    let ids = childDirs(all, this.root);
    this.chats = {};
    for (let id of ids) await this._loadOne(id, false);
  }

  watch() {
    if (this._unsub) return;
    this._unsub = vfs.onChange((ev) => {
      let p = String(ev?.path ?? '');
      if (ev?.type === 'clear') return this._schedule('*');
      // Peer home profile changes (FSM / phone_attention) refresh DM presence.
      let m = /^home\/([^/]+)\/profile\.yaml$/.exec(p);
      if (m && m[1] !== this.selfUser) {
        for (let [cid, chat] of Object.entries(this.chats)) {
          if (chat?.profile?.kind === 'group') continue;
          if (String(chat?.profile?.user || cid) === m[1]) this._schedule(cid);
        }
        return;
      }
      if (!p.startsWith(this.root + '/') && p !== this.root) return;
      let rest = p.slice(this.root.length + 1);
      if (!rest || rest === 'profile.yaml') return this._schedule('@me');
      let id = rest.split('/')[0];
      if (id === '.keep') return;
      this._schedule(id);
    });
  }

  _schedule(id) {
    clearTimeout(this._timers[id]);
    // Debounce: shells and editors often write a file several times in a row.
    this._timers[id] = setTimeout(() => this._reload(id), 150);
  }

  async _reload(id) {
    try {
      if (id === '*') {
        await this.loadAll();
      } else if (id === '@me') {
        this.me = (await readYaml(this.root + '/profile.yaml', {}).catch(() => ({}))) || {};
      } else if (!(await vfs.isDirectory(this.dir(id)))) {
        delete this.chats[id];
        delete this._known[id];
      } else {
        await this._loadOne(id, true);
      }
    } catch (err) {
      console.warn(this.appId + ' reload', id, err);
    }
    this.onChange?.({ id });
  }

  async _loadOne(id, announce) {
    let dir = this.dir(id);
    let chat = { id, profile: {}, messages: [], error: '' };
    try {
      chat.profile = (await readYaml(dir + '/profile.yaml', {})) || {};
    } catch (err) {
      chat.error = err.message;
    }
    let events = [];
    try {
      events = await readEventList(dir + '/messages.yaml');
    } catch (err) {
      chat.error = err.message;
      // Keep showing the last good messages while the file is mid-edit.
      events = this.chats[id]?.events || this.chats[id]?.raw || [];
    }
    if (!Array.isArray(events)) events = [];
    let folded = foldMessageEvents(events);
    chat.events = events;
    chat.raw = folded.messages; // legacy alias: message events only
    chat.readBy = folded.readBy;
    let isGroup = String(chat.profile?.kind || '') === 'group';
    chat.isGroup = isGroup;
    let peerUser = String(chat.profile?.user || id);
    let participants = Array.isArray(chat.profile?.participants)
      ? chat.profile.participants.map(String)
      : [];
    let self = this.selfUser;
    let messages = [];
    for (let m of folded.messages) {
      if (!m || typeof m !== 'object') continue;
      let fromRaw = String(m.from ?? '');
      let fromLower = fromRaw.toLowerCase();
      let mine =
        fromLower === 'me' || fromLower === String(self).toLowerCase();
      let mid = String(m.id || '');
      let readKey = self + '_read';
      let key = msgKey(m);
      let receiptRead =
        (mid && folded.readBy.get(mid)?.has(self)) ||
        (key && folded.readBy.get(key)?.has(self));
      // Legacy inline flags still count until fully migrated.
      // Seed/legacy rows with no id cannot be receipted — never keep them as unread
      // (otherwise badges stick forever after open).
      let unread =
        !mine &&
        !!mid &&
        !receiptRead &&
        m[readKey] !== true &&
        m.read !== true;
      let fromUser =
        fromLower === 'me'
          ? self
          : fromLower === 'them'
            ? peerUser
            : fromRaw || peerUser;
      let senderLabel = mine
        ? 'You'
        : String(fromUser || 'them').replace(/^./, (c) => c.toUpperCase());
      let files = await resolveFiles(m.files ?? m.file ?? m.image, dir + '/files');
      messages.push({
        key: msgKey(m),
        id: m.id,
        mine,
        from: mine ? 'me' : 'them',
        fromUser,
        senderLabel,
        text: m.text == null ? '' : String(m.text),
        ts: toTs(m.time),
        time: timeLabel(m.time),
        files,
        images: files.filter((f) => f.isImage && f.url),
        videos: files.filter((f) => f.isVideo && f.url),
        others: files.filter((f) => !(f.url && (f.isImage || f.isVideo))),
        unread,
      });
    }
    chat.messages = messages;
    chat.participants = participants;
    // Prefer contact-dir hardlink (avatar.jpg); fall back to profile.avatar path.
    let avRel = chat.profile?.avatar ? String(chat.profile.avatar) : 'avatar.jpg';
    let avPath = avRel.startsWith('/') || avRel.startsWith('home/')
      ? avRel.replace(/^\//, '')
      : dir + '/' + avRel;
    if (await vfs.exists(avPath)) {
      chat.avatarUrl = await fileUrl(avPath);
    } else if (await vfs.exists(dir + '/avatar.jpg')) {
      chat.avatarUrl = await fileUrl(dir + '/avatar.jpg');
    } else {
      chat.avatarUrl = '';
    }

    // DM presence: online/offline from peer FSM phone_attention (sleeping → offline).
    chat.presence = 'offline';
    if (!isGroup && peerUser && peerUser !== this.selfUser) {
      try {
        let { loadProfile, waPresence } = await import('./npc-life.js');
        let peerProf = await loadProfile(peerUser);
        chat.presence = peerProf ? waPresence(peerProf) : 'offline';
      } catch {
        chat.presence = 'offline';
      }
    }
    let prev = this._known[id];
    let fresh = [];
    if (announce) {
      for (let m of messages) if (m.unread && !(prev && prev.has(m.key))) fresh.push(m);
    }
    this._known[id] = new Set(messages.map((m) => m.key));
    this.chats[id] = chat;
    chat.fresh = fresh;
    return chat;
  }

  unreadCount(id) {
    return (this.chats[id]?.messages || []).filter((m) => m.unread).length;
  }

  totalUnread() {
    return Object.keys(this.chats).reduce((n, id) => n + this.unreadCount(id), 0);
  }

  /**
   * @deprecated Full rewrites of messages.yaml are forbidden.
   * Kept only for one-shot seeds that create an empty/new file.
   */
  async _writeMessages(id, raw) {
    await ensureDir(this.dir(id));
    await writeYaml(this.dir(id) + '/messages.yaml', raw);
  }

  /** Mark incoming messages read by appending receipt events (never rewrite). */
  async markRead(id) {
    let chat = this.chats[id];
    if (!chat || !this.unreadCount(id)) return;
    let self = this.selfUser;
    let path = this.dir(id) + '/messages.yaml';
    let unread = (chat.messages || []).filter((m) => m.unread);
    for (let m of unread) {
      let rid = m.id ? String(m.id) : m.key || '';
      if (rid) {
        await appendReceipt(path, { msg: rid, by: self });
        let set = chat.readBy?.get(rid);
        if (!set) {
          set = new Set();
          (chat.readBy ||= new Map()).set(rid, set);
        }
        set.add(self);
      }
      m.unread = false;
    }
  }

  /**
   * Hardlink a chat attachment into the peer's home view (and optional canon)
   * so hardlinked messages.yaml filenames resolve for both participants.
   */
  async _publishChatFile(contactId, localPath, name) {
    let mirrors = [];
    // Peer DM view: home/<peer>/.<app>/<self>/files/<name>
    let peer = String(contactId || '');
    let self = this.selfUser;
    let app = this.appName || 'relay';
    if (peer && self && !String(peer).startsWith('g-')) {
      mirrors.push('home/' + peer + '/.' + app + '/' + self + '/files/' + name);
    }
    for (let dest of mirrors) {
      try {
        let dir = dest.slice(0, dest.lastIndexOf('/'));
        let keep = dir + '/.keep';
        if (!(await vfs.isDirectory(dir))) {
          await vfs.withLock(keep, (lease) => vfs.write(keep, '', { lease }), { mode: 'w' });
        }
        await vfs.withLocks(
          [localPath, dest],
          async (leases) => {
            if (await vfs.exists(dest)) {
              await vfs.remove(dest, { lease: leases[dest] });
            }
            try {
              await vfs.link(localPath, dest, {
                srcLease: leases[localPath],
                lease: leases[dest],
              });
            } catch {
              await vfs.copy(localPath, dest, {
                srcLease: leases[localPath],
                lease: leases[dest],
              });
            }
          },
          { mode: 'w' },
        );
      } catch (err) {
        console.warn('publishChatFile', dest, err);
      }
    }
  }

  /** Append an outgoing message; files are VFS paths copied into <contact>/files/. */
  async send(id, text, filePaths = []) {
    let chat = this.chats[id] || (await this._loadOne(id, false));
    let names = [];
    for (let src of filePaths) {
      let name = src.split('/').pop();
      let dest = this.dir(id) + '/files/' + name;
      if (await vfs.exists(dest)) {
        let dot = name.lastIndexOf('.');
        name = (dot > 0 ? name.slice(0, dot) : name) + '-' + Date.now().toString(36) + (dot > 0 ? name.slice(dot) : '');
        dest = this.dir(id) + '/files/' + name;
      }
      await vfs.withLocks(
        [src, dest],
        (leases) =>
          vfs.copy(src, dest, { srcLease: leases[src], lease: leases[dest] }),
        { mode: 'w' },
      );
      await this._publishChatFile(id, dest, name);
      names.push(name);
    }
    let self = this.selfUser;
    let msg = {
      type: 'message',
      id: newId(),
      from: self,
      time: nowIso(),
      text,
    };
    if (names.length) msg.files = names;
    let path = this.dir(id) + '/messages.yaml';
    await appendMessage(path, msg);
    // Sender has implicitly read their own message — receipt event keeps the log consistent.
    await appendReceipt(path, { msg: msg.id, by: self });
    chat.raw = [...(chat.raw || []), msg];
    chat.events = [...(chat.events || []), msg, { type: 'receipt', msg: msg.id, by: self }];
    let set = new Set([self]);
    (chat.readBy ||= new Map()).set(String(msg.id), set);
    // Our own message is known, so it never counts as "new".
    (this._known[id] ||= new Set()).add(msgKey(msg));
    // Optimistic UI row (watch will reload from disk shortly).
    chat.messages = [
      ...(chat.messages || []),
      {
        key: msgKey(msg),
        id: msg.id,
        mine: true,
        from: 'me',
        fromUser: self,
        senderLabel: 'You',
        text: msg.text == null ? '' : String(msg.text),
        ts: toTs(msg.time),
        time: timeLabel(msg.time),
        files: [],
        images: [],
        videos: [],
        others: [],
        unread: false,
      },
    ];
    this.onChange?.({ id });
  }
}
