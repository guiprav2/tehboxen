import { PLAYER, PLAYER_HOME } from '../other/session.js';
import * as vfs from '../other/vfs.js';
import { listUsers } from '../other/vfs-auth.js';
import { createGroup } from '../other/chats.js';
import { showFilePicker } from '../other/file-picker.js';
import {
  ChatStore,
  HOME,
  scrollChatToEnd,
  writeYaml,
  readYaml,
  ensureDir,
} from '../other/messaging.js';

/**
 * Relay, driven by ~/.relay/:
 *
 *   profile.yaml                     # your own profile (name, phone, about)
 *   <contact|g-<chatId>>/profile.yaml
 *   <contact|g-<chatId>>/messages.yaml
 *   <contact|g-<chatId>>/files/
 *
 * Groups use folder id g-<chatId> with profile.kind = group (see other/chats.js).
 */
let ROOT = HOME + '/.relay';

let COLORS = ['#25D366', '#FF69B4', '#9B59B6', '#FF1493', '#34B7F1', '#F5A623', '#E74C3C'];

export default class Relay {
  state = {
    ready: false,
    root: ROOT,
    me: {},
    contacts: [],
    active: null,
    messages: [],
    activeContact: null,
    draft: '',
    error: '',
    composingGroup: false,
    groupTitle: '',
    groupCandidates: [],
    groupError: '',
  };

  store = new ChatStore({
    root: ROOT,
    appId: 'relay',
    onChange: ({ id }) => this._onStoreChange(id),
  });

  actions = {
    init: async () => {
      if (this.state.ready) return;
      await vfs.ensureReady();
      if (!(await vfs.exists(ROOT))) await this._seed();
      await this.store.loadAll();
      this.store.watch();
      this.state.ready = true;
      this._sync();
    },

    select: async (id) => {
      this.state.active = id || null;
      this.state.draft = '';
      this._sync();
      scrollChatToEnd('relay');
      if (id) await this.store.markRead(id);
      this._sync();
    },

    /** Notification click target. */
    openTarget: async (id) => {
      await this.actions.select(id);
    },

    send: async () => {
      let text = String(this.state.draft || '').trim();
      let id = this.state.active;
      if (!text || !id) return;
      this.state.draft = '';
      await this.store.send(id, text);
    },

    attach: async () => {
      let id = this.state.active;
      if (!id) return;
      let path = await showFilePicker({ title: 'Send a file', startPath: HOME, mode: 'file' });
      if (!path) return;
      let text = String(this.state.draft || '').trim();
      this.state.draft = '';
      await this.store.send(id, text, [path]);
    },

    openFile: (path) => post('vfs.openPath', path),

    openNewGroup: async () => {
      await this._loadGroupCandidates();
      this.state.composingGroup = true;
      this.state.groupTitle = '';
      this.state.groupError = '';
      this._sync();
    },

    cancelNewGroup: () => {
      this.state.composingGroup = false;
      this.state.groupTitle = '';
      this.state.groupError = '';
      this.state.groupCandidates = [];
      this._sync();
    },

    toggleGroupPick: (id) => {
      let c = this.state.groupCandidates.find((x) => x.id === id);
      if (!c) return;
      c.picked = !c.picked;
      this._sync();
    },

    createGroup: async () => {
      let title = String(this.state.groupTitle || '').trim();
      let picked = this.state.groupCandidates.filter((c) => c.picked).map((c) => c.user);
      if (!title) {
        this.state.groupError = 'Name the group';
        this._sync();
        return;
      }
      if (picked.length < 2) {
        this.state.groupError = 'Pick at least two people';
        this._sync();
        return;
      }
      this.state.groupError = '';
      try {
        let result = await createGroup({
          title,
          participants: [PLAYER, ...picked],
          createdBy: PLAYER,
        });
        await this.store.loadAll();
        this.state.composingGroup = false;
        this.state.groupTitle = '';
        this.state.groupCandidates = [];
        this._sync();
        await this.actions.select(result.viewId);
      } catch (err) {
        this.state.groupError = err?.message || String(err);
        this._sync();
      }
    },
  };

