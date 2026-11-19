import { PLAYER, PLAYER_HOME } from '../other/session.js';
import * as vfs from '../other/vfs.js';
import { showFilePicker } from '../other/file-picker.js';
import {
  HOME,
  readYaml,
  writeYaml,
  ensureDir,
  childDirs,
  childFiles,
  resolveFiles,
  timeLabel,
  toTs,
  nowIso,
  newId,
  seedMedia,
} from '../other/messaging.js';

/**
 * BoxMail, driven by ~/.boxmail/:
 *
 *   profile.yaml                         # your name and address
 *   inbox/<id>/message.yaml              # one dir per mail
 *   inbox/<id>/files/                    # its attachments
 *   drafts/<id>/…  sent/<id>/…           # same layout
 *
 * message.yaml: from, to, subject, date, body, attachments: [names in files/],
 * read: true (inbox mails without it are unread). A bare inbox/<id>.yaml file
 * (no attachments) works too.
 */
let ROOT = HOME + '/.boxmail';
let FOLDERS = ['inbox', 'drafts', 'sent'];

export default class Mail {
  state = {
    ready: false,
    root: ROOT,
    me: {},
    folder: 'inbox',
    /** folder → mail list (newest first) */
    folders: { inbox: [], drafts: [], sent: [] },
    items: [],
    /** key of the open mail: '<folder>/<id>' */
    selected: null,
    current: null,
    /** Compose form, or null: { id, to, subject, body, attachments: [paths] } */
    composing: null,
    status: '',
    error: '',
  };

  _known = null;
  _timer = null;
  _unsub = null;

  actions = {
    init: async () => {
      if (this.state.ready) return;
      await vfs.ensureReady();
      if (!(await vfs.exists(ROOT))) await this._seed();
      await this._loadAll(false);
      this._watch();
      this.state.ready = true;
    },

    setFolder: (folder) => {
      this.state.folder = FOLDERS.includes(folder) ? folder : 'inbox';
      this.state.selected = null;
      this.state.composing = null;
      this._sync();
    },

    select: async (key) => {
      this.state.composing = null;
      this.state.selected = key || null;
      this._sync();
      let mail = this.state.current;
      if (!mail) return;
      if (mail.folder === 'drafts') {
        this.actions.editDraft(mail);
        return;
      }
      if (mail.unread) await this._markRead(mail);
    },

    back: () => {
      this.state.composing = null;
      this.state.selected = null;
      this._sync();
    },

    openTarget: async (key) => {
      this.state.folder = String(key).split('/')[0] || 'inbox';
      await this.actions.select(key);
    },

    compose: (init = {}) => {
      this.state.selected = null;
      this.state.composing = { id: null, to: '', subject: '', body: '', attachments: [], ...init };
      this.state.status = '';
      this._sync();
    },

    reply: () => {
      let m = this.state.current;
      if (!m) return;
      let quoted = String(m.body || '')
        .split('\n')
        .map((l) => '> ' + l)
        .join('\n');
      this.actions.compose({
        to: m.fromAddress || m.from,
        subject: /^re:/i.test(m.subject) ? m.subject : 'Re: ' + m.subject,
        body: '\n\n' + (m.from || '') + ' wrote:\n' + quoted,
      });
    },

    editDraft: (m) => {
      this.state.composing = {
        id: m.id,
        to: m.to || '',
        subject: m.subject || '',
        body: m.body || '',
        attachments: m.files.map((f) => f.path),
      };
      this._sync();
    },

    attach: async () => {
      if (!this.state.composing) return;
      let path = await showFilePicker({ title: 'Attach a file', startPath: HOME, mode: 'file' });
      if (path) this.state.composing.attachments = [...this.state.composing.attachments, path];
    },

    removeAttachment: (path) => {
      if (!this.state.composing) return;
      this.state.composing.attachments = this.state.composing.attachments.filter((p) => p !== path);
    },

    saveDraft: async () => {
      let c = this.state.composing;
      if (!c) return;
      c.id ||= newId('d');
      await this._writeMail('drafts', c.id, c);
      this.state.status = 'Draft saved';
    },

    send: async () => {
      let c = this.state.composing;
      if (!c) return;
      if (!String(c.to || '').trim()) {
        this.state.error = 'Who is it for? Fill in To.';
        return;
      }
      this.state.error = '';
      let id = newId('s');
      await this._writeMail('sent', id, c);
      if (c.id) {
        let draft = ROOT + '/drafts/' + c.id;
        await vfs.withLock(draft, (lease) => vfs.remove(draft + '/', { lease }), {
          mode: 'w',
          actor: 'ui:mail',
        });
      }
      this.state.composing = null;
      this.state.folder = 'sent';
      this.state.selected = 'sent/' + id;
      this.state.status = 'Sent 💌';
    },

    discard: async () => {
      let c = this.state.composing;
      if (c?.id) {
        let draft = ROOT + '/drafts/' + c.id;
        await vfs.withLock(draft, (lease) => vfs.remove(draft + '/', { lease }), {
          mode: 'w',
          actor: 'ui:mail',
        });
      }
      this.state.composing = null;
      this._sync();
    },

    remove: async () => {
      let m = this.state.current;
      if (!m) return;
      let target = m.flat ? m.dir + '.yaml' : m.dir;
      let removePath = m.flat ? target : target + '/';
      await vfs.withLock(target, (lease) => vfs.remove(removePath, { lease }), {
        mode: 'w',
        actor: 'ui:mail',
      });
      this.state.selected = null;
    },

    openFile: (path) => post('vfs.openPath', path),
  };

