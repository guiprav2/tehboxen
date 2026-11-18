import '../other/show-dialog.js';
import { PLAYER, PLAYER_HOME, readSession, clearSession, hardNavigate } from '../other/session.js';
import * as vfs from '../other/vfs.js';
import { imageExt, videoExt, mediaExt } from '../other/vfs.js';
import { showFilePicker } from '../other/file-picker.js';
import {
  PICTURES,
  fileUrl,
  seedOsMedia,
} from '../other/messaging.js';

/** Wallpaper persistence lives in the logged-in player's home. */
let WALLAP_HOME = PLAYER_HOME;
let WALLAP_DIR = WALLAP_HOME + '/.desktop';
let WALLAP_PREFIX = WALLAP_DIR + '/wallpaper.';
let WALLAP_FADE_MS = 480;

/** App id → showDialog component name (components/<Name>.html id). */
let APP_COMPONENTS = {
  relay: 'Relay',
  mail: 'Mail',
  settings: 'Settings',
  terminal: 'Terminal',
  explorer: 'Explorer',
  editor: 'Editor',
  mediaViewer: 'MediaViewer',
  winzip: 'WinZip',
  places: 'Places',
  dangerZone: 'DangerZone',
};

export default class Desktop {
  /** @type {Record<string, Promise & { close: Function, el: Element }>} */
  _dialogs = {};
  _customWallpaperUrl = '';
  _wallpaperLayer = 'a';
  _wallpaperIgnore = 0;
  _wallpaperWatch = null;
  _wallpaperFadeTimer = 0;
  _wallpaperAppliedKey = '';

  state = {
    clock: '',
    /** Logged-in player (other/session.js). */
    user: PLAYER,
    wallpaperId: 'circuit-grid',
    /** Kept for Settings card highlight; visual layers are driven by JS. */
    wallpaperClass: 'bg-cover bg-center bg-zinc-950',
    wallpaperInlineUrl: '',
    /** 'image' | 'video' | 'gradient' — what the desktop is showing */
    wallpaperKind: 'image',
    /** Display name for the active wallpaper (Settings hero). */
    wallpaperName: 'Circuit Grid',
    wallpapers: [
      {
        id: 'circuit-grid',
        name: 'Circuit Grid',
        type: 'image',
        // VFS path (seeded from host media/wallpapers/ into ~/Pictures/)
        src: PICTURES + '/circuit-grid.jpg',
        tw: '',
      },
      {
        id: 'glyph-rain',
        name: 'Glyph Rain',
        type: 'image',
        src: PICTURES + '/glyph-rain.jpg',
        tw: '',
      },
      {
        id: 'hexdump',
        name: 'Hexdump',
        type: 'image',
        src: PICTURES + '/hexdump.jpg',
        tw: '',
      },
      {
        id: 'phosphor',
        name: 'Phosphor',
        type: 'gradient',
        tw: 'bg-[radial-gradient(ellipse_at_50%_120%,_#14532d_0%,_#052e16_35%,_#020604_75%)]',
      },
      {
        id: 'deep-net',
        name: 'Deep Net',
        type: 'gradient',
        tw: 'bg-[linear-gradient(160deg,_#020617_0%,_#0c1d36_50%,_#064e3b_100%)]',
      },
      {
        id: 'neon-dusk',
        name: 'Neon Dusk',
        type: 'gradient',
        tw: 'bg-[radial-gradient(circle_at_15%_20%,_#0891b2_0%,_transparent_40%),_radial-gradient(circle_at_85%_80%,_#7e22ce_0%,_transparent_40%),_linear-gradient(160deg,_#020617_0%,_#0b1020_100%)]',
      },
      {
        id: 'redline',
        name: 'Redline',
        type: 'gradient',
        tw: 'bg-[linear-gradient(170deg,_#0a0000_0%,_#3f0a0a_55%,_#7f1d1d_100%)]',
      },
    ],
    apps: {
      relay: {
        id: 'relay',
        title: 'Relay',
        shortTitle: 'Relay',
        icon: 'nf-md-message_lock',
        iconTw: 'text-[#b8f5cc]',
        accent: '#25D366',
        accentTw: 'bg-[#25D366]',
        open: false,
        minimized: false,
        maximized: false,
        x: 80,
        y: 48,
        w: 720,
        h: 520,
        z: 1,
        frameClass: 'w-[720px] h-[520px] rounded-2xl',
      },
      mail: {
        id: 'mail',
        title: 'BoxMail',
        shortTitle: 'Mail',
        icon: 'nf-md-email',
        iconTw: 'text-emerald-200',
        accent: '#FF4DA6',
        accentTw: 'bg-[#FF4DA6]',
        open: false,
        minimized: false,
        maximized: false,
        x: 200,
        y: 56,
        w: 760,
        h: 520,
        z: 1,
        frameClass: 'w-[760px] h-[520px] rounded-2xl',
      },
      settings: {
        id: 'settings',
        title: 'Wallpaper Studio',
        shortTitle: 'Wallpapers',
        icon: 'nf-md-palette',
        iconTw: 'text-sky-200',
        accent: '#C77DFF',
        accentTw: 'bg-[#C77DFF]',
        open: false,
        minimized: false,
        maximized: false,
        x: 260,
        y: 90,
        w: 560,
        h: 440,
        z: 1,
        frameClass: 'w-[560px] h-[440px] rounded-2xl',
      },
      terminal: {
        id: 'terminal',
        multi: true,
        title: 'Terminal',
        shortTitle: 'Terminal',
        icon: 'nf-md-console',
        iconTw: 'text-emerald-200',
        accent: '#1a1b26',
        accentTw: 'bg-[#1a1b26]',
        open: false,
        minimized: false,
        maximized: false,
        x: 72,
        y: 40,
        w: 780,
        h: 480,
        z: 1,
        frameClass: 'w-[780px] h-[480px] rounded-2xl',
      },
      explorer: {
        id: 'explorer',
        multi: true,
        title: 'Explorer',
        shortTitle: 'Explorer',
        icon: 'nf-md-folder',
        iconTw: 'text-emerald-200',
        accent: '#50fa7b',
        accentTw: 'bg-[#50fa7b]',
        open: false,
        minimized: false,
        maximized: false,
        x: 120,
        y: 64,
        w: 640,
        h: 460,
        z: 1,
        frameClass: 'w-[640px] h-[460px] rounded-2xl',
      },
      editor: {
        id: 'editor',
        multi: true,
        title: 'Editor',
        shortTitle: 'Editor',
        icon: 'nf-md-file_document_edit',
        iconTw: 'text-sky-200',
        accent: '#89b4fa',
        accentTw: 'bg-[#89b4fa]',
        open: false,
        minimized: false,
        maximized: false,
        x: 160,
        y: 80,
        w: 720,
        h: 500,
        z: 1,
        frameClass: 'w-[720px] h-[500px] rounded-2xl',
      },
      mediaViewer: {
        id: 'mediaViewer',
        title: 'Media Viewer',
        shortTitle: 'Media',
        icon: 'nf-md-image',
        iconTw: 'text-green-200',
        accent: '#a6e3a1',
        accentTw: 'bg-[#a6e3a1]',
        open: false,
        minimized: false,
        maximized: false,
        x: 200,
        y: 96,
        w: 640,
        h: 480,
        z: 1,
        frameClass: 'w-[640px] h-[480px] rounded-2xl',
      },
      winzip: {
        id: 'winzip',
        multi: true,
        title: 'WinZip',
        shortTitle: 'WinZip',
        icon: 'nf-md-zip_box',
        iconTw: 'text-amber-200',
        accent: '#f9e2af',
        accentTw: 'bg-[#f9e2af]',
        open: false,
        minimized: false,
        maximized: false,
        x: 180,
        y: 70,
        w: 640,
        h: 480,
        z: 1,
        frameClass: 'w-[640px] h-[480px] rounded-2xl',
      },
      places: {
        id: 'places',
        title: 'Places',
        shortTitle: 'Places',
        icon: 'nf-md-map',
        iconTw: 'text-cyan-200',
        accent: '#e879f9',
        accentTw: 'bg-[#e879f9]',
        open: false,
        minimized: false,
        maximized: false,
        x: 100,
        y: 56,
        w: 780,
        h: 520,
        z: 1,
        frameClass: 'w-[780px] h-[520px] rounded-2xl',
      },
      dangerZone: {
        id: 'dangerZone',
        title: 'Danger Zone',
        shortTitle: 'Danger',
        icon: 'nf-md-skull_crossbones',
        iconTw: 'text-red-200',
        accent: '#f38ba8',
        accentTw: 'bg-[#f38ba8]',
        open: false,
        minimized: false,
        maximized: false,
        x: 160,
        y: 80,
        w: 520,
        h: 640,
        z: 1,
        frameClass: 'w-[520px] h-[640px] rounded-2xl',
      },
    },
    /** Open windows by window id (see openApp). Single-window apps use their app id. */
    wins: {},
    /** Open windows for the taskbar, sorted by z (synced via syncOpenWindows). */
    openWindows: [],
    zTop: 10,
    /** Window id of the focused window (equals the app id for single-window apps). */
    activeApp: null,
    /** Unread counts shown as badges on desktop icons. */
    unread: { relay: 0, mail: 0 },
    /** Bottom-right toasts: { id, appId, icon, accentTw, title, text, image, time, target }. */
    notifications: [],
    /** Phone notification shade (persists until dismissed/read), newest first. */
    shade: [],
    /** Distinct app icons of shade items, for the phone status bar. */
    shadeIcons: [],
    /** 'closed' | 'drag' | 'open' | 'closing' */
    shadePhase: 'closed',
    _drag: null,
    _clockTimer: null,
    // Phone / small-viewport Android shell
    phoneMode: false,
    recentsOpen: false,
    recentsIndex: 0,
    recentsCurrentId: null,
    recentsOpenApps: [],
    statusBattery: 87,
    statusSignal: 4,
    _phoneMq: null,
    _recentsGesture: null,
  };