  async _loadGroupCandidates() {
    let users = await listUsers();
    let skip = new Set(['root', PLAYER, 'nobody']);
    let byUser = new Map();
    for (let [id, chat] of Object.entries(this.store.chats)) {
      let u = String(chat.profile?.user || '');
      if (!u || skip.has(u) || chat.profile?.kind === 'group') continue;
      byUser.set(u, {
        id: u,
        user: u,
        name: chat.profile?.name || u,
        picked: false,
      });
    }
    for (let u of Object.values(users || {})) {
      let name = String(u?.name || '');
      if (!name || skip.has(name) || byUser.has(name)) continue;
      let prof =
        (await readYaml('home/' + name + '/profile.yaml', {}).catch(() => ({}))) || {};
      byUser.set(name, {
        id: name,
        user: name,
        name: prof.name || name,
        picked: false,
      });
    }
    this.state.groupCandidates = [...byUser.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  _onStoreChange(id) {
    let chat = this.store.chats[id];
    let fresh = chat?.fresh || [];
    chat && (chat.fresh = []);
    if (fresh.length) {
      // The open, focused chat reads new messages immediately.
      if (this.state.active === id && rawctrls.desktop.actions.isWinActive('relay')) {
        this.store.markRead(id);
      } else {
        let name = this._name(id, chat.profile);
        let last = fresh[fresh.length - 1];
        let image = fresh.flatMap((m) => m.images)[0];
        rawctrls.desktop.actions.notify({
          appId: 'relay',
          title: name,
          text:
            (fresh.length > 1 ? fresh.length + ' new messages · ' : '') +
            (last.text || (last.files.length ? '📎 ' + last.files[0].name : '')),
          image: image?.url || '',
          target: id,
        });
      }
    }
    this._sync();
    d.update();
    if (id === this.state.active) scrollChatToEnd('relay');
  }

  _name(id, profile) {
    return (profile && profile.name) || id;
  }

  _participantLabel(user) {
    let u = String(user || '');
    for (let chat of Object.values(this.store.chats)) {
      if (chat.profile?.kind === 'group') continue;
      if (String(chat.profile?.user || '') === u) return chat.profile?.name || u;
    }
    return u;
  }

  _sync() {
    let s = this.state;
    s.me = this.store.me || {};
    let ids = Object.keys(this.store.chats);
    s.contacts = ids
      .map((id, i) => {
        let chat = this.store.chats[id];
        let p = chat.profile || {};
        let isGroup = p.kind === 'group' || !!chat.isGroup;
        let last = chat.messages[chat.messages.length - 1];
        let color = p.color || COLORS[i % COLORS.length];
        let participants = (p.participants || chat.participants || []).map(String);
        let preview = '';
        if (last) {
          let who = last.mine ? 'You' : isGroup ? last.senderLabel || last.fromUser : '';
          preview =
            (who ? who + ': ' : '') +
            (last.text || (last.files.length ? '📎 ' + last.files[0].name : ''));
        } else if (isGroup) {
          preview = 'Group · ' + participants.length + ' people';
        } else {
          preview = p.about || '';
        }
        let subtitle = isGroup
          ? participants
              .filter((u) => u !== PLAYER)
              .map((u) => this._participantLabel(u))
              .join(', ')
          : p.phone || id;
        if (isGroup && p.about) subtitle = subtitle;
        let presence = isGroup ? '' : chat.presence || 'offline';
        let presenceLabel = presence === 'online' ? 'online' : 'offline';
        return {
          id,
          phone: p.phone || id,
          name: this._name(id, p),
          about: p.about || '',
          kind: isGroup ? 'group' : 'dm',
          isGroup,
          participants,
          subtitle,
          presence,
          presenceLabel,
          memberLine: isGroup
            ? participants.map((u) => this._participantLabel(u)).join(', ')
            : presenceLabel,
          initial: isGroup
            ? '👥'
            : String(this._name(id, p)).replace(/^\+/, '').slice(0, 1).toUpperCase(),
          color,
          tw: 'bg-[' + color + ']',
          // Fragment ties src to contact id so wf-map reuse cannot keep a neighbor's bitmap.
          avatar: chat.avatarUrl ? chat.avatarUrl + '#c=' + encodeURIComponent(id) : '',
          preview,
          ts: last?.ts || 0,
          time: last?.time || '',
          unread: this.store.unreadCount(id),
          error: chat.error,
        };
      })
      .sort((a, b) => b.ts - a.ts || a.name.localeCompare(b.name));
    if (s.active && !this.store.chats[s.active]) s.active = null;
    s.activeContact = s.contacts.find((c) => c.id === s.active) || null;
    s.messages = s.active ? this.store.chats[s.active].messages : [];
    s.error = s.activeContact?.error || '';
    rawctrls.desktop.actions.setUnread('relay', this.store.totalUnread());
    rawctrls.desktop.actions.syncAppNotifications(
      'relay',
      Object.keys(this.store.chats).flatMap((id) => {
        let chat = this.store.chats[id];
        let unread = chat.messages.filter((m) => m.unread);
        if (!unread.length) return [];
        let last = unread[unread.length - 1];
        return [{
          key: id,
          title: this._name(id, chat.profile),
          text:
            (unread.length > 1 ? unread.length + ' new messages · ' : '') +
            (last.text || (last.files.length ? '📎 ' + last.files[0].name : '')),
          image: unread.flatMap((m) => m.images)[0]?.url || '',
          target: id,
          ts: last.ts,
        }];
      }),
    );
  }

  /**
   * First-run OS seed only. Cast / world chats live in the VFS world pack.
   * When the Relay root has no peers yet, seed a God's Hand contact (empty
   * thread). The welcome / how-to lives in Mail.
   */
  async _seed() {
    await writeYaml(ROOT + '/profile.yaml', {
      name: (await vfs.getUser(PLAYER).catch(() => null))?.gecos || PLAYER,
      phone: '+1555' + String(1000000 + Math.floor(Math.random() * 8999999)),
      about: 'encrypted · online',
    });
    try {
      let entries = (await vfs.list()).filter(
        (p) => p.startsWith(ROOT + '/') && p.slice(ROOT.length + 1).split('/').length === 1,
      );
      let peers = entries.filter((p) => !p.endsWith('/profile.yaml') && !p.endsWith('/.keep'));
      if (peers.length) return;
    } catch {}
    // God's Hand contact via real user + avatar hardlink (portrait lives in home/godshand/).
    let { addContact } = await import('../other/chats.js');
    await addContact(PLAYER, 'godshand');
    let dir = ROOT + '/godshand';
    await ensureDir(dir + '/files');
    let profPath = dir + '/profile.yaml';
    let prev = (await readYaml(profPath, {}).catch(() => ({}))) || {};
    await writeYaml(profPath, {
      ...prev,
      phone: prev.phone || 'godshand',
      name: "God's Hand",
      about: prev.about || 'world builder · always here',
      color: prev.color || '#111827',
      user: 'godshand',
      avatar: 'avatar.jpg',
    });
  }
}