  /** Write <folder>/<id>/message.yaml, copying attachments into files/. */
  async _writeMail(folder, id, c) {
    let dir = ROOT + '/' + folder + '/' + id;
    let names = [];
    for (let src of c.attachments || []) {
      let name = src.split('/').pop();
      let dest = dir + '/files/' + name;
      if (src !== dest) {
        await vfs.withLocks(
          [src, dest],
          (leases) =>
            vfs.copy(src, dest, { srcLease: leases[src], lease: leases[dest] }),
          { mode: 'w', actor: 'ui:mail' },
        );
      }
      names.push(name);
    }
    let me = this.state.me || {};
    let mail = {
      from: me.address ? `${me.name || ''} <${me.address}>`.trim() : me.name || 'me',
      to: String(c.to || '').trim(),
      subject: String(c.subject || '').trim() || '(no subject)',
      date: nowIso(),
      body: String(c.body || ''),
    };
    if (names.length) mail.attachments = names;
    await ensureDir(dir);
    await writeYaml(dir + '/message.yaml', mail);
  }

  async _markRead(mail) {
    let path = mail.flat ? mail.dir + '.yaml' : mail.dir + '/message.yaml';
    try {
      let raw = (await readYaml(path, {})) || {};
      raw.read = true;
      mail.unread = false;
      this._known?.add(mail.key);
      await writeYaml(path, raw);
    } catch (err) {
      this.state.error = err.message;
    }
  }

