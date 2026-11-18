import { PLAYER, PLAYER_HOME } from '../other/session.js';
import * as vfs from '../other/vfs.js';
import { startPathDrag, endPathDrag, draggedPaths, isPathDrag } from '../other/dnd.js';
import { canThumb, getThumb, dropThumb } from '../other/thumbs.js';

function joinCwd(cwd, name) {
  let n = String(name || '').replace(/^\/+/, '');
  if (!n || n.includes('..')) throw new Error('Invalid name');
  return cwd ? cwd + '/' + n : n;
}

function basename(path) {
  return String(path || '').split('/').filter(Boolean).pop() || '';
}

function dirname(path) {
  let parts = String(path || '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

let VIEW_KEY = 'tehboxen.explorer.view';

/**
 * Explorer window controller. Each Explorer window builds its own instance
 * (components/Explorer.js); the one Webfoundry creates as state.explorer is
 * unused.
 */
export default class Explorer {
  state = {
    cwd: PLAYER_HOME,
    entries: [],
    /** path → true */
    selected: {},
    anchor: null,
    error: '',
    newName: '',
    /** null | 'cwd' | 'dir:<path>' while dragging over this window */
    dragOver: null,
    view: 'grid',
    /** path → thumbnail URL (grid view) */
    thumbs: {},
  };

  _unsub = null;
  _dragDepth = 0;
  _refreshTimer = null;

  init(props = {}) {
    if (props.cwd != null) this.state.cwd = String(props.cwd).replace(/^\/+|\/+$/g, '');
    try {
      let v = localStorage.getItem(VIEW_KEY);
      if (v === 'grid' || v === 'list') this.state.view = v;
    } catch {}
  }

  actions = {
    onAttach: async () => {
      await post('vfs.init');
      if (!this._unsub) {
        this._unsub = vfs.onChange((ev) => {
          if (ev?.path) dropThumb(ev.path);
          // Batch bursts of writes (extracts, moves) into one refresh.
          clearTimeout(this._refreshTimer);
          this._refreshTimer = setTimeout(async () => {
            await this.actions.refresh();
            d.update();
          }, 60);
        });
      }
      await this.actions.refresh();
    },

    onDetach: () => {
      if (this._unsub) {
        this._unsub();
        this._unsub = null;
      }
      clearTimeout(this._refreshTimer);
      this._dragDepth = 0;
      this.state.dragOver = null;
    },

    refresh: async () => {
      try {
        this.state.error = '';
        this.state.entries = await post('vfs.listDir', this.state.cwd);
      } catch (err) {
        this.state.error = String(err?.message || err);
        this.state.entries = [];
      }
      let live = new Set(this.state.entries.map((e) => e.path));
      let sel = {};
      for (let p of Object.keys(this.state.selected)) if (live.has(p)) sel[p] = true;
      this.state.selected = sel;
      let name = basename(this.state.cwd) || '/';
      post('desktop.setWinTitle', this.winId, 'Explorer · ' + name, 'Explorer — /' + this.state.cwd);
      this.actions.loadThumbs();
    },

    loadThumbs: () => {
      if (this.state.view !== 'grid') return;
      let thumbs = {};
      for (let e of this.state.entries) {
        if (e.isDir || !canThumb(e.name)) continue;
        if (this.state.thumbs[e.path]) thumbs[e.path] = this.state.thumbs[e.path];
        getThumb(e.path, e.mtime).then((url) => {
          if (!url || this.state.thumbs[e.path] === url) return;
          this.state.thumbs = { ...this.state.thumbs, [e.path]: url };
          d.update();
        });
      }
      this.state.thumbs = thumbs;
    },

    setView: (view) => {
      this.state.view = view === 'grid' ? 'grid' : 'list';
      try {
        localStorage.setItem(VIEW_KEY, this.state.view);
      } catch {}
      this.actions.loadThumbs();
    },

    cd: async (path) => {
      this.state.cwd = String(path || '').replace(/^\/+|\/+$/g, '');
      this.state.selected = {};
      this.state.anchor = null;
      await this.actions.refresh();
    },

    goUp: async () => {
      await this.actions.cd(dirname(this.state.cwd));
    },

    openEntry: async (path, isDir) => {
      if (isDir) {
        await this.actions.cd(path);
        return;
      }
      this.state.selected = { [path]: true };
      this.state.anchor = path;
      try {
        await post('vfs.openPath', path);
      } catch (err) {
        this.state.error = String(err?.message || err);
      }
    },

    selectedPaths: () => Object.keys(this.state.selected).filter((k) => this.state.selected[k]),

    /** Click: select one. Ctrl/Cmd: toggle. Shift: range from the anchor. */
    clickEntry: (path, ev) => {
      let e = ev || {};
      if (e.shiftKey && this.state.anchor) {
        let paths = this.state.entries.map((x) => x.path);
        let a = paths.indexOf(this.state.anchor);
        let b = paths.indexOf(path);
        if (a >= 0 && b >= 0) {
          let [lo, hi] = a < b ? [a, b] : [b, a];
          let next = e.ctrlKey || e.metaKey ? { ...this.state.selected } : {};
          for (let p of paths.slice(lo, hi + 1)) next[p] = true;
          this.state.selected = next;
          return;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        let next = { ...this.state.selected };
        if (next[path]) delete next[path];
        else next[path] = true;
        this.state.selected = next;
        this.state.anchor = path;
        return;
      }
      this.state.selected = { [path]: true };
      this.state.anchor = path;
    },

    /** Click on empty space clears the selection. */
    clickBackground: (ev) => {
      let e = ev || {};
      if (e.target?.closest?.('[data-entry]')) return;
      if (e.ctrlKey || e.metaKey || e.shiftKey) return;
      this.state.selected = {};
    },

    selectAll: () => {
      let next = {};
      for (let e of this.state.entries) next[e.path] = true;
      this.state.selected = next;
    },

    keydown: async (ev) => {
      let e = ev || {};
      if (e.target?.closest?.('input, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        this.actions.selectAll();
      } else if (e.key === 'Delete') {
        await this.actions.removeSelected();
      } else if (e.key === 'Backspace') {
        await this.actions.goUp();
      } else if (e.key === 'Enter') {
        let paths = this.actions.selectedPaths();
        if (paths.length === 1) {
          let entry = this.state.entries.find((x) => x.path === paths[0]);
          if (entry) await this.actions.openEntry(entry.path, entry.isDir);
        }
      }
    },

    newFolder: async () => {
      let name = (this.state.newName || '').trim() || 'folder';
      let keep = joinCwd(this.state.cwd, name) + '/.keep';
      await vfs.withLock(keep, (lease) => vfs.write(keep, '', { lease }), {
        mode: 'w',
        actor: 'ui:explorer',
      });
      this.state.newName = '';
    },

    newFile: async () => {
      let name = (this.state.newName || '').trim() || 'untitled.yaml';
      let path = joinCwd(this.state.cwd, name);
      if (!(await vfs.exists(path))) {
        await vfs.withLock(path, (lease) => vfs.write(path, '', { lease }), {
          mode: 'w',
          actor: 'ui:explorer',
        });
      }
      this.state.newName = '';
      try {
        await post('vfs.openPath', path);
      } catch (err) {
        this.state.error = String(err?.message || err);
      }
    },

    removeSelected: async () => {
      let paths = this.actions.selectedPaths();
      if (!paths.length) return;
      try {
        for (let path of paths) {
          let entry = this.state.entries.find((e) => e.path === path);
          let target = entry?.isDir ? path + '/' : path;
          await vfs.withLock(path, (lease) => vfs.remove(target, { lease }), {
            mode: 'w',
            actor: 'ui:explorer',
          });
        }
        this.state.selected = {};
      } catch (err) {
        this.state.error = String(err?.message || err);
      }
    },

    /** Pick files from the host OS and write them into cwd. */
    uploadFromHost: async () => {
      let input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      input.className = 'hidden';
      let files = await new Promise((resolve) => {
        input.addEventListener('change', () => resolve(input.files));
        input.addEventListener('cancel', () => resolve(null));
        document.body.append(input);
        input.click();
      });
      input.remove();
      if (!files || !files.length) return;
      await this.actions._ingestHostFiles(files, this.state.cwd);
    },

    _ingestHostFiles: async (fileList, destDir) => {
      let dir = String(destDir || '').replace(/^\/+|\/+$/g, '');
      try {
        this.state.error = '';
        if (dir && !(await vfs.isDirectory(dir))) {
          let keep = dir + '/.keep';
          await vfs.withLock(keep, (lease) => vfs.write(keep, '', { lease }), {
            mode: 'w',
            actor: 'ui:explorer',
          });
        }
        for (let f of fileList) {
          if (!f || !f.name) continue;
          let dest = joinCwd(dir, f.name);
          await vfs.withLock(
            dest,
            (lease) =>
              vfs.writeBlob(dest, f, f.type || 'application/octet-stream', { lease }),
            { mode: 'w', actor: 'ui:explorer' },
          );
        }
      } catch (err) {
        this.state.error = String(err?.message || err);
      } finally {
        this.state.dragOver = null;
        this._dragDepth = 0;
      }
    },

    /** Move (default) or copy (Ctrl held) VFS paths into destDir. */
    _transfer: async (paths, destDir, copy) => {
      let dir = String(destDir || '').replace(/^\/+|\/+$/g, '');
      this.state.error = '';
      let done = 0;
      for (let src of paths) {
        let dest = joinCwd(dir, basename(src));
        if (dest === src) continue;
        if (dir === src || dir.startsWith(src + '/')) {
          this.state.error = 'Cannot put a folder inside itself';
          continue;
        }
        try {
          if (await vfs.exists(dest)) {
            this.state.error = basename(src) + ' already exists in /' + dir;
            continue;
          }
          await vfs.withLocks(
            [src, dest],
            async (leases) => {
              if (copy) {
                await vfs.copy(src, dest, {
                  srcLease: leases[src],
                  lease: leases[dest],
                });
              } else {
                await vfs.move(src, dest, {
                  srcLease: leases[src],
                  lease: leases[dest],
                });
              }
            },
            { mode: 'w', actor: 'ui:explorer' },
          );
          done++;
        } catch (err) {
          this.state.error = String(err?.message || err);
        }
      }
      return done;
    },

    /* ----- drag sources ----- */

    dragStart: (path, ev) => {
      let e = ev || event;
      if (!this.state.selected[path]) {
        this.state.selected = { [path]: true };
        this.state.anchor = path;
      }
      startPathDrag(e, this.actions.selectedPaths(), this.winId);
    },

    dragEnd: () => {
      endPathDrag();
      this._dragDepth = 0;
      this.state.dragOver = null;
    },

    /* ----- drop targets ----- */

    _effect: (e) => {
      let internal = isPathDrag(e);
      try {
        e.dataTransfer.dropEffect = internal ? (e.ctrlKey || e.metaKey ? 'copy' : 'move') : 'copy';
      } catch {}
      return internal;
    },

    dragEnterList: (ev) => {
      let e = ev || event;
      e.preventDefault();
      this._dragDepth += 1;
      if (!String(this.state.dragOver || '').startsWith('dir:')) this.state.dragOver = 'cwd';
    },

    dragOverList: (ev) => {
      let e = ev || event;
      e.preventDefault();
      this.actions._effect(e);
      this.state.dragOver = 'cwd';
    },

    dragLeaveList: () => {
      this._dragDepth = Math.max(0, this._dragDepth - 1);
      if (this._dragDepth === 0) this.state.dragOver = null;
    },

    dropOnList: async (ev) => {
      await this.actions._drop(ev || event, this.state.cwd, false);
    },

    dragOverDir: (path, ev) => {
      let e = ev || event;
      e.preventDefault();
      e.stopPropagation();
      this.actions._effect(e);
      this.state.dragOver = 'dir:' + path;
    },

    dropOnDir: async (path, ev) => {
      let e = ev || event;
      e.stopPropagation();
      await this.actions._drop(e, path, true);
    },

    _drop: async (e, dest, ontoDir) => {
      e.preventDefault();
      this._dragDepth = 0;
      this.state.dragOver = null;
      let internal = draggedPaths(e);
      let copy = !!(e.ctrlKey || e.metaKey);
      if (internal) {
        endPathDrag();
        // Dropping a selection onto one of its own folders is a no-op.
        if (ontoDir && internal.paths.includes(dest)) return;
        await this.actions._transfer(internal.paths, dest, copy);
        return;
      }
      let files = e.dataTransfer?.files;
      if (files && files.length) await this.actions._ingestHostFiles(files, dest);
    },
  };
}