  actions = {
    init: async () => {
      // No session → back to the login screen (not inside the visual editor).
      if (!readSession() && !location.pathname.startsWith('/files/')) {
        hardNavigate('index.html');
        return;
      }
      this.actions.tickClock();
      if (this.state._clockTimer) clearInterval(this.state._clockTimer);
      this.state._clockTimer = setInterval(() => {
        this.actions.tickClock();
        d.update();
      }, 1000);
      this.actions.bindPhoneMode();
      this.actions.bindVisualViewport();
      this.actions.syncOpenWindows();
      try {
        await post('vfs.init');
      } catch {}
      try {
        await this.actions.initWallpaper();
      } catch (err) {
        console.warn('initWallpaper', err);
        this.actions.applyWallpaper(false);
      }
      // Always-on debug bridge. Dynamic import so a dbgclient failure cannot
      // hang Desktop boot (static import left the preview stuck on "loading").
      // Do not await — init must finish; bridge connects in the background.
      (async () => {
        try {
          let { startDbgClient, isDbgConnected } = await import('../other/dbgclient.js');
          await startDbgClient();
          if (!isDbgConnected()) {
            this.actions.notify({
              title: 'Debug bridge',
              text: 'Looking for dbgserver on localhost:8766…',
              icon: 'nf-md-bug',
              accentTw: 'bg-amber-500',
            });
            d.update();
          }
        } catch (err) {
          console.warn('dbgclient', err);
          this.actions.notify({
            title: 'Debug bridge',
            text: 'Failed to start: ' + (err?.message || String(err)),
            icon: 'nf-md-bug',
            accentTw: 'bg-amber-500',
          });
          d.update();
        }
      })();
      // Messaging apps load from ~/.<app>/ and watch it for new messages.
      for (let ctrl of ['relay', 'mail']) {
        post(ctrl + '.init').catch((err) => console.warn(ctrl + '.init', err));
      }
      // Duration wakes → var/npc_events.yaml (replaces 1-minute life loop).
      (async () => {
        try {
          let { startNpcEvents } = await import('../other/npc-events.js');
          await startNpcEvents();
        } catch (err) {
          console.warn('npc-events', err);
        }
      })();
    },

    /**
     * Keep the desktop root sized to the *visible* viewport, so the on-screen
     * keyboard shrinks the whole desktop (apps, nav bar) instead of covering it.
     * Publishes --vv-h / --vv-top on <html>; the root uses
     * h-[var(--vv-h,100dvh)] translate-y-[var(--vv-top,0px)].
     */
    bindVisualViewport: () => {
      let vv = typeof window !== 'undefined' && window.visualViewport;
      if (!vv || !document.documentElement?.style) return;
      if (this._vvHandler) {
        vv.removeEventListener('resize', this._vvHandler);
        vv.removeEventListener('scroll', this._vvHandler);
      }
      let apply = () => {
        let root = document.documentElement.style;
        root.setProperty('--vv-h', vv.height + 'px');
        // iOS pans the layout viewport when the keyboard opens; follow it.
        root.setProperty('--vv-top', Math.max(0, vv.offsetTop) + 'px');
      };
      this._vvHandler = apply;
      vv.addEventListener('resize', apply);
      vv.addEventListener('scroll', apply);
      apply();
    },

    bindPhoneMode: () => {
      if (typeof window === 'undefined') return;
      // Nasty (native export) has no matchMedia: derive CSS px width from
      // window.size() / devicePixelRatio() (same math Nasty uses for md:) and
      // listen to its host 'resize' event instead.
      let mq = window.matchMedia
        ? window.matchMedia('(max-width: 767px)')
        : {
            get matches() {
              let w = window.size?.()?.width;
              let dpr = typeof window.devicePixelRatio === 'function' ? window.devicePixelRatio() : 1;
              if (!Number.isFinite(w)) w = window.innerWidth;
              return Number.isFinite(w) && w / (dpr || 1) < 768;
            },
            addEventListener: (type, fn) => window.addEventListener('resize', fn),
            removeEventListener: (type, fn) => window.removeEventListener('resize', fn),
          };
      let apply = () => {
        let next = !!mq.matches;
        if (this.state.phoneMode === next) {
          for (let id of Object.keys(this.state.wins)) this.actions.syncFrame(id);
          return;
        }
        this.state.phoneMode = next;
        if (!next) this.state.recentsOpen = false;
        for (let id of Object.keys(this.state.wins)) this.actions.syncFrame(id);
        d.update();
      };
      if (this.state._phoneMq && this.state._phoneMq.handler) {
        try {
          this.state._phoneMq.mq.removeEventListener('change', this.state._phoneMq.handler);
        } catch {}
      }
      this.state._phoneMq = { mq, handler: apply };
      mq.addEventListener('change', apply);
      apply();
    },

    tickClock: () => {
      let now = new Date();
      this.state.clock = now.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit',
      });
    },

    /** Resolve a window id, or an app id to its top-most window. */
    win: (idOrApp) => {
      if (!idOrApp) return null;
      let w = this.state.wins[idOrApp];
      if (w) return w;
      let list = Object.values(this.state.wins).filter((x) => x.appId === idOrApp);
      list.sort((a, b) => b.z - a.z);
      return list[0] || null;
    },

    /** Windows of one app, oldest first. */
    winsOf: (appId) =>
      Object.values(this.state.wins)
        .filter((w) => w.appId === appId)
        .sort((a, b) => a.seq - b.seq),

    /** Called by each window's component (see other/app-window.js). */
    registerInstance: (winId, ctrl, comp) => {
      if (!winId) return;
      this._instances[winId] = { ctrl, comp };
    },

    /** The per-window controller of a multi-instance app window. */
    instance: (winId) => this._instances[winId]?.ctrl || null,

    /** End the session and reload into the login screen (fresh module state). */
    logout: () => {
      clearSession();
      hardNavigate('index.html');
    },

    /** Taskbar label for a window (e.g. Explorer shows its folder). */
    setWinTitle: (winId, shortTitle, title) => {
      let w = this.state.wins[winId];
      if (!w) return;
      let app = this.state.apps[w.appId];
      w.shortTitle = shortTitle || app?.shortTitle || app?.title;
      w.title = title || shortTitle || app?.title;
      this.actions.syncOpenWindows();
    },

    openAppsList: () => {
      return Object.values(this.state.wins).sort((a, b) => a.z - b.z);
    },

    syncOpenWindows: () => {
      this.state.openWindows = this.actions.openAppsList();
      for (let app of Object.values(this.state.apps)) {
        app.open = Object.values(this.state.wins).some((w) => w.appId === app.id);
      }
    },

    syncRecentsCurrent: () => {
      let list = this.actions.openAppsList();
      this.state.recentsOpenApps = list.map((w) => ({
        id: w.id,
        title: w.title,
        icon: w.icon,
        accentTw: w.accentTw || 'bg-emerald-500',
      }));
      if (!list.length) {
        this.state.recentsCurrentId = null;
        this.state.recentsIndex = 0;
        return null;
      }
      let i =
        ((this.state.recentsIndex % list.length) + list.length) % list.length;
      this.state.recentsIndex = i;
      this.state.recentsCurrentId = list[i].id;
      return list[i];
    },

    currentRecentsApp: () => {
      let id = this.state.recentsCurrentId;
      if (id && this.state.wins[id]) return this.state.wins[id];
      return this.actions.syncRecentsCurrent();
    },

    registerWindow: (id) => {
      let w = this.actions.win(id);
      if (w) this.actions.syncFrame(w.id);
    },

    unregisterWindow: (id) => {},
    currentWallpaper: () => {
      return (
        this.state.wallpapers.find((w) => w.id === this.state.wallpaperId) ||
        this.state.wallpapers[0]
      );
    },

    /** Built-in + gradient presets only (Settings grid; hides file-based custom). */
    wallpaperPresets: () => {
      return this.state.wallpapers.filter((w) => w.id !== 'custom');
    },

    /**
     * Sync URL for UI bindings. Prefers blob:/data:/http(s); otherwise a
     * warmed VFS object URL. Never points at host project media/.
     */
    mediaUrl: (path) => {
      let raw = String(path || '');
      if (/^(blob:|data:|https?:)/i.test(raw)) return raw;
      let clean = raw.replace(/^\.\.\//, '').replace(/^\//, '');
      return this._vfsMediaUrls?.[clean] || '';
    },

    /** Resolve a VFS path to a blob URL and cache it for sync mediaUrl(). */
    warmMediaUrl: async (path) => {
      let raw = String(path || '');
      if (!raw || /^(blob:|data:|https?:)/i.test(raw)) return raw;
      let clean = raw.replace(/^\.\.\//, '').replace(/^\//, '');
      if (!this._vfsMediaUrls) this._vfsMediaUrls = {};
      if (this._vfsMediaUrls[clean]) return this._vfsMediaUrls[clean];
      if (!(await vfs.exists(clean))) return '';
      let url = await fileUrl(clean);
      if (url) this._vfsMediaUrls[clean] = url;
      return url || '';
    },

    initWallpaper: async () => {
      await vfs.ensureReady();
      // Host media/ → VFS ~/Pictures/ (and similar) once; UI reads VFS only.
      try {
        await seedOsMedia();
      } catch (err) {
        console.warn('seedOsMedia', err);
      }
      try {
        if (!(await vfs.isDirectory(WALLAP_DIR))) {
          await vfs.withLock(WALLAP_DIR + '/.keep', (lease) => vfs.write(WALLAP_DIR + '/.keep', '', { lease }), { mode: 'w', actor: 'ui:desktop' });
        }
      } catch {}
      for (let wp of this.state.wallpapers) {
        if (wp.type === 'image' && wp.src) {
          try {
            await this.actions.warmMediaUrl(wp.src);
          } catch {}
        }
      }
      this.actions._ensureWallpaperWatch();
      let loaded = await this.actions._loadPersistedWallpaper(false);
      if (!loaded) await this.actions.applyWallpaper(false);
    },

    _ensureWallpaperWatch: () => {
      if (this._wallpaperWatch) return;
      this._wallpaperWatch = vfs.onChange((ev) => {
        let p = String(ev?.path || '');
        if (!p.startsWith(WALLAP_PREFIX) && p !== WALLAP_DIR + '/.keep') return;
        if (this._wallpaperIgnore > 0) return;
        clearTimeout(this._wallpaperFadeTimer);
        this._wallpaperFadeTimer = setTimeout(() => {
          this.actions._loadPersistedWallpaper(true).catch((err) =>
            console.warn('wallpaper watch', err),
          );
        }, 80);
      });
    },

    _listWallpaperFiles: async () => {
      let all = await vfs.list();
      return all
        .filter((p) => p.startsWith(WALLAP_PREFIX) && mediaExt(p))
        .sort();
    },

    _clearWallpaperFiles: async () => {
      let all = await vfs.list();
      for (let p of all) {
        if (p.startsWith(WALLAP_PREFIX)) {
          try {
            await vfs.withLock(p, (lease) => vfs.remove(p, { lease }), { mode: 'w', actor: 'ui:desktop' });
          } catch {}
        }
      }
    },

    /** Write blob to ~/.desktop/wallpaper.<ext>, replacing any previous wallpaper.*. */
    _persistWallpaperBlob: async (blob, ext) => {
      let clean = String(ext || 'bin')
        .replace(/^\./, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '') || 'bin';
      this._wallpaperIgnore++;
      try {
        if (!(await vfs.isDirectory(WALLAP_DIR))) {
          await vfs.withLock(WALLAP_DIR + '/.keep', (lease) => vfs.write(WALLAP_DIR + '/.keep', '', { lease }), { mode: 'w', actor: 'ui:desktop' });
        }
        await this.actions._clearWallpaperFiles();
        let dest = WALLAP_PREFIX + clean;
        await vfs.withLock(
          dest,
          (lease) =>
            vfs.writeBlob(
              dest,
              blob,
              blob.type || (videoExt(dest) ? 'video/mp4' : 'image/jpeg'),
              { lease },
            ),
          { mode: 'w', actor: 'ui:desktop' },
        );
        return dest;
      } finally {
        setTimeout(() => {
          this._wallpaperIgnore = Math.max(0, this._wallpaperIgnore - 1);
        }, 200);
      }
    },

    _persistWallpaperFromVfs: async (srcPath) => {
      let blob = await vfs.withLock(srcPath, (lease) => vfs.readBlob(srcPath, { lease }), { mode: 'r', actor: 'ui:desktop' });
      if (!blob) throw new Error('Cannot read ' + srcPath);
      let base = String(srcPath).split('/').pop() || 'wallpaper.bin';
      let m = /\.([a-z0-9]+)$/i.exec(base);
      return this.actions._persistWallpaperBlob(blob, m ? m[1] : 'bin');
    },

    /** @deprecated presets live in VFS; use _persistWallpaperFromVfs */
    _persistWallpaperFromProject: async (vfsSrc) => {
      return this.actions._persistWallpaperFromVfs(vfsSrc);
    },

    /**
     * Load first ~/.desktop/wallpaper.* media file onto the desktop.
     * @param {boolean} fade cross-fade when true
     * @returns {Promise<boolean>} whether a file was applied
     */
    _loadPersistedWallpaper: async (fade = true) => {
      let files = await this.actions._listWallpaperFiles();
      if (!files.length) return false;
      let path = files[0];
      let blob = await vfs.withLock(path, (lease) => vfs.readBlob(path, { lease }), { mode: 'r', actor: 'ui:desktop' });
      if (!blob) return false;
      let url = URL.createObjectURL(blob);
      if (this._customWallpaperUrl) {
        try {
          URL.revokeObjectURL(this._customWallpaperUrl);
        } catch {}
      }
      this._customWallpaperUrl = url;
      let isVid = videoExt(path);
      let base = path.split('/').pop() || 'wallpaper';
      let entry = {
        id: 'custom',
        name: 'Current wallpaper',
        type: isVid ? 'video' : 'image',
        src: url,
        vfsPath: path,
        tw: '',
      };
      let idx = this.state.wallpapers.findIndex((w) => w.id === 'custom');
      if (idx >= 0) this.state.wallpapers[idx] = entry;
      else this.state.wallpapers.unshift(entry);
      this.state.wallpaperId = 'custom';
      this.state.wallpaperKind = entry.type;
      this.state.wallpaperName = entry.name;
      await this.actions._presentWallpaper(
        {
          kind: entry.type,
          url,
          key: path,
        },
        fade,
      );
      d.update();
      return true;
    },

    _wallpaperEls: (side) => {
      let root = document.querySelector('[data-wallpaper]');
      if (!root) return {};
      return {
        root,
        layer: root.querySelector(`[data-wallpaper-layer="${side}"]`),
        video: root.querySelector(`[data-wallpaper-video="${side}"]`),
      };
    },

    _configureWallpaperSide: (side, spec) => {
      let { layer, video } = this.actions._wallpaperEls(side);
      if (!layer || !video) return;
      // reset
      layer.style.backgroundImage = '';
      layer.className =
        'absolute inset-0 bg-cover bg-center bg-emerald-700 transition-opacity duration-500 ease-out';
      video.pause?.();
      video.removeAttribute('src');
      video.load?.();
      video.classList.add('opacity-0');
      video.classList.remove('opacity-100');
      layer.classList.add('opacity-0');
      layer.classList.remove('opacity-100');

      if (spec.kind === 'video' && spec.url) {
        video.src = spec.url;
        video.muted = true;
        video.defaultMuted = true;
        video.setAttribute('muted', '');
        video.loop = true;
        video.autoplay = true;
        video.playsInline = true;
        video.setAttribute('playsinline', '');
        video.setAttribute('autoplay', '');
        video.setAttribute('loop', '');
        let play = () => {
          let p = video.play();
          if (p && p.catch) p.catch(() => {});
        };
        if (video.readyState >= 2) play();
        else video.addEventListener('canplay', play, { once: true });
        // Stay opacity-0 until _presentWallpaper fades this side in.
        video.classList.add('opacity-0');
        video.classList.remove('opacity-100');
        layer.classList.add('opacity-0');
        layer.classList.remove('opacity-100');
      } else if (spec.kind === 'gradient') {
        layer.style.backgroundImage = this.actions._twGradientToCss(spec.tw) || '';
        layer.classList.add('opacity-0');
        layer.classList.remove('opacity-100');
      } else if (spec.url) {
        layer.style.backgroundImage = `url("${spec.url}")`;
        layer.classList.add('opacity-0');
        layer.classList.remove('opacity-100');
      }
    },

    /** Convert a Tailwind arbitrary bg-[...] token (linear/radial/stacked) to CSS. */
    _twGradientToCss: (tw) => {
      let m = /bg-\[(.+)\]/.exec(String(tw || ''));
      if (!m) return '';
      return m[1].replace(/_/g, ' ');
    },

    /**
     * Cross-fade (or snap) the desktop wallpaper layers to `spec`.
     * spec: { kind: 'image'|'video'|'gradient', url?, tw?, key? }
     */
    _presentWallpaper: async (spec, fade = true) => {
      let key =
        spec.key ||
        spec.kind + ':' + (spec.url || spec.tw || this.state.wallpaperId || '');
      if (key && key === this._wallpaperAppliedKey && fade) return;
      let next = this._wallpaperLayer === 'a' ? 'b' : 'a';
      let cur = this._wallpaperLayer;
      this.actions._configureWallpaperSide(next, spec);

      let curEls = this.actions._wallpaperEls(cur);
      let nextEls = this.actions._wallpaperEls(next);
      if (!nextEls.layer) {
        // DOM not ready — retry once
        await new Promise((r) => requestAnimationFrame(r));
        nextEls = this.actions._wallpaperEls(next);
        curEls = this.actions._wallpaperEls(cur);
      }
      if (!nextEls.layer) return;

      let showNext = () => {
        if (spec.kind === 'video') {
          nextEls.video?.classList.remove('opacity-0');
          nextEls.video?.classList.add('opacity-100');
          nextEls.layer.classList.remove('opacity-0');
          nextEls.layer.classList.add('opacity-100');
        } else {
          nextEls.layer.classList.remove('opacity-0');
          nextEls.layer.classList.add('opacity-100');
          nextEls.video?.classList.add('opacity-0');
          nextEls.video?.classList.remove('opacity-100');
        }
      };
      let hideCur = () => {
        curEls.layer?.classList.remove('opacity-100');
        curEls.layer?.classList.add('opacity-0');
        curEls.video?.classList.remove('opacity-100');
        curEls.video?.classList.add('opacity-0');
      };

      if (!fade) {
        showNext();
        hideCur();
        if (curEls.video) {
          try {
            curEls.video.pause();
            curEls.video.removeAttribute('src');
            curEls.video.load?.();
          } catch {}
        }
        this._wallpaperLayer = next;
        this._wallpaperAppliedKey = key;
        return;
      }

      // Start visible next at 0, then fade
      nextEls.layer.classList.add('opacity-0');
      nextEls.layer.classList.remove('opacity-100');
      // force reflow
      void nextEls.layer.offsetWidth;
      showNext();
      hideCur();
      this._wallpaperLayer = next;
      this._wallpaperAppliedKey = key;
      setTimeout(() => {
        let old = this.actions._wallpaperEls(cur);
        if (old.video && old.video !== nextEls.video) {
          try {
            old.video.pause();
            old.video.removeAttribute('src');
            old.video.load?.();
          } catch {}
        }
      }, WALLAP_FADE_MS + 40);
    },

    applyWallpaper: async (fade = true) => {
      let wp = this.actions.currentWallpaper();
      if (!wp) return;
      this.state.wallpaperName = wp.name || wp.id || '';
      if (wp.type === 'video') {
        this.state.wallpaperKind = 'video';
        this.state.wallpaperClass = 'bg-cover bg-center bg-emerald-700';
        let url = (await this.actions.warmMediaUrl(wp.src)) || '';
        this.state.wallpaperInlineUrl = url;
        this.actions._presentWallpaper(
          { kind: 'video', url, key: 'id:' + wp.id },
          fade,
        );
      } else if (wp.type === 'image') {
        this.state.wallpaperKind = 'image';
        let url = (await this.actions.warmMediaUrl(wp.src)) || '';
        this.state.wallpaperClass = 'bg-cover bg-center bg-emerald-700';
        this.state.wallpaperInlineUrl = url;
        this.actions._presentWallpaper(
          { kind: 'image', url, key: 'id:' + wp.id },
          fade,
        );
      } else {
        this.state.wallpaperKind = 'gradient';
        this.state.wallpaperClass =
          (wp.tw || '') + ' bg-cover bg-center bg-emerald-700';
        this.state.wallpaperInlineUrl = '';
        this.actions._presentWallpaper(
          { kind: 'gradient', tw: wp.tw || '', key: 'id:' + wp.id },
          fade,
        );
      }
    },

    setWallpaper: async (id) => {
      this.state.wallpaperId = id;
      let wp = this.actions.currentWallpaper();
      await this.actions.applyWallpaper(true);
      d.update();
      try {
        if (wp?.type === 'image' && wp.src && !/^(blob:|data:)/i.test(wp.src)) {
          // Preset VFS file (e.g. ~/Pictures/*.jpg) → ~/.desktop/wallpaper.*
          await this.actions._persistWallpaperFromVfs(wp.src);
        } else if (wp?.type === 'image' || wp?.type === 'video') {
          if (wp.vfsPath && mediaExt(wp.vfsPath)) {
            await this.actions._persistWallpaperFromVfs(wp.vfsPath);
          } else if (wp.src && /^(blob:|data:)/i.test(wp.src)) {
            let res = await fetch(wp.src);
            let blob = await res.blob();
            let ext =
              (wp.vfsPath && /\.([a-z0-9]+)$/i.exec(wp.vfsPath)?.[1]) ||
              (blob.type.includes('video') ? 'mp4' : 'jpg');
            await this.actions._persistWallpaperBlob(blob, ext);
          }
        } else if (wp?.type === 'gradient') {
          // Gradients aren't files — clear persisted media wallpaper.
          this._wallpaperIgnore++;
          try {
            await this.actions._clearWallpaperFiles();
          } finally {
            setTimeout(() => {
              this._wallpaperIgnore = Math.max(0, this._wallpaperIgnore - 1);
            }, 200);
          }
        }
      } catch (err) {
        console.warn('persist wallpaper', err);
      }
    },

    /** Pick an image or video from the Tehboxen filesystem as the desktop wallpaper. */
    pickCustomWallpaper: async () => {
      try {
        let path = await showFilePicker({
          title: 'Custom wallpaper',
          startPath: WALLAP_HOME,
          mode: 'file',
          accept: 'media',
        });
        if (!path) return;
        if (!mediaExt(path)) {
          this.actions.notify({
            title: 'Wallpaper',
            text: 'Pick an image or video file',
            icon: 'nf-md-image',
            accentTw: 'bg-teal-500',
          });
          return;
        }
        let dest = await this.actions._persistWallpaperFromVfs(path);
        await this.actions._loadPersistedWallpaper(true);
        this.actions.notify({
          title: 'Wallpaper',
          text: 'Saved to ~/.desktop/' + dest.split('/').pop(),
          icon: 'nf-md-wallpaper',
          accentTw: 'bg-cyan-500',
        });
      } catch (err) {
        console.warn('pickCustomWallpaper', err);
      }
    },

    _mountAppDialog: (win, props) => {
      let name = APP_COMPONENTS[win.appId];
      if (!name || typeof showDialog !== 'function') return null;
      let handle = showDialog(name, { ...props, appId: win.appId, winId: win.id });
      this._dialogs[win.id] = handle;
      try {
        handle.el?.setAttribute?.('data-win-id', win.id);
      } catch {}
      handle
        .then(() => {
          if (this._dialogs[win.id] === handle) delete this._dialogs[win.id];
          if (this.state.wins[win.id]) {
            this.actions._forgetWin(win.id);
            d.update();
          }
        })
        .catch(() => {});
      return handle;
    },

    _forgetWin: (winId) => {
      delete this.state.wins[winId];
      delete this._instances[winId];
      if (this.state.activeApp === winId) {
        let top = this.actions.openAppsList().filter((w) => !w.minimized).pop();
        this.state.activeApp = top ? top.id : null;
      }
      this.actions.syncOpenWindows();
    },

    /**
     * Open an app. Apps with `multi: true` get a new window every time;
     * other apps focus their one window. `props` reach the window's component
     * (e.g. { openPath } for Editor / WinZip, { cwd } for Explorer).
     * Returns the window id.
     */
    openApp: (appId, props = {}) => {
      let app = this.state.apps[appId];
      if (!app) return null;
      this.state.recentsOpen = false;
      if (!app.multi && this.state.wins[appId]) {
        this.actions.focusApp(appId);
        return appId;
      }
      this._seq += 1;
      let winId = app.multi ? appId + '~' + this._seq : appId;
      let siblings = this.actions.winsOf(appId).length;
      let shift = (siblings % 8) * 28;
      let win = {
        id: winId,
        appId,
        seq: this._seq,
        title: app.title,
        shortTitle: app.shortTitle || app.title,
        icon: app.icon,
        iconTw: app.iconTw,
        accent: app.accent,
        accentTw: app.accentTw,
        x: app.x + shift,
        y: app.y + shift,
        w: app.w,
        h: app.h,
        z: 1,
        minimized: false,
        maximized: !!this.state.phoneMode,
        frameClass: '',
      };
      this.state.wins[winId] = win;
      this.actions._mountAppDialog(win, props);
      this.actions.focusApp(winId);
      this.actions.syncFrame(winId);
      this.actions.syncOpenWindows();
      return winId;
    },

    closeApp: (id) => {
      let w = this.actions.win(id);
      if (!w) return;
      let handle = this._dialogs[w.id];
      delete this._dialogs[w.id];
      this.actions._forgetWin(w.id);
      if (handle) {
        try {
          handle.close('close');
        } catch {}
      }
      let open = this.actions.openAppsList();
      if (this.state.recentsOpen) {
        if (!open.length) this.state.recentsOpen = false;
        else if (this.state.recentsIndex >= open.length) {
          this.state.recentsIndex = open.length - 1;
        }
      }
    },

    minimizeApp: (id) => {
      let w = this.actions.win(id);
      if (!w) return;
      w.minimized = true;
      if (this.state.activeApp === w.id) this.state.activeApp = null;
      try {
        this._dialogs[w.id]?.el?.classList?.add('hidden');
      } catch {}
      this.actions.syncOpenWindows();
    },

    toggleMaximize: (id) => {
      let w = this.actions.win(id);
      if (!w || this.state.phoneMode) return;
      w.maximized = !w.maximized;
      this.actions.focusApp(w.id);
      this.actions.syncFrame(w.id);
    },

    focusApp: (id) => {
      let w = this.actions.win(id);
      if (!w) return;
      w.minimized = false;
      try {
        this._dialogs[w.id]?.el?.classList?.remove('hidden');
      } catch {}
      if (this.state.activeApp !== w.id || w.z !== this.state.zTop) {
        this.state.zTop += 1;
        w.z = this.state.zTop;
      }
      this.state.activeApp = w.id;
      this.state.recentsOpen = false;
      this.actions.syncFrame(w.id);
      this.actions.syncOpenWindows();
    },

    /** Is this window visible and on top? */
    isWinActive: (id) => {
      let w = this.actions.win(id);
      return !!w && !w.minimized && this.state.activeApp === w.id;
    },

    taskbarClick: (id) => {
      let w = this.state.wins[id];
      if (!w) {
        if (this.state.apps[id]) this.actions.openApp(id);
        return;
      }
      if (w.minimized) {
        this.actions.focusApp(w.id);
        return;
      }
      if (this.state.activeApp === w.id) this.actions.minimizeApp(w.id);
      else this.actions.focusApp(w.id);
    },

    /** In-app back navigation. Returns true if handled. */
    appBack: (id) => {
      let w = this.actions.win(id);
      if (!w) return false;
      if (w.appId === 'relay' && state.relay?.active) {
        post('relay.select', null);
        return true;
      }
      if (w.appId === 'mail' && (state.mail?.selected || state.mail?.composing)) {
        post('mail.back');
        return true;
      }
      if (w.appId === 'explorer') {
        let ctrl = this.actions.instance(w.id);
        if (ctrl && String(ctrl.state.cwd || '').replace(/^\/+|\/+$/g, '')) {
          ctrl.actions.goUp().then(() => d.update());
          return true;
        }
      }
      return false;
    },

    navBack: () => {
      if (this.state.shadePhase !== 'closed') {
        this.actions.closeShade();
        return;
      }
      if (this.state.recentsOpen) {
        this.state.recentsOpen = false;
        return;
      }
      let id = this.state.activeApp;
      if (!id) return;
      if (this.actions.appBack(id)) return;
      this.actions.minimizeApp(id);
    },

    navHome: () => {
      this.actions.closeShade();
      this.state.recentsOpen = false;
      for (let w of Object.values(this.state.wins)) {
        if (!w.minimized) this.actions.minimizeApp(w.id);
      }
      this.state.activeApp = null;
    },

    navRecents: () => {
      let open = this.actions.openAppsList();
      if (!open.length) {
        this.state.recentsOpen = false;
        this.state.recentsCurrentId = null;
        return;
      }
      if (this.state.recentsOpen) {
        this.state.recentsOpen = false;
        return;
      }
      let idx = open.findIndex((w) => w.id === this.state.activeApp);
      this.state.recentsIndex = idx >= 0 ? idx : open.length - 1;
      this.state.recentsOpen = true;
      this.actions.syncRecentsCurrent();
    },

    recentsSelect: (id) => {
      this.state.recentsOpen = false;
      this.actions.focusApp(id);
    },

    recentsCloseCurrent: () => {
      let w = this.actions.currentRecentsApp();
      if (!w) {
        this.state.recentsOpen = false;
        return;
      }
      this.actions.closeApp(w.id);
      let open = this.actions.openAppsList();
      if (!open.length) {
        this.state.recentsOpen = false;
        this.state.recentsCurrentId = null;
        return;
      }
      this.actions.syncRecentsCurrent();
    },

    recentsStep: (delta) => {
      let open = this.actions.openAppsList();
      if (open.length < 2) return;
      this.state.recentsIndex =
        (((this.state.recentsIndex + delta) % open.length) + open.length) %
        open.length;
      this.actions.syncRecentsCurrent();
    },

    recentsPointerDown: (ev) => {
      let e = ev || event;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      this.state._recentsGesture = {
        x: e.clientX,
        y: e.clientY,
        dx: 0,
        dy: 0,
        moved: false,
      };
      window.addEventListener('pointermove', this._onRecentsMove);
      window.addEventListener('pointerup', this._onRecentsUp);
    },

    syncFrame: (id) => {
      let w = this.actions.win(id);
      if (!w) return;
      let z = 'z-[' + w.z + ']';
      if (this.state.phoneMode) {
        // Fullscreen activity between status bar (top-7) and nav bar (bottom-14)
        w.frameClass =
          'absolute ' +
          z +
          ' left-0 right-0 top-7 bottom-14 w-auto h-auto max-w-none max-h-none rounded-none border-0 shadow-none';
      } else if (w.maximized) {
        w.frameClass =
          'absolute ' + z + ' left-0 top-0 w-full h-[calc(100%-3.25rem)] rounded-none';
      } else {
        w.frameClass =
          'absolute ' +
          z +
          ' left-[' +
          Math.round(w.x) +
          'px] top-[' +
          Math.round(w.y) +
          'px] w-[' +
          Math.round(w.w) +
          'px] h-[' +
          Math.round(w.h) +
          'px] rounded-2xl';
      }
      // Single-window apps bind state.desktop.apps.<id>.frameClass.
      let app = this.state.apps[w.appId];
      if (app && w.id === app.id) app.frameClass = w.frameClass;
    },

    applyGeometry: (id) => {
      this.actions.syncFrame(id);
    },

    startDrag: (id, ev) => {
      let w = this.actions.win(id);
      if (!w || w.maximized || this.state.phoneMode) return;
      let e = ev || event;
      if (e.button != null && e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest('button, input, select, textarea')) return;
      e.preventDefault();
      this.actions.focusApp(w.id);
      this.state._drag = {
        mode: 'move',
        id: w.id,
        ox: e.clientX,
        oy: e.clientY,
        sx: w.x,
        sy: w.y,
      };
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
    },

    startResize: (id, edge, ev) => {
      let w = this.actions.win(id);
      if (!w || w.maximized || this.state.phoneMode) return;
      // Allow post('desktop.startResize', id, event) or (id, 'se', event)
      if (edge && typeof edge === 'object' && 'clientX' in edge) {
        ev = edge;
        edge = 'se';
      }
      let e = ev || event;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.actions.focusApp(w.id);
      // edge: 'e' | 's' | 'se' — width and height change independently
      this.state._drag = {
        mode: 'resize',
        edge: edge || 'se',
        id: w.id,
        ox: e.clientX,
        oy: e.clientY,
        sw: w.w,
        sh: w.h,
      };
      window.addEventListener('pointermove', this._onPointerMove);
      window.addEventListener('pointerup', this._onPointerUp);
    },

    /* ---------- unread badges & notifications ---------- */

    setUnread: (appId, n) => {
      let next = Math.max(0, Number(n) || 0);
      let prev = this.state.unread[appId] || 0;
      this.state.unread = { ...this.state.unread, [appId]: next };
      if (prev && !next) this.actions.clearAppNotifications(appId);
    },

    /**
     * Push a bottom-right toast.
     * n: { appId, title, text, image?, imageOwned?, target? }
     * `image` is a URL shown as one square cover thumbnail; with imageOwned the
     * object URL is revoked when the toast goes away.
     */
    notify: (n) => {
      let app = this.state.apps[n.appId] || {};
      let id = 'n' + ++this._notifSeq;
      let item = {
        id,
        appId: n.appId,
        icon: n.icon || app.icon || 'nf-md-bell',
        accentTw: n.accentTw || app.accentTw || 'bg-emerald-500',
        appTitle: app.title || '',
        title: n.title || app.title || 'Tehboxen',
        text: n.text || '',
        image: n.image || '',
        imageOwned: !!n.imageOwned,
        target: n.target ?? null,
        time: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
      };
      // Phone heads-up shows one banner at a time; older ones stay in the shade.
      if (this.state.phoneMode) this.actions._clearToasts();
      this.state.notifications = [...this.state.notifications, item];
      while (this.state.notifications.length > 4) {
        this.actions.dismissNotification(this.state.notifications[0].id);
      }
      this._notifTimers[id] = setTimeout(() => {
        this.actions.dismissNotification(id);
        d.update();
      }, 7000);
      return id;
    },

    dismissNotification: (id) => {
      let item = this.state.notifications.find((x) => x.id === id);
      if (!item) return;
      clearTimeout(this._notifTimers[id]);
      delete this._notifTimers[id];
      this.state.notifications = this.state.notifications.filter((x) => x.id !== id);
      this.actions._releaseNotification(item);
    },

    /** Revoke an owned image once the item is gone from both toasts and shade. */
    _releaseNotification: (item) => {
      if (!item.imageOwned || !item.image) return;
      if (this.state.notifications.some((x) => x.id === item.id)) return;
      if (this.state.shade.some((x) => x.id === item.id)) return;
      try {
        URL.revokeObjectURL(item.image);
      } catch {}
    },

    _syncShade: () => {
      let seen = new Set();
      let icons = [];
      for (let n of this.state.shade) {
        if (seen.has(n.appId)) continue;
        seen.add(n.appId);
        icons.push({ appId: n.appId, icon: n.icon });
      }
      this.state.shadeIcons = icons.slice(0, 4);
    },

    _clearToasts: () => {
      for (let n of [...this.state.notifications]) this.actions.dismissNotification(n.id);
    },

    /**
     * Apps publish what is still unread; the shade mirrors it (like Android,
     * a conversation's notification stays until it is read or swiped away).
     * entries: [{ key, title, text, image?, target?, ts? }]
     */
    syncAppNotifications: (appId, entries = []) => {
      let app = this.state.apps[appId] || {};
      let live = new Set();
      let mine = entries.map((e) => {
        let id = appId + ':' + e.key;
        live.add(id);
        return {
          id,
          appId,
          icon: e.icon || app.icon || 'nf-md-bell',
          accentTw: e.accentTw || app.accentTw || 'bg-emerald-500',
          appTitle: app.title || '',
          title: e.title || app.title || 'Tehboxen',
          text: e.text || '',
          image: e.image || '',
          target: e.target ?? null,
          ts: e.ts || 0,
          time: e.ts ? new Date(e.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '',
          sig: [e.title, e.text, e.ts].join('|'),
        };
      });
      // Forget swipes for entries that went away (read), so they can return.
      for (let id of Object.keys(this._shadeDismissed)) {
        if (id.startsWith(appId + ':') && !live.has(id)) delete this._shadeDismissed[id];
      }
      this._shadeEntries[appId] = mine;
      this.actions._rebuildShade();
    },

    _rebuildShade: () => {
      this.state.shade = Object.values(this._shadeEntries)
        .flat()
        .filter((n) => this._shadeDismissed[n.id] !== n.sig)
        .sort((a, b) => b.ts - a.ts);
      this.actions._syncShade();
      if (!this.state.shade.length && this.state.shadePhase === 'open') this.actions.closeShade();
    },

    /** Swipe away / clear: hidden until that conversation changes. */
    removeFromShade: (id) => {
      let item = this.state.shade.find((x) => x.id === id);
      if (!item) return;
      this._shadeDismissed[id] = item.sig;
      this.actions._rebuildShade();
    },

    /** Apps cancel their pop-ups once everything has been read. */
    clearAppNotifications: (appId) => {
      for (let n of this.state.notifications.filter((x) => x.appId === appId)) this.actions.dismissNotification(n.id);
    },

    clearShade: () => {
      for (let n of [...this.state.shade]) this.actions.removeFromShade(n.id);
      this.actions.closeShade();
    },

    /* ---------- phone notification shade ---------- */

    _setShadePull: (px) => {
      document.documentElement.style.setProperty('--shade-pull', Math.max(0, px) + 'px');
    },

    openShade: () => {
      if (this.state.shadePhase === 'open') return;
      this.state.recentsOpen = false;
      this.actions._clearToasts();
      // Mount at the pulled-up position, then let the transition slide it in.
      this.actions._setShadePull(0);
      this.state.shadePhase = 'drag';
      d.update();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (this.state.shadePhase !== 'drag') return;
          this.state.shadePhase = 'open';
          d.update();
        }),
      );
    },

    closeShade: () => {
      if (this.state.shadePhase === 'closed' || this.state.shadePhase === 'closing') return;
      this.state.shadePhase = 'closing';
      clearTimeout(this._shadeTimer);
      this._shadeTimer = setTimeout(() => {
        if (this.state.shadePhase !== 'closing') return;
        this.state.shadePhase = 'closed';
        d.update();
      }, 220);
    },

    /** Status bar: tap or pull down to open the shade. */
    statusPointerDown: (ev) => {
      let e = ev || event;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      this._shadeGesture = { kind: 'open', y: e.clientY, dy: 0 };
      window.addEventListener('pointermove', this._onShadeMove);
      window.addEventListener('pointerup', this._onShadeUp);
      window.addEventListener('pointercancel', this._onShadeUp);
    },

    /** Shade handle: drag up to close. */
    shadeHandlePointerDown: (ev) => {
      let e = ev || event;
      if (e.button != null && e.button !== 0) return;
      e.preventDefault();
      this._shadeGesture = { kind: 'close', y: e.clientY, dy: 0 };
      window.addEventListener('pointermove', this._onShadeMove);
      window.addEventListener('pointerup', this._onShadeUp);
      window.addEventListener('pointercancel', this._onShadeUp);
    },

    /**
     * Notification card swipe (heads-up or shade): tap opens, sideways swipe
     * dismisses; heads-up also dismisses on swipe up (stays in the shade).
     */
    cardPointerDown: (ev, id, where) => {
      let e = ev || event;
      if (e.button != null && e.button !== 0) return;
      if (e.target?.closest?.('button')) return;
      let el = e.currentTarget;
      this._cardGesture = { el, id, where, x: e.clientX, y: e.clientY, dx: 0, dy: 0, moved: false };
      el.classList.remove('transition-all');
      window.addEventListener('pointermove', this._onCardMove);
      window.addEventListener('pointerup', this._onCardUp);
      window.addEventListener('pointercancel', this._onCardUp);
    },

    openShadeNotification: async (id) => {
      let item = this.state.shade.find((x) => x.id === id);
      if (!item) return;
      this.actions.removeFromShade(id);
      this.actions.closeShade();
      this.actions.dismissNotification(id);
      this.actions.openApp(item.appId);
      let ctrl = { relay: 'relay', mail: 'mail' }[item.appId];
      if (ctrl && item.target != null) await post(ctrl + '.openTarget', item.target);
    },

    /** Click on a toast: open the app at the conversation / mail it is about. */
    openNotification: async (id) => {
      let item = this.state.notifications.find((x) => x.id === id);
      if (!item) return;
      this.actions.dismissNotification(id);
      this.actions.removeFromShade(id);
      this.actions.openApp(item.appId);
      let ctrl = { relay: 'relay', mail: 'mail' }[item.appId];
      if (ctrl && item.target != null) await post(ctrl + '.openTarget', item.target);
    },
  };

  _instances = {};
  _seq = 0;
  _notifSeq = 0;
  _notifTimers = {};

  _onPointerMove = (e) => {
    let drag = this.state._drag;
    if (!drag) return;
    let w = this.state.wins[drag.id];
    if (!w) return;
    if (drag.mode === 'move') {
      let nx = drag.sx + (e.clientX - drag.ox);
      let ny = drag.sy + (e.clientY - drag.oy);
      let maxX = Math.max(0, window.innerWidth - 80);
      let maxY = Math.max(0, window.innerHeight - 100);
      w.x = Math.min(Math.max(-40, nx), maxX);
      w.y = Math.min(Math.max(0, ny), maxY);
    } else if (drag.mode === 'resize') {
      let edge = drag.edge || 'se';
      let dx = e.clientX - drag.ox;
      let dy = e.clientY - drag.oy;
      if (edge === 'e' || edge === 'se') w.w = Math.max(360, drag.sw + dx);
      if (edge === 's' || edge === 'se') w.h = Math.max(280, drag.sh + dy);
    }
    this.actions.syncFrame(drag.id);
    d.update();
  };

  _onPointerUp = () => {
    this.state._drag = null;
    window.removeEventListener('pointermove', this._onPointerMove);
    window.removeEventListener('pointerup', this._onPointerUp);
    d.update();
  };

  _shadeEntries = {};
  _shadeDismissed = {};
  _shadeGesture = null;
  _cardGesture = null;
  _shadeTimer = null;

  _shadeHeight = () =>
    document.querySelector('[data-shade-panel]')?.getBoundingClientRect().height || 480;

  _onShadeMove = (e) => {
    let g = this._shadeGesture;
    if (!g) return;
    g.dy = e.clientY - g.y;
    if (g.kind === 'open') {
      if (g.dy > 8 && this.state.shadePhase !== 'drag') {
        this.state.recentsOpen = false;
        this.actions._clearToasts();
        this.state.shadePhase = 'drag';
        d.update();
      }
      this.actions._setShadePull(g.dy);
    } else {
      if (g.dy < -8 && this.state.shadePhase !== 'drag') {
        this.state.shadePhase = 'drag';
        d.update();
      }
      this.actions._setShadePull(this._shadeHeight() + Math.min(0, g.dy));
    }
  };

  _onShadeUp = () => {
    let g = this._shadeGesture;
    this._shadeGesture = null;
    window.removeEventListener('pointermove', this._onShadeMove);
    window.removeEventListener('pointerup', this._onShadeUp);
    window.removeEventListener('pointercancel', this._onShadeUp);
    if (!g) return;
    if (g.kind === 'open') {
      // Tap, or pulled far enough: open; otherwise snap back closed.
      if (Math.abs(g.dy) < 8 || g.dy > 60) {
        if (this.state.shadePhase === 'drag') {
          this.state.shadePhase = 'open';
          d.update();
        } else this.actions.openShade();
      } else {
        this.state.shadePhase = 'open';
        this.actions.closeShade();
        d.update();
      }
    } else {
      if (Math.abs(g.dy) < 8) this.actions.closeShade();
      else if (g.dy < -60) {
        this.state.shadePhase = 'open';
        this.actions.closeShade();
      } else this.state.shadePhase = 'open';
      d.update();
    }
  };

  _onCardMove = (e) => {
    let g = this._cardGesture;
    if (!g) return;
    g.dx = e.clientX - g.x;
    g.dy = e.clientY - g.y;
    if (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8) g.moved = true;
    if (!g.moved) return;
    let up = g.where === 'heads' && g.dy < 0 && Math.abs(g.dy) > Math.abs(g.dx);
    g.el.style.transform = up ? 'translateY(' + g.dy + 'px)' : 'translateX(' + g.dx + 'px)';
    g.el.style.opacity = String(1 - Math.min(0.8, Math.abs(up ? g.dy : g.dx) / 300));
  };

  _onCardUp = () => {
    let g = this._cardGesture;
    this._cardGesture = null;
    window.removeEventListener('pointermove', this._onCardMove);
    window.removeEventListener('pointerup', this._onCardUp);
    window.removeEventListener('pointercancel', this._onCardUp);
    if (!g) return;
    let el = g.el;
    el.classList.add('transition-all');
    if (!g.moved) {
      if (g.where === 'heads') this.actions.openNotification(g.id).then(() => d.update());
      else this.actions.openShadeNotification(g.id).then(() => d.update());
      d.update();
      return;
    }
    let up = g.where === 'heads' && g.dy < -40 && Math.abs(g.dy) > Math.abs(g.dx);
    let side = Math.abs(g.dx) > 90 && Math.abs(g.dx) >= Math.abs(g.dy);
    if (!up && !side) {
      el.style.transform = '';
      el.style.opacity = '';
      return;
    }
    el.style.transform = up ? 'translateY(-120%)' : 'translateX(' + (g.dx > 0 ? 120 : -120) + '%)';
    el.style.opacity = '0';
    setTimeout(() => {
      el.style.transform = '';
      el.style.opacity = '';
      // Heads-up swipes only hide the banner; shade swipes dismiss for good.
      if (g.where === 'heads') this.actions.dismissNotification(g.id);
      else this.actions.removeFromShade(g.id);
      d.update();
    }, 180);
  };

  _onRecentsMove = (e) => {
    let g = this.state._recentsGesture;
    if (!g) return;
    g.dx = e.clientX - g.x;
    g.dy = e.clientY - g.y;
    if (Math.abs(g.dx) > 8 || Math.abs(g.dy) > 8) g.moved = true;
  };

  _onRecentsUp = () => {
    let g = this.state._recentsGesture;
    this.state._recentsGesture = null;
    window.removeEventListener('pointermove', this._onRecentsMove);
    window.removeEventListener('pointerup', this._onRecentsUp);
    if (!g) return;
    let ax = Math.abs(g.dx);
    let ay = Math.abs(g.dy);
    if (!g.moved || (ax < 40 && ay < 40)) {
      // tap — open current card
      let app = this.actions.currentRecentsApp();
      if (app) this.actions.recentsSelect(app.id);
      d.update();
      return;
    }
    if (ay > ax && g.dy < -56) {
      this.actions.recentsCloseCurrent();
      d.update();
      return;
    }
    if (ax >= ay && ax > 48) {
      this.actions.recentsStep(g.dx < 0 ? 1 : -1);
      d.update();
    }
  };
}