  _watch() {
    if (this._unsub) return;
    this._unsub = vfs.onChange((ev) => {
      let p = String(ev?.path ?? '');
      if (ev?.type !== 'clear' && !p.startsWith(ROOT + '/')) return;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._loadAll(true), 150);
    });
  }

  async _loadAll(announce) {
    let all = await vfs.list();
    try {
      this.state.me = (await readYaml(ROOT + '/profile.yaml', {})) || {};
    } catch {}
    let folders = {};
    for (let folder of FOLDERS) {
      let base = ROOT + '/' + folder;
      let list = [];
      for (let id of childDirs(all, base)) {
        if (!all.includes(base + '/' + id + '/message.yaml')) continue;
        list.push(await this._loadMail(folder, id, base + '/' + id, false));
      }
      for (let name of childFiles(all, base)) {
        if (!/\.ya?ml$/i.test(name)) continue;
        let id = name.replace(/\.ya?ml$/i, '');
        list.push(await this._loadMail(folder, id, base + '/' + id, true));
      }
      folders[folder] = list.sort((a, b) => b.ts - a.ts);
    }
    this.state.folders = folders;

    let inbox = folders.inbox;
    if (announce && this._known) {
      let fresh = inbox.filter((m) => m.unread && !this._known.has(m.key));
      let visible =
        rawctrls.desktop.actions.isWinActive('mail') && this.state.folder === 'inbox';
      for (let m of fresh) {
        if (visible && this.state.selected === m.key) continue;
        rawctrls.desktop.actions.notify({
          appId: 'mail',
          title: m.from || 'New mail',
          text: m.subject + (m.preview ? ' — ' + m.preview : ''),
          image: m.files.find((f) => f.isImage && f.url)?.url || '',
          target: m.key,
        });
      }
    }
    this._known = new Set(inbox.map((m) => m.key));
    this._sync();
    d.update();
  }

  async _loadMail(folder, id, dir, flat) {
    let mail = { key: folder + '/' + id, id, folder, dir, flat, files: [], ts: 0 };
    let raw = {};
    try {
      raw = (await readYaml(flat ? dir + '.yaml' : dir + '/message.yaml', {})) || {};
    } catch (err) {
      mail.error = err.message;
    }
    let from = raw.from == null ? '' : String(raw.from);
    let body = raw.body == null ? '' : String(raw.body);
    Object.assign(mail, {
      from: from.replace(/\s*<[^>]*>\s*$/, '') || from,
      fromAddress: (from.match(/<([^>]+)>/) || [])[1] || from,
      to: raw.to == null ? '' : String(raw.to),
      subject: raw.subject == null ? '(no subject)' : String(raw.subject),
      body,
      preview: body.replace(/\s+/g, ' ').trim().slice(0, 90),
      ts: toTs(raw.date ?? raw.time),
      time: timeLabel(raw.date ?? raw.time),
      dateFull: toTs(raw.date ?? raw.time)
        ? new Date(toTs(raw.date ?? raw.time)).toLocaleString()
        : String(raw.date ?? ''),
      unread: folder === 'inbox' && raw.read !== true,
      starred: !!raw.starred,
    });
    if (!flat) mail.files = await resolveFiles(raw.attachments ?? raw.files, dir + '/files');
    mail.images = mail.files.filter((f) => f.isImage && f.url);
    return mail;
  }

  _sync() {
    let s = this.state;
    s.items = s.folders[s.folder] || [];
    s.current = s.selected ? s.items.find((m) => m.key === s.selected) || null : null;
    if (s.selected && !s.current) s.selected = null;
    rawctrls.desktop.actions.setUnread('mail', (s.folders.inbox || []).filter((m) => m.unread).length);
    rawctrls.desktop.actions.syncAppNotifications(
      'mail',
      (s.folders.inbox || [])
        .filter((m) => m.unread)
        .map((m) => ({
          key: m.key,
          title: m.from || 'New mail',
          text: m.subject + (m.preview ? ' — ' + m.preview : ''),
          image: m.images?.[0]?.url || '',
          target: m.key,
          ts: m.ts,
        })),
    );
  }

  /**
   * First-run OS seed only. World cast mail lives in VFS packs.
   * Seeds a welcome from God's Hand explaining world-building vs Danger Zone import.
   */
  async _gecos() {
    let u = await vfs.getUser(PLAYER).catch(() => null);
    return u?.gecos || PLAYER;
  }

  async _seed() {
    let ago = (h) => new Date(Date.now() - h * 3600000).toISOString();
    await writeYaml(ROOT + '/profile.yaml', { name: await this._gecos(), address: PLAYER + '@boxmail.net' });
    let inbox = [
      {
        from: "God's Hand <godshand@tehboxen.net>",
        subject: 'Welcome to Tehboxen — build or import a world',
        date: ago(1),
        body:
          'Hey ' + (await this._gecos()) + ',\n\n' +
          'Your box starts empty of story. Places, crew, targets and chats live in the VFS.\n\n' +
          'Two ways to get a world:\n' +
          '1) Message me on Relay (or reply here) and we will invent a crew, hideouts and vulnerable targets together before you play.\n' +
          '2) Open Danger Zone and Import a world pack you downloaded from the internet.\n\n' +
          'Factory reset wipes to this empty OS again; re-import a pack to restore a cast.\n\n' +
          "— God's Hand",
      },
    ];
    let i = 0;
    for (let m of inbox) {
      let dir = ROOT + '/inbox/' + 'm' + String(++i).padStart(3, '0');
      let { attach, ...mail } = m;
      for (let [name, src] of Object.entries(attach || {})) await seedMedia(src, dir + '/files/' + name);
      await ensureDir(dir);
      await writeYaml(dir + '/message.yaml', mail);
    }
    await ensureDir(ROOT + '/drafts');
    await ensureDir(ROOT + '/sent');
  }
}
