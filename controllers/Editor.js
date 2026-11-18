import { PLAYER, PLAYER_HOME } from '../other/session.js';
import * as vfs from '../other/vfs.js';
import { showFilePicker } from '../other/file-picker.js';

let CM_CSS_INLINE = `
.tehboxen-cm-host, .tehboxen-cm-host .cm-editor { height: 100%; width: 100%; font-size: 13px; }
.tehboxen-cm-host .cm-scroller { overflow: auto !important; }
.tehboxen-cm-host .cm-content { caret-color: #50fa7b; min-height: 100%; }
.tehboxen-ta {
  width: 100%; height: 100%; box-sizing: border-box; resize: none; border: 0; outline: none;
  padding: 12px 14px; background: #1e1e2e; color: #cdd6f4;
  font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
`;

function ensureEditorCss(doc = document) {
  if (doc.querySelector('style[data-tehboxen-cm]')) return;
  let style = doc.createElement('style');
  style.setAttribute('data-tehboxen-cm', '1');
  style.textContent = CM_CSS_INLINE;
  doc.head.appendChild(style);
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

/**
 * Editor window controller. Each Editor window builds its own instance
 * (components/Editor.js); props.openPath picks the file to load.
 */
export default class Editor {
  state = {
    path: '',
    dirty: false,
    status: '',
    ready: false,
    mode: 'codemirror', // codemirror | textarea
  };

  _view = null;
  _ta = null;
  _host = null;
  _mount = null;
  _updating = false;

  init(props = {}) {
    if (props.openPath) this.state.path = String(props.openPath);
    this.actions._syncTitle();
  }

  actions = {
    _syncTitle: () => {
      let name = this.state.path ? this.state.path.split('/').pop() : 'Untitled';
      post(
        'desktop.setWinTitle',
        this.winId,
        'Editor · ' + name + (this.state.dirty ? ' •' : ''),
        this.state.path ? '/' + this.state.path : 'Editor',
      );
    },

    onAttach: async (el) => {
      ensureEditorCss(el.ownerDocument || document);
      this.actions.onDetach();
      this._host = el;
      this._host.classList.add('relative', 'h-full', 'w-full', 'min-h-0');
      this._mount = (el.ownerDocument || document).createElement('div');
      this._mount.className = 'tehboxen-cm-host absolute inset-0 overflow-hidden';
      this._host.replaceChildren(this._mount);

      await waitFrames(2);
      await this.actions._mountEditor();
      if (this.state.path) await this.actions._loadCurrent();
      this.state.ready = true;
      d.update();
    },

    onDetach: () => {
      try {
        this._view?.destroy?.();
      } catch {}
      this._view = null;
      this._ta = null;
      if (this._host) {
        try {
          this._host.replaceChildren();
        } catch {}
      }
      this._mount = null;
      this._host = null;
      this.state.ready = false;
    },

    open: async (path) => {
      this.state.path = String(path || '');
      this.state.dirty = false;
      this.state.status = '';
      if (this._view || this._ta) await this.actions._loadCurrent();
      this.actions._syncTitle();
      d.update();
    },

    /** Open a file from the Tehboxen file picker. */
    openFromSystem: async () => {
      try {
        let start =
          this.state.path && this.state.path.includes('/')
            ? this.state.path.replace(/\/[^/]+$/, '')
            : PLAYER_HOME;
        let path = await showFilePicker({
          title: 'Open file',
          startPath: start || PLAYER_HOME,
          mode: 'file',
          accept: 'text',
        });
        if (!path) return;
        await this.actions.open(path);
        this.state.status = 'Opened';
        d.update();
      } catch (err) {
        console.warn('openFromSystem', err);
        this.state.status = 'Open failed';
        d.update();
      }
    },

    save: async () => {
      if (!this.state.path) return;
      let text = this.actions._getText();
      await vfs.withLock(this.state.path, (lease) => vfs.write(this.state.path, text, { lease }), { mode: 'w', actor: 'ui:editor' });
      this.state.dirty = false;
      this.state.status = 'Saved';
      this.actions._syncTitle();
      d.update();
    },

    _getText: () => {
      if (this._view) return this._view.state.doc.toString();
      if (this._ta) return this._ta.value;
      return '';
    },

    _mountEditor: async () => {
      if (!this._mount) return;
      this._mount.replaceChildren();
      this._view = null;
      this._ta = null;

      try {
        let { EditorView, basicSetup } = await import(
          'https://esm.sh/codemirror@6.0.2'
        );
        let self = this;
        this._view = new EditorView({
          doc: '',
          parent: this._mount,
          extensions: [
            basicSetup,
            EditorView.theme({
              '&': {
                height: '100%',
                width: '100%',
                fontSize: '13px',
                backgroundColor: '#1e1e2e',
                color: '#cdd6f4',
              },
              '.cm-scroller': { overflow: 'auto' },
              '.cm-content': {
                caretColor: '#50fa7b',
                minHeight: '100%',
                fontFamily:
                  'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              },
              '.cm-gutters': {
                backgroundColor: '#181825',
                color: '#6c7086',
                border: 'none',
              },
              '&.cm-focused .cm-cursor': { borderLeftColor: '#50fa7b' },
              '.cm-activeLine': { backgroundColor: '#31324455' },
            }),
            EditorView.updateListener.of(update => {
              if (self._updating) return;
              if (update.docChanged) {
                if (!self.state.dirty) {
                  self.state.dirty = true;
                  self.actions._syncTitle();
                }
                self.state.status = '';
                d.update();
              }
            }),
          ],
        });
        this.state.mode = 'codemirror';
        this._view.focus();
      } catch (err) {
        console.warn('CodeMirror failed, using textarea', err);
        this.actions._mountTextarea();
      }
    },

    _mountTextarea: () => {
      if (!this._mount) return;
      this._mount.replaceChildren();
      let ta = (this._mount.ownerDocument || document).createElement('textarea');
      ta.className = 'tehboxen-ta';
      ta.spellcheck = false;
      ta.addEventListener('input', () => {
        if (this._updating) return;
        if (!this.state.dirty) {
          this.state.dirty = true;
          this.actions._syncTitle();
        }
        this.state.status = '';
        d.update();
      });
      this._mount.appendChild(ta);
      this._ta = ta;
      this.state.mode = 'textarea';
      ta.focus();
    },

    _loadCurrent: async () => {
      if (!this.state.path) return;
      if (!this._view && !this._ta) return;
      let text = (await vfs.withLock(this.state.path, (lease) => vfs.read(this.state.path, { lease }), { mode: 'r', actor: 'ui:editor' })) ?? '';
      this._updating = true;
      try {
        if (this._view) {
          this._view.dispatch({
            changes: {
              from: 0,
              to: this._view.state.doc.length,
              insert: text,
            },
          });
        } else if (this._ta) {
          this._ta.value = text;
        }
      } finally {
        this._updating = false;
      }
      this.state.dirty = false;
      this.state.status = '';
    },
  };
}
