import { PLAYER, PLAYER_HOME } from '../other/session.js';
import * as vfs from '../other/vfs.js';
import { appForPath, normalize } from '../other/vfs.js';
import { showDirectoryPicker, showFilePicker } from '../other/file-picker.js';
import { draggedPaths, endPathDrag } from '../other/dnd.js';
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';

function basename(path) {
  let parts = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  return parts[parts.length - 1] || '';
}

function dirname(path) {
  let parts = String(path || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function splitNameExt(name) {
  let n = String(name || '');
  let i = n.lastIndexOf('.');
  if (i <= 0) return { base: n || 'file', ext: '' };
  return { base: n.slice(0, i), ext: n.slice(i + 1) };
}

function uuid() {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  } catch {
    return Math.random().toString(16).slice(2, 14);
  }
}

/**
 * WinZip window controller. Each WinZip window builds its own instance
 * (components/WinZip.js). A window opened without a file starts on an empty
 * "New Archive" that can be filled by dropping files and saved.
 */
export default class WinZip {
  state = {
    /** VFS path of the open archive; '' while it is a New Archive. */
    archivePath: '',
    isNew: true,
    /** Entries were added/removed since the last save or open. */
    dirty: false,
    /** File name used when saving a New Archive. */
    saveName: 'New Archive.zip',
    entries: [],
    selected: {},
    error: '',
    warn: '',
    status: 'Drop files here to add them',
    loading: false,
    dragOver: false,
  };

  _zip = new JSZip();
  _dragDepth = 0;

  init(props = {}) {
    if (props.openPath) this.actions.open(props.openPath);
    else this.actions._syncTitle();
  }

  get title() {
    let s = this.state;
    let name = s.isNew ? 'New Archive' : basename(s.archivePath);
    return name + (s.dirty ? ' •' : '');
  }

  actions = {
    _syncTitle: () => {
      post(
        'desktop.setWinTitle',
        this.winId,
        'WinZip · ' + this.title,
        'WinZip — ' + (this.state.isNew ? 'New Archive' : '/' + this.state.archivePath),
      );
    },

    newArchive: () => {
      this._zip = new JSZip();
      Object.assign(this.state, {
        archivePath: '',
        isNew: true,
        dirty: false,
        entries: [],
        selected: {},
        error: '',
        warn: '',
        status: 'Drop files here to add them',
      });
      this.actions._syncTitle();
    },

    open: async (path) => {
      let p = normalize(path);
      Object.assign(this.state, {
        archivePath: p,
        isNew: false,
        dirty: false,
        selected: {},
        error: '',
        warn: '',
        status: '',
        loading: true,
      });
      this.actions._syncTitle();
      d.update();
      try {
        let blob = await vfs.withLock(
          p,
          (lease) => vfs.readBlob(p, { lease }),
          { mode: 'r', actor: 'ui:winzip' },
        );
        if (!blob) throw new Error('Could not read archive');
        this._zip = await JSZip.loadAsync(blob);
        this.actions._syncEntries();
      } catch (err) {
        this._zip = new JSZip();
        this.state.error = String(err?.message || err);
        this.state.entries = [];
      } finally {
        this.state.loading = false;
      }
    },

    openFromSystem: async () => {
      let path = await showFilePicker({
        title: 'Open archive',
        startPath: dirname(this.state.archivePath) || PLAYER_HOME,
        mode: 'file',
      });
      if (path) await this.actions.open(path);
    },

    _syncEntries: () => {
      let entries = [];
      this._zip.forEach((relativePath, file) => {
        if (!relativePath || file.dir || relativePath.endsWith('/')) return;
        entries.push({
          path: relativePath.replace(/^\/+/, ''),
          name: basename(relativePath),
          dir: dirname(relativePath),
          size: file._data?.uncompressedSize ?? 0,
        });
      });
      this.state.entries = entries.sort((a, b) => a.path.localeCompare(b.path));
      this.state.status = entries.length + ' file(s)';
      this.actions._syncTitle();
    },

    toggleSelect: (path) => {
      let next = { ...this.state.selected };
      if (next[path]) delete next[path];
      else next[path] = true;
      this.state.selected = next;
    },

    selectAll: () => {
      let next = {};
      for (let e of this.state.entries) next[e.path] = true;
      this.state.selected = next;
    },

    selectNone: () => {
      this.state.selected = {};
    },

    selectedPaths: () => {
      return Object.keys(this.state.selected).filter((k) => this.state.selected[k]);
    },

    /* ----- adding / removing entries ----- */

    /** Add VFS files or folders (recursively) at the archive root. */
    addPaths: async (paths) => {
      let added = 0;
      this.state.error = '';
      for (let src of paths) {
        let p = normalize(src);
        if (!p) continue;
        if (p === this.state.archivePath) {
          this.state.warn = "Can't add an archive to itself";
          continue;
        }
        if (await vfs.isDirectory(p)) {
          let base = dirname(p);
          let files = (await vfs.list()).filter(
            (x) => x.startsWith(p + '/') && basename(x) !== '.keep',
          );
          if (!files.length) this._zip.folder(basename(p));
          for (let f of files) {
            let blob = await vfs.withLock(
              f,
              (lease) => vfs.readBlob(f, { lease }),
              { mode: 'r', actor: 'ui:winzip' },
            );
            if (!blob) continue;
            this._zip.file(base ? f.slice(base.length + 1) : f, blob);
            added++;
          }
        } else {
          let blob = await vfs.withLock(
            p,
            (lease) => vfs.readBlob(p, { lease }),
            { mode: 'r', actor: 'ui:winzip' },
          );
          if (!blob) continue;
          this._zip.file(basename(p), blob);
          added++;
        }
      }
      if (added) {
        this.state.dirty = true;
        this.actions._syncEntries();
        this.state.status = 'Added ' + added + ' file(s)';
      }
      return added;
    },

    addHostFiles: async (files) => {
      let added = 0;
      for (let f of files) {
        if (!f?.name) continue;
        this._zip.file(f.name, f);
        added++;
      }
      if (added) {
        this.state.dirty = true;
        this.actions._syncEntries();
        this.state.status = 'Added ' + added + ' file(s)';
      }
    },

    addFromSystem: async () => {
      let path = await showFilePicker({ title: 'Add to archive', startPath: PLAYER_HOME, mode: 'file' });
      if (path) await this.actions.addPaths([path]);
    },

    removeSelected: () => {
      let paths = this.actions.selectedPaths();
      if (!paths.length) {
        this.state.warn = 'Select one or more files to remove';
        return;
      }
      for (let p of paths) this._zip.remove(p);
      this.state.selected = {};
      this.state.dirty = true;
      this.state.warn = '';
      this.actions._syncEntries();
    },

    /* ----- saving ----- */

    save: async () => {
      this.state.error = '';
      this.state.warn = '';
      let dest = this.state.archivePath;
      if (this.state.isNew) {
        let name = String(this.state.saveName || '').trim().replace(/[\\/]/g, '-');
        if (!name) {
          this.state.warn = 'Name the archive first';
          return;
        }
        if (!/\.zip$/i.test(name)) name += '.zip';
        let dir = await showDirectoryPicker({ title: 'Save archive in…', startPath: PLAYER_HOME });
        if (!dir) return;
        dest = normalize(dir + '/' + name);
        if (await vfs.exists(dest)) {
          this.state.warn = '/' + dest + ' already exists — pick another name';
          return;
        }
      }
      try {
        let blob = await this._zip.generateAsync({ type: 'blob', mimeType: 'application/zip' });
        await vfs.withLock(
          dest,
          (lease) => vfs.writeBlob(dest, blob, 'application/zip', { lease }),
          { mode: 'w', actor: 'ui:winzip' },
        );
        this.state.archivePath = dest;
        this.state.isNew = false;
        this.state.dirty = false;
        this.state.status = 'Saved /' + dest;
        this.actions._syncTitle();
      } catch (err) {
        this.state.error = String(err?.message || err);
      }
    },

    /* ----- extracting ----- */

    _ensureDir: async (dir) => {
      let dpath = normalize(dir);
      if (!dpath) return;
      if (!(await vfs.isDirectory(dpath))) {
        let keep = dpath + '/.keep';
        await vfs.withLock(keep, (lease) => vfs.write(keep, '', { lease }), {
          mode: 'w',
          actor: 'ui:winzip',
        });
      }
    },

    _writeEntry: async (zipPath, destPath) => {
      let file = this._zip.file(zipPath);
      if (!file) throw new Error('Missing entry: ' + zipPath);
      let buf = await file.async('uint8array');
      let blob = new Blob([buf], { type: 'application/octet-stream' });
      // Always overwrite
      await vfs.withLock(
        destPath,
        (lease) => vfs.writeBlob(destPath, blob, { lease }),
        { mode: 'w', actor: 'ui:winzip' },
      );
    },

    _pickDest: async () => {
      return showDirectoryPicker({
        title: 'Extract to…',
        startPath: dirname(this.state.archivePath) || PLAYER_HOME,
      });
    },

    _extractPaths: async (paths, dest) => {
      await this.actions._ensureDir(dest);
      for (let zp of paths) {
        let parts = String(zp).split('/').filter(Boolean);
        let acc = dest;
        for (let i = 0; i < parts.length - 1; i++) {
          acc += '/' + parts[i];
          await this.actions._ensureDir(acc);
        }
        await this.actions._writeEntry(zp, dest + '/' + parts.join('/'));
      }
    },

    extractSelected: async () => {
      let paths = this.actions.selectedPaths();
      if (!paths.length) {
        this.state.warn = 'Select one or more files to extract';
        return;
      }
      this.state.warn = '';
      this.state.error = '';
      let dest = await this.actions._pickDest();
      if (!dest) return;
      try {
        await this.actions._extractPaths(paths, dest);
        this.state.status = 'Extracted ' + paths.length + ' file(s) to /' + dest;
      } catch (err) {
        this.state.error = String(err?.message || err);
      }
    },

    extractAll: async () => {
      let paths = this.state.entries.map((e) => e.path);
      if (!paths.length) return;
      this.state.warn = '';
      this.state.error = '';
      let dest = await this.actions._pickDest();
      if (!dest) return;
      try {
        await this.actions._extractPaths(paths, dest);
        this.state.status = 'Extracted all ' + paths.length + ' file(s) to /' + dest;
      } catch (err) {
        this.state.error = String(err?.message || err);
      }
    },

    /**
     * Double-click: check association, extract to tmp/winzip/<name>-<uuid>.<ext>, open.
     */
    openEntry: async (zipPath) => {
      this.state.warn = '';
      this.state.error = '';
      let name = basename(zipPath);
      let app = appForPath(name);
      if (!app) {
        this.state.warn =
          'No application is associated with .' +
          (splitNameExt(name).ext || 'this') +
          ' files — open cancelled';
        return;
      }
      try {
        await this.actions._ensureDir('tmp/winzip');
        let { base, ext } = splitNameExt(name);
        let out = 'tmp/winzip/' + base + '-' + uuid() + (ext ? '.' + ext : '');
        await this.actions._writeEntry(zipPath, out);
        this.state.status = 'Opened ' + name + ' → /' + out;
        await post('vfs.openPath', out);
      } catch (err) {
        this.state.error = String(err?.message || err);
      }
    },

    /* ----- drop target (Explorer selections and host files) ----- */

    dragEnter: (ev) => {
      let e = ev || event;
      e.preventDefault();
      this._dragDepth += 1;
      this.state.dragOver = true;
    },

    dragOver: (ev) => {
      let e = ev || event;
      e.preventDefault();
      try {
        e.dataTransfer.dropEffect = 'copy';
      } catch {}
      this.state.dragOver = true;
    },

    dragLeave: () => {
      this._dragDepth = Math.max(0, this._dragDepth - 1);
      if (!this._dragDepth) this.state.dragOver = false;
    },

    drop: async (ev) => {
      let e = ev || event;
      e.preventDefault();
      this._dragDepth = 0;
      this.state.dragOver = false;
      let internal = draggedPaths(e);
      if (internal) {
        endPathDrag();
        await this.actions.addPaths(internal.paths);
        return;
      }
      let files = e.dataTransfer?.files;
      if (files?.length) await this.actions.addHostFiles(files);
    },
  };
}
