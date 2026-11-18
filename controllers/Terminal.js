let XTERM_CSS_HREF =
  'https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css';

/**
 * Critical xterm rules. Use !important so Webfoundry / theme textarea
 * min-height utilities cannot reveal the helper textarea.
 */
let XTERM_CSS_INLINE = `
.xterm {
  position: relative !important;
  user-select: none;
  -ms-user-select: none;
  -webkit-user-select: none;
  cursor: text;
  height: 100% !important;
  width: 100% !important;
  min-height: 0 !important;
}
.xterm.focus, .xterm:focus { outline: none; }
/* Defeat Webfoundry :empty { min-height: 1rem } inside the terminal. */
.xterm :where(:empty) {
  min-height: 0 !important;
}
.xterm .xterm-helpers {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  width: 0 !important;
  height: 0 !important;
  min-width: 0 !important;
  min-height: 0 !important;
  max-height: 0 !important;
  overflow: hidden !important;
  z-index: 10;
}
.xterm .xterm-helper-textarea,
.xterm textarea.xterm-helper-textarea,
.xterm textarea {
  /* Keep focusable for keyboard input; only hide visually.
     visibility/pointer-events must stay enabled or xterm stops receiving keys. */
  position: absolute !important;
  left: -9999px !important;
  top: 0 !important;
  width: 0 !important;
  height: 0 !important;
  min-width: 0 !important;
  min-height: 0 !important;
  max-width: 0 !important;
  max-height: 0 !important;
  padding: 0 !important;
  margin: 0 !important;
  border: 0 !important;
  opacity: 0 !important;
  overflow: hidden !important;
  resize: none !important;
  line-height: 0 !important;
  font-size: 0 !important;
  clip: rect(0, 0, 0, 0) !important;
  clip-path: inset(50%) !important;
  caret-color: transparent !important;
  background: transparent !important;
  box-shadow: none !important;
  outline: none !important;
}
.xterm .composition-view {
  background: rgba(26, 27, 38, 0.85);
  color: #c0caf5;
  display: none;
  position: absolute;
  white-space: nowrap;
  z-index: 1;
}
.xterm .composition-view.active { display: block; }
.xterm .xterm-viewport {
  background-color: transparent !important;
  overflow-y: scroll;
  cursor: default;
  position: absolute;
  inset: 0;
  min-height: 0 !important;
}
.xterm .xterm-screen { position: relative; }
.xterm .xterm-screen canvas { position: absolute; left: 0; top: 0; }
.xterm .xterm-scroll-area { visibility: hidden; }
.xterm-char-measure-element {
  display: inline-block;
  visibility: hidden;
  position: absolute;
  top: 0;
  left: -9999em;
  line-height: normal;
}
.xterm.enable-mouse-events { cursor: default; }
.xterm .xterm-rows { position: absolute; left: 0; top: 0; }
.xterm .xterm-rows > div { line-height: inherit; white-space: pre; }
.xterm .xterm-decoration-container { position: absolute; top: 0; left: 0; }
`;

function ensureXtermCss(doc = document) {
  let style = doc.querySelector('style[data-tehboxen-xterm-inline]');
  if (!style) {
    style = doc.createElement('style');
    style.setAttribute('data-tehboxen-xterm-inline', '1');
    doc.head.appendChild(style);
  }
  style.textContent = XTERM_CSS_INLINE;

  if (!doc.querySelector('link[data-tehboxen-xterm]')) {
    let link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = XTERM_CSS_HREF;
    link.setAttribute('data-tehboxen-xterm', '1');
    doc.head.appendChild(link);
  }
}

function hideHelperTextarea(root) {
  let ta = root?.querySelector?.('.xterm-helper-textarea');
  if (!ta) return;
  // Do not set visibility/pointer-events — xterm focuses this node for input.
  let s = ta.style;
  s.setProperty('position', 'absolute', 'important');
  s.setProperty('left', '-9999px', 'important');
  s.setProperty('top', '0', 'important');
  s.setProperty('width', '0', 'important');
  s.setProperty('height', '0', 'important');
  s.setProperty('min-width', '0', 'important');
  s.setProperty('min-height', '0', 'important');
  s.setProperty('max-width', '0', 'important');
  s.setProperty('max-height', '0', 'important');
  s.setProperty('opacity', '0', 'important');
  s.setProperty('overflow', 'hidden', 'important');
  s.setProperty('resize', 'none', 'important');
  s.setProperty('border', '0', 'important');
  s.setProperty('padding', '0', 'important');
  s.setProperty('margin', '0', 'important');
  s.setProperty('font-size', '0', 'important');
  let helpers = root?.querySelector?.('.xterm-helpers');
  if (helpers) {
    let hs = helpers.style;
    hs.setProperty('width', '0', 'important');
    hs.setProperty('height', '0', 'important');
    hs.setProperty('min-height', '0', 'important');
    hs.setProperty('overflow', 'hidden', 'important');
  }
}

