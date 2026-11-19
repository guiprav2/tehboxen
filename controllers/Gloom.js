import { initWebEngine, onWebPage, bootUrl } from '../other/web/engine.js';

/**
 * Gloom, the web browser: window controller (one instance per window, components/Gloom.js). Pages render in
 * an iframe on their in-world origin's own subdomain (other/web/hosts.js), fetched over the
 * player's network by the web engine (other/web/engine.js); this keeps the address bar, history
 * and padlock. The engine's pages report { url, title } as they load.
 */
export default class Gloom {
  state = {
    address: '',
    url: '',
    title: '',
    secure: false,
    loading: false,
    history: [],
    index: -1,
  };

  _frame = null;
  _off = null;
  _pending = null; // URL a back/forward/reload is loading (not a new history entry)

  init(props = {}) {
    initWebEngine();
    this._initial = props.url || '';
    this.actions._syncTitle();
  }

  actions = {
    _syncTitle: () => {
      let t = this.state.title || this.state.url;
      post('desktop.setWinTitle', this.winId, t ? 'Gloom · ' + t : 'Gloom', t || 'Gloom');
    },

    /** The iframe is in the DOM: start listening for its pages, open the initial URL. */
    attachFrame: (el) => {
      this._frame = el;
      this._off?.();
      this._off = onWebPage((win, info) => {
        if (!this._frame || win !== this._frame.contentWindow) return;
        if (info.boot) this._booting = true;
        else this.actions._arrived(info);
        d.update();
      });
      if (this._initial) this.actions.go(this._initial);
    },

    /**
     * The frame finished loading a document. The bootstrap page's load doesn't count; any other
     * (pages that never report: JSON, images, plain text…) ends the loading state.
     */
    frameLoaded: () => {
      if (this._booting) {
        this._booting = false;
        return;
      }
      // Arrived without a report (not HTML): the URL is its own title, and it's a history entry.
      if (this.state.loading) this.actions._arrived({ url: this.state.url, title: this.state.url });
    },

    stop: () => {
      if (this._frame && this.state.loading) this._frame.src = 'about:blank';
      this.state.loading = false;
      this._booting = false;
    },

    detachFrame: () => {
      this._off?.();
      this._off = null;
      this._frame = null;
    },

    _arrived: ({ url, title, error }) => {
      let s = this.state;
      s.loading = false;
      s.url = url;
      s.address = url;
      // The engine's error pages (refused, unreachable, bad certificate) leave the title bar plain.
      s.title = error ? '' : title || url;
      s.secure = url.startsWith('https:');
      if (this._pending === url) this._pending = null;
      else if (s.history[s.index] !== url) {
        s.history = [...s.history.slice(0, s.index + 1), url];
        s.index = s.history.length - 1;
      }
      this.actions._syncTitle();
    },

    _load: (url) => {
      if (!this._frame) return;
      this.state.loading = true;
      this.state.url = url;
      this.state.address = url;
      this.state.secure = url.startsWith('https:');
      try {
        this._frame.src = bootUrl(url);
      } catch (err) {
        this.state.loading = false;
        this.state.title = String(err.message || err);
      }
    },

    /** Navigate to what's typed: a URL, or a host (http:// assumed, like typing in a box's own browser). */
    go: (input) => {
      let text = String(input ?? this.state.address).trim();
      if (!text) return;
      if (!/^[a-z]+:\/\//i.test(text)) text = 'http://' + text;
      let url;
      try {
        url = new URL(text).href;
      } catch {
        this.state.title = 'Invalid address';
        return;
      }
      this._pending = null;
      this.actions._load(url);
    },

    keydown: (ev) => {
      if (ev.key === 'Enter') this.actions.go();
    },

    back: () => {
      let s = this.state;
      if (s.index <= 0) return;
      s.index--;
      this._pending = s.history[s.index];
      this.actions._load(this._pending);
    },

    forward: () => {
      let s = this.state;
      if (s.index >= s.history.length - 1) return;
      s.index++;
      this._pending = s.history[s.index];
      this.actions._load(this._pending);
    },

    reload: () => {
      if (!this.state.url) return;
      this._pending = this.state.url;
      this.actions._load(this.state.url);
    },
  };
}