function waitFrames(n = 2) {
  return new Promise(resolve => {
    let left = n;
    let step = () => {
      left -= 1;
      if (left <= 0) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Soft-key id → xterm input bytes (no sticky mods). */
let SOFT_KEY_DATA = {
  ESC: '\x1b',
  '/': '/',
  '-': '-',
  HOME: '\x1b[H',
  UP: '\x1b[A',
  END: '\x1b[F',
  PGUP: '\x1b[5~',
  TAB: '\t',
  LEFT: '\x1b[D',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  PGDN: '\x1b[6~',
};

/** Soft-key id → KeyboardEvent key/code/keyCode. */
let SOFT_KEY_EVENT = {
  ESC: { key: 'Escape', code: 'Escape', keyCode: 27 },
  '/': { key: '/', code: 'Slash', keyCode: 191 },
  '-': { key: '-', code: 'Minus', keyCode: 189 },
  HOME: { key: 'Home', code: 'Home', keyCode: 36 },
  UP: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  END: { key: 'End', code: 'End', keyCode: 35 },
  PGUP: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  TAB: { key: 'Tab', code: 'Tab', keyCode: 9 },
  LEFT: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  DOWN: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  RIGHT: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  PGDN: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/**
 * Terminal window controller: only the chrome. It hosts xterm (fit, soft keys,
 * sticky Ctrl/Alt, clipboard) and runs the user's interactive bash
 * (other/bash.js) in it; when bash exits (`exit`, Ctrl-D) the window closes.
 * Each Terminal window builds its own instance (components/Terminal.js).
 */
export default class TerminalCtrl {
  state = {
    attached: false,
    mode: 'shell',
    cwdLabel: '~',
    error: '',
    modCtrl: false,
    modAlt: false,
  };

  _term = null;
  _fit = null;
  _session = null;
  _host = null;
  _mount = null;
  _ro = null;
  _keyHandler = null;
  _stickyCapture = null;
  _closing = false;

  actions = {
    onAttach: async (el) => {
      this.state.error = '';
      this.state.modCtrl = false;
      this.state.modAlt = false;
      await this.actions.onDetach();
      this._closing = false;
      ensureXtermCss(el.ownerDocument || document);
      this._host = el;
      this._host.classList.add('relative', 'h-full', 'w-full', 'min-h-0');
      this._mount = (el.ownerDocument || document).createElement('div');
      this._mount.className = 'absolute inset-0 overflow-hidden min-h-0';
      this._host.replaceChildren(this._mount);
      this._bindStickyCapture();

      try {
        let [{ Terminal }, { FitAddon }, { startInteractiveBash }] = await Promise.all([
          import('https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/+esm'),
          import('https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/+esm'),
          import('../other/bash.js'),
        ]);

        this._term = new Terminal({
          cursorBlink: true,
          cursorStyle: 'block',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: 14,
          lineHeight: 1.2,
          allowTransparency: true,
          theme: {
            background: 'transparent',
            foreground: '#c0caf5',
            cursor: '#50fa7b',
            selectionBackground: '#33467c',
          },
          convertEol: true,
          allowProposedApi: true,
          rightClickSelectsWord: true,
        });
        this._fit = new FitAddon();
        this._term.loadAddon(this._fit);
        this._term.open(this._mount);
        hideHelperTextarea(this._mount);

        this._keyHandler = (ev) => this._onKeyDown(ev);
        this._term.attachCustomKeyEventHandler(this._keyHandler);

        await waitFrames(2);
        this._fitSafe();
        hideHelperTextarea(this._mount);
        this.state.attached = true;

        this._ro = new ResizeObserver(() => {
          this._fitSafe();
          hideHelperTextarea(this._mount);
        });
        this._ro.observe(this._host);

        let term = this._term;
        let session = await startInteractiveBash({
          term,
          onState: (s) => {
            Object.assign(this.state, s);
            d.update();
          },
        });
        if (this._term !== term) {
          // Detached while starting up.
          session.dispose();
          return;
        }
        this._session = session;
        term.focus();
        session.done.then(() => {
          if (this._session !== session || this._closing) return;
          this._closing = true;
          post('desktop.closeApp', this.winId || 'terminal');
        });
      } catch (err) {
        this.state.error = String(err?.message || err);
        console.error('Terminal attach failed', err);
        if (this._mount) this._mount.textContent = 'Terminal failed to load: ' + this.state.error;
        d.update();
      }
    },

    onDetach: async () => {
      this._unbindStickyCapture();
      let session = this._session;
      this._session = null;
      try {
        await session?.dispose();
      } catch {}
      this._keyHandler = null;
      try {
        this._ro?.disconnect();
      } catch {}
      this._ro = null;
      try {
        this._term?.dispose();
      } catch {}
      this._term = null;
      this._fit = null;
      if (this._host) {
        try {
          this._host.replaceChildren();
        } catch {}
      }
      this._mount = null;
      this._host = null;
      this.state.attached = false;
      this.state.mode = 'shell';
      this.state.error = '';
      this.state.modCtrl = false;
      this.state.modAlt = false;
    },

    fit: () => {
      this._fitSafe();
    },

    toggleCtrl: () => {
      this.state.modCtrl = !this.state.modCtrl;
      this._bindStickyCapture();
    },

    toggleAlt: () => {
      this.state.modAlt = !this.state.modAlt;
      this._bindStickyCapture();
    },

    /** Soft-key press from the mobile keybar. */
    pressKey: (name) => {
      let id = String(name || '');
      if (id === 'CTRL') return this.actions.toggleCtrl();
      if (id === 'ALT') return this.actions.toggleAlt();
      let ctrl = !!this.state.modCtrl;
      let alt = !!this.state.modAlt;
      if (ctrl || alt) {
        this.state.modCtrl = false;
        this.state.modAlt = false;
      }
      // Restore terminal focus before synthesizing so the target is the xterm textarea
      try {
        this._term?.focus?.();
      } catch {}
      this._sendSoftKey(id, { ctrl, alt });
    },
  };

  _fitSafe() {
    try {
      if (!this._fit || !this._term || !this._host) return;
      let rect = this._host.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40) return;
      this._fit.fit();
    } catch {}
  }

  /** kitty (a full-screen program) owns the keyboard while it runs. */
  _rawMode() {
    let s = this._session;
    while (s?.child) s = s.child;
    return !!s?.kitty;
  }

  async _pasteFromClipboard() {
    try {
      let text = await navigator.clipboard.readText();
      // Goes through onData like typed input; bash runs complete lines.
      if (text) this._term?.paste(text);
    } catch (err) {
      this._term?.write('\r\n\x1b[31mpaste failed: ' + (err?.message || err) + '\x1b[0m\r\n');
    }
  }

  /** Clipboard shortcuts that belong to the terminal window, not to bash. True when handled. */
  _clipboardKey(low) {
    let sel = this._term?.getSelection?.() || '';
    if (low === 'v') {
      this._pasteFromClipboard();
      return true;
    }
    if ((low === 'c' || low === 'x') && sel) {
      navigator.clipboard.writeText(sel).catch(() => {});
      return true;
    }
    if (low === 'x') {
      // No selection: kill the line, like Ctrl-U.
      this._term?.input('\x15');
      return true;
    }
    return false;
  }

  _bindStickyCapture() {
    if (this._stickyCapture) return;
    this._stickyCapture = (ev) => this._onStickyKeyDown(ev);
    document.addEventListener('keydown', this._stickyCapture, true);
  }

  _unbindStickyCapture() {
    if (!this._stickyCapture) return;
    try {
      document.removeEventListener('keydown', this._stickyCapture, true);
    } catch {}
    this._stickyCapture = null;
  }

  /**
   * When sticky CTRL/ALT are on, intercept the next keydown (capture phase),
   * synthesize a modified event, and feed xterm when the terminal is active.
   */
  _onStickyKeyDown(ev) {
    if (!this.state.modCtrl && !this.state.modAlt) return;
    if (ev.type !== 'keydown') return;
    if (ev.__tehboxenSoft) return;
    let k = ev.key;
    if (k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'Shift') return;
    if (ev.target?.closest?.('[data-term-keybar]')) return;

    ev.preventDefault();
    ev.stopPropagation();
    ev.stopImmediatePropagation?.();

    let ctrl = this.state.modCtrl || ev.ctrlKey;
    let alt = this.state.modAlt || ev.altKey;
    this.state.modCtrl = false;
    this.state.modAlt = false;
    d.update();

    this._dispatchSyntheticKey({ key: ev.key, code: ev.code, keyCode: ev.keyCode || ev.which || 0, ctrl, alt, shift: !!ev.shiftKey, meta: !!ev.metaKey });
  }

  _resolveKeyTarget() {
    let active = document.activeElement;
    if (active && active !== document.body && active !== document.documentElement && !active.closest?.('[data-term-keybar]')) return active;
    let winId = state?.desktop?.activeApp;
    if (winId) {
      let holder = document.querySelector(`[data-win-id="${CSS.escape(winId)}"]`);
      if (holder?.firstElementChild) return holder.firstElementChild;
    }
    return document.querySelector('[data-desktop-root]') || document.body || document.documentElement;
  }

  _terminalIsLiveTarget() {
    if (!this._term || !this.state.attached) return false;
    if (this.winId && state?.desktop?.activeApp === this.winId) return true;
    let active = document.activeElement;
    return !!(active && this._mount && this._mount.contains(active));
  }

  /** Ctrl+letter → ASCII control byte for xterm.input. */
  _ctrlChar(key) {
    if (!key || key.length !== 1) return null;
    let c = key.toLowerCase().charCodeAt(0);
    if (c >= 97 && c <= 122) return String.fromCharCode(c - 96);
    let u = key.toUpperCase().charCodeAt(0);
    if (u >= 64 && u <= 95) return String.fromCharCode(u - 64);
    return null;
  }

  _feedXtermKey({ key, ctrl, alt }) {
    if (!this._term) return false;
    if (ctrl && !alt) {
      if (!this._rawMode() && this._clipboardKey(key.length === 1 ? key.toLowerCase() : key)) return true;
      let ch = this._ctrlChar(key);
      if (ch != null) {
        this._term.input(ch);
        return true;
      }
    }
    let named = null;
    for (let [id, meta] of Object.entries(SOFT_KEY_EVENT)) {
      if (meta.key === key) {
        named = id;
        break;
      }
    }
    if (named && SOFT_KEY_DATA[named] != null) {
      // Alt+key: ESC prefix then the key data (readline-ish meta)
      this._term.input(alt && !ctrl ? '\x1b' + SOFT_KEY_DATA[named] : SOFT_KEY_DATA[named]);
      return true;
    }
    if (key.length === 1) {
      this._term.input(alt && !ctrl ? '\x1b' + key : key);
      return true;
    }
    return false;
  }

  _dispatchSyntheticKey({ key, code, keyCode, ctrl, alt, shift, meta }) {
    let fed = false;
    if (this._terminalIsLiveTarget()) fed = this._feedXtermKey({ key, ctrl, alt, shift });
    let target = this._resolveKeyTarget();
    let init = { key, code: code || key, keyCode: keyCode || 0, which: keyCode || 0, ctrlKey: !!ctrl, altKey: !!alt, shiftKey: !!shift, metaKey: !!meta, bubbles: true, cancelable: true };
    for (let type of ['keydown', 'keypress', 'keyup']) {
      if (type === 'keypress' && key.length !== 1) continue;
      let syn = new KeyboardEvent(type, init);
      try {
        Object.defineProperty(syn, '__tehboxenSoft', { value: true });
      } catch {
        syn.__tehboxenSoft = true;
      }
      target.dispatchEvent(syn);
    }
    return fed;
  }

  _sendSoftKey(id, { ctrl = false, alt = false } = {}) {
    let meta = SOFT_KEY_EVENT[id];
    let data = SOFT_KEY_DATA[id];
    if (!meta && data == null) return;
    if (meta) {
      this._dispatchSyntheticKey({ key: meta.key, code: meta.code, keyCode: meta.keyCode, ctrl, alt, shift: false, meta: false });
      return;
    }
    if (this._terminalIsLiveTarget() && this._term && data != null) this._term.input(data);
  }

  _onKeyDown(ev) {
    if (ev.type !== 'keydown') return true;
    // Soft-key path already called term.input; block xterm's default handling
    if (ev.__tehboxenSoft) return false;
    if (this._rawMode()) return true;

    let stickyCtrl = this.state.modCtrl;
    let stickyAlt = this.state.modAlt;
    let ctrl = ev.ctrlKey || ev.metaKey || stickyCtrl;
    if (!ctrl && !stickyAlt) return true;

    if (stickyCtrl || stickyAlt) {
      this.state.modCtrl = false;
      this.state.modAlt = false;
      d.update();
      ev.preventDefault();
      this._feedXtermKey({ key: ev.key, ctrl: stickyCtrl || ev.ctrlKey || ev.metaKey, alt: stickyAlt || ev.altKey, shift: !!ev.shiftKey });
      return false;
    }

    // Copy / cut / paste are the window's; everything else (Ctrl-C/D/L/U…) goes to bash as bytes.
    let low = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if ((low === 'c' || low === 'x' || low === 'v') && this._clipboardKey(low)) {
      ev.preventDefault();
      return false;
    }
    // Keep the browser from taking Ctrl-D (bookmark), Ctrl-L (address bar), Ctrl-U (view source).
    if (low === 'd' || low === 'l' || low === 'u') {
      ev.preventDefault();
      this._term?.input(this._ctrlChar(low));
      return false;
    }
    return true;
  }
}
