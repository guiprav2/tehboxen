import { PLAYER_HOME } from '../other/session.js';
import * as vfs from '../other/vfs.js';
import { appForPath, normalize, createVfsFs } from '../other/vfs.js';
import { showDirectoryPicker, showFilePicker } from '../other/file-picker.js';
import { draggedPaths, endPathDrag } from '../other/dnd.js';
import { archiveKind, ARCHIVE_KINDS } from '../other/archives.js';

let basename = (p) => String(p || '').split('/').filter(Boolean).pop() || '';
let dirname = (p) => String(p || '').split('/').filter(Boolean).slice(0, -1).join('/');
/** Single-quote for boxsh. */
let q = (s) => "'" + String(s).replace(/'/g, `'\\''`) + "'";
let abs = (p) => '/' + normalize(p);
let uid = () => {
  try {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  } catch {
    return Math.random().toString(16).slice(2, 14);
  }
};

/** Formats a new archive can be saved as (ARCHIVE_KINDS keys), in menu order. */
let NEW_FORMATS = ['zip', 'tar.gz', 'tar.xz', 'tar.bz2', 'tar'];

/**
 * Archiver window controller: a front end for the box's own tools (zip/unzip, tar, gzip,
 * bzip2, xz), run as the player through boxsh — the archive formats, permissions and
 * errors are the real programs'. Each window builds its own instance
 * (components/Archiver.js); one opened without a file starts on a New Archive.
 */
export default class Archiver {
  state = {
    /** VFS path of the open archive; '' while it is a New Archive. */
    archivePath: '',
    isNew: true,
    /** ARCHIVE_KINDS key of the open archive / the format a New Archive is saved as. */
    kind: 'zip',
    formats: NEW_FORMATS,
    saveName: 'New Archive',
    /** Entries: { path, name, dir, size, isDir, mode, staged? } (staged: VFS path to add on save). */
    entries: [],
    selected: {},
    error: '',
    warn: '',
    status: 'Drop files here to add them',
    busy: '',
    /** The last command run (shown in the status bar's tooltip / log). */
    log: [],
    dragOver: false,
  };

  _dragDepth = 0;
  _shell = null;

  init(props = {}) {
    if (props.openPath) this.actions.open(props.openPath);
    else this.actions._syncTitle();
  }

  get title() {
    let s = this.state;
    return s.isNew ? 'New Archive' : basename(s.archivePath);
  }

  get kindInfo() {
    return ARCHIVE_KINDS[this.state.kind] || ARCHIVE_KINDS.zip;
  }

  /** Run a boxsh command line as the player; throws with the tool's stderr on failure. */
  async _sh(cmd, { cwd } = {}) {
    if (!this._shell) {
      let { createShell } = await import('../other/shell.js');
      this._shell = createShell(createVfsFs());
    }
    let line = (cwd ? 'cd ' + q(abs(cwd)) + ' && ' : '') + cmd;
    this.state.log = [...this.state.log.slice(-19), '$ ' + line];
    let r = await this._shell.run(line);
    if (r.code) {
      let msg = String(r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).slice(-3).join(' — ');
      throw new Error(msg || cmd.split(' ')[0] + ' failed (exit ' + r.code + ')');
    }
    return String(r.stdout || '');
  }

  /** Run `fn` with a busy label; errors land in state.error. */
  async _busy(label, fn) {
    this.state.busy = label;
    this.state.error = '';
    this.state.warn = '';
    d.update();
    try {
      return await fn();
    } catch (err) {
      this.state.error = String(err?.message || err);
    } finally {
      this.state.busy = '';
    }
  }

  async _tmpDir(tag) {
    let dir = 'tmp/archiver/' + tag + '-' + uid();
    await this._sh('mkdir -p ' + q(abs(dir)));
    return dir;
  }

  async _rmTmp(dir) {
    if (dir && dir.startsWith('tmp/archiver/')) await this._sh('rm -rf ' + q(abs(dir))).catch(() => {});
  }

  /* ----- listing ----- */

  async _list() {
    let k = this.kindInfo;
    let p = q(abs(this.state.archivePath));
    let entries = [];
    if (k.tool === 'zip') {
      // zipinfo -l: perms version os size txt/bin csize method date time name
      let out = await this._sh('zipinfo -l ' + p);
      for (let line of out.split('\n')) {
        let m = /^([-dl][-rwxsStT]{9})\s+\S+\s+\S+\s+(\d+)\s+\S+\s+\d+\s+\S+\s+\S+\s+\S+\s(.+)$/.exec(line);
        if (!m) continue;
        let path = m[3].replace(/\/$/, '');
        entries.push({ path, name: basename(path), dir: dirname(path), size: Number(m[2]), isDir: m[1][0] === 'd' || m[3].endsWith('/'), mode: m[1] });
      }
    } else if (k.tool === 'tar') {
      // busybox tar tv: mode owner/group size date time name [-> target]
      let out = await this._sh('tar tvf ' + p);
      for (let line of out.split('\n')) {
        let m = /^([-dlhcbp][-rwxsStT]{9})\s+\S+\s+(\d+)\s+\S+\s+\S+\s(.+?)(?: -> .*)?$/.exec(line);
        if (!m) continue;
        let path = m[3].replace(/^\.\//, '').replace(/\/$/, '');
        if (!path || path === '.') continue;
        entries.push({ path, name: basename(path), dir: dirname(path), size: Number(m[2]), isDir: m[1][0] === 'd', mode: m[1] });
      }
    } else {
      // Single compressed file: one entry, the name without the suffix.
      let name = basename(this.state.archivePath).replace(k.suffix, '') || 'data';
      let size = 0;
      if (k.tool === 'xz') {
        let out = await this._sh('xz --robot -l ' + p).catch(() => '');
        let t = /^totals\t\d+\t\d+\t\d+\t(\d+)/m.exec(out);
        size = t ? Number(t[1]) : 0;
      }
      entries.push({ path: name, name, dir: '', size, isDir: false, mode: '-rw-r--r--' });
    }
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  _setEntries(entries) {
    this.state.entries = entries;
    this.state.selected = {};
    let files = entries.filter((e) => !e.isDir);
    let bytes = files.reduce((n, e) => n + (e.size || 0), 0);
    this.state.status = files.length + ' file(s), ' + Archiver.fmtSize(bytes) + (this.state.isNew ? '' : ' — ' + this.kindInfo.label);
    this.actions._syncTitle();
  }

  static fmtSize(n) {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KiB';
    return (n / 1024 / 1024).toFixed(1) + ' MiB';
  }

  /* ----- creating / rewriting archives ----- */

  /** Command that writes archive `dest` (absolute) from `names` relative to the cwd. */
  _createCmd(kind, dest, names) {
    let k = ARCHIVE_KINDS[kind];
    let list = names.map(q).join(' ');
    if (k.tool === 'zip') return 'zip -qry ' + q(dest) + ' ' + list;
    if (k.tool === 'tar') return 'tar c' + k.tarFlag + 'f ' + q(dest) + ' ' + list;
    // Single-file formats compress exactly one file.
    return k.tool + ' -c ' + list + ' > ' + q(dest);
  }

  /**
   * Write the archive at `destPath` (VFS) as format `kind` from the current entries: the
   * open archive's kept entries (extracted to a staging dir first) plus staged VFS paths.
   * zip edits in place; tar and single-file formats are rebuilt.
   */
  async _write(destPath, kind) {
    let k = ARCHIVE_KINDS[kind];
    let staged = this.state.entries.filter((e) => e.staged);
    let kept = this.state.entries.filter((e) => !e.staged);
    if (!k.multi && this.state.entries.filter((e) => !e.isDir).length !== 1) {
      throw new Error(k.label + ' holds exactly one file — use a .tar' + k.suffix + ' for more');
    }
    let stage = await this._tmpDir('stage');
    try {
      // Entries already in the open archive: extract them into the staging dir.
      if (kept.length && this.state.archivePath) await this._extractTo(stage, null);
      // Staged files: copy them in under their entry name.
      for (let e of staged) {
        let target = stage + '/' + e.path;
        if (dirname(e.path)) await this._sh('mkdir -p ' + q(abs(stage + '/' + dirname(e.path))));
        await this._sh('cp -r ' + q(abs(e.staged)) + ' ' + q(abs(target)));
      }
      let names = [...new Set(this.state.entries.map((e) => e.path.split('/')[0]))];
      let tmpOut = stage + '.out';
      await this._sh(this._createCmd(kind, abs(tmpOut), names), { cwd: stage });
      await this._sh('mv ' + q(abs(tmpOut)) + ' ' + q(abs(destPath)));
    } finally {
      await this._rmTmp(stage);
      await this._rmTmp(stage + '.out');
    }
  }

  /** Extract `paths` (null: everything) from the open archive into VFS dir `dest`. */
  async _extractTo(dest, paths) {
    let k = this.kindInfo;
    let p = q(abs(this.state.archivePath));
    let list = paths ? paths.map(q).join(' ') : '';
    await this._sh('mkdir -p ' + q(abs(dest)));
    if (k.tool === 'zip') return this._sh('unzip -oq ' + p + (list ? ' ' + list : '') + ' -d ' + q(abs(dest)));
    if (k.tool === 'tar') return this._sh('tar x' + k.tarFlag + 'f ' + p + ' -C ' + q(abs(dest)) + (list ? ' ' + list : ''));
    let name = this.state.entries[0]?.name || 'data';
    return this._sh(k.tool + ' -dc ' + p + ' > ' + q(abs(dest + '/' + name)));
  }

  /** Expand selected directories to the entries under them (tar/unzip take explicit names). */
  _selectionWithChildren() {
    let sel = Object.keys(this.state.selected).filter((k) => this.state.selected[k]);
    let out = new Set();
    for (let s of sel) {
      for (let e of this.state.entries) if (e.path === s || e.path.startsWith(s + '/')) out.add(e.path);
    }
    return [...out];
  }

  actions = {
    _syncTitle: () => {
      post('desktop.setWinTitle', this.winId, 'Archiver · ' + this.title, 'Archiver — ' + (this.state.isNew ? 'New Archive' : '/' + this.state.archivePath));
    },

    newArchive: () => {
      Object.assign(this.state, { archivePath: '', isNew: true, kind: 'zip', saveName: 'New Archive', entries: [], selected: {}, error: '', warn: '', status: 'Drop files here to add them' });
      this.actions._syncTitle();
    },

    setFormat: (kind) => {
      if (ARCHIVE_KINDS[kind]) this.state.kind = kind;
    },

    open: async (path) => {
      let p = normalize(path);
      let kind = archiveKind(p);
      Object.assign(this.state, { archivePath: p, isNew: false, kind: kind || 'zip', entries: [], selected: {}, status: '' });
      this.actions._syncTitle();
      if (!kind) {
        this.state.error = basename(p) + ': not an archive Archiver knows (' + Object.values(ARCHIVE_KINDS).map((k) => k.suffix).join(' ') + ')';
        return;
      }
      await this._busy('Reading archive…', async () => this._setEntries(await this._list()));
    },

    reload: async () => {
      if (!this.state.isNew) await this.actions.open(this.state.archivePath);
    },

    openFromSystem: async () => {
      let path = await showFilePicker({ title: 'Open archive', startPath: dirname(this.state.archivePath) || PLAYER_HOME, mode: 'file' });
      if (path) await this.actions.open(path);
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

    /* ----- adding / removing ----- */

    /** Add VFS files or folders at the archive root (written on Save, or right away for zip). */
    addPaths: async (paths) => {
      let added = [];
      for (let src of paths) {
        let p = normalize(src);
        if (!p) continue;
        if (p === this.state.archivePath) {
          this.state.warn = "Can't add an archive to itself";
          continue;
        }
        let name = basename(p);
        let isDir = await vfs.isDirectory(p);
        this.state.entries = this.state.entries.filter((e) => e.path !== name && !e.path.startsWith(name + '/'));
        added.push({ path: name, name, dir: '', size: isDir ? 0 : await vfs.sizeOf(p).catch(() => 0), isDir, mode: isDir ? 'd' : '-', staged: p });
      }
      if (!added.length) return 0;
      this.state.entries = [...this.state.entries, ...added].sort((a, b) => a.path.localeCompare(b.path));
      if (this.state.isNew) {
        this.state.status = this.state.entries.length + ' item(s) — Save to write the archive';
        return added.length;
      }
      // An existing archive: zip updates in place; others are rebuilt.
      await this._busy('Adding ' + added.length + ' item(s)…', async () => {
        if (this.kindInfo.tool === 'zip') {
          for (let a of added) await this._sh('zip -qry ' + q(abs(this.state.archivePath)) + ' ' + q(a.name), { cwd: dirname(a.staged) });
        } else {
          await this._write(this.state.archivePath, this.state.kind);
        }
        this._setEntries(await this._list());
        this.state.status = 'Added ' + added.length + ' item(s)';
      });
      return added.length;
    },

    addFromSystem: async () => {
      let path = await showFilePicker({ title: 'Add to archive', startPath: PLAYER_HOME, mode: 'file' });
      if (path) await this.actions.addPaths([path]);
    },

    removeSelected: async () => {
      let paths = this._selectionWithChildren();
      if (!paths.length) {
        this.state.warn = 'Select one or more entries to remove';
        return;
      }
      let gone = new Set(paths);
      if (this.state.isNew) {
        this.state.entries = this.state.entries.filter((e) => !gone.has(e.path));
        this.state.selected = {};
        return;
      }
      await this._busy('Removing…', async () => {
        if (this.kindInfo.tool === 'zip') {
          // zip -d takes entry names; directories are stored with a trailing slash.
          let names = this.state.entries.filter((e) => gone.has(e.path)).map((e) => (e.isDir ? e.path + '/' : e.path));
          await this._sh('zip -qd ' + q(abs(this.state.archivePath)) + ' ' + names.map(q).join(' '));
        } else {
          if (!this.kindInfo.multi) throw new Error('Remove the file itself: a ' + this.kindInfo.label + ' holds just one');
          let keep = this.state.entries.filter((e) => !gone.has(e.path));
          let stage = await this._tmpDir('rm');
          try {
            await this._extractTo(stage, null);
            for (let p of paths) await this._sh('rm -rf ' + q(abs(stage + '/' + p)));
            let names = [...new Set(keep.map((e) => e.path.split('/')[0]))];
            if (!names.length) throw new Error("A tar archive can't be empty — delete the file instead");
            await this._sh(this._createCmd(this.state.kind, abs(stage + '.out'), names), { cwd: stage });
            await this._sh('mv ' + q(abs(stage + '.out')) + ' ' + q(abs(this.state.archivePath)));
          } finally {
            await this._rmTmp(stage);
            await this._rmTmp(stage + '.out');
          }
        }
        this._setEntries(await this._list());
        this.state.status = 'Removed ' + paths.length + ' entr' + (paths.length === 1 ? 'y' : 'ies');
      });
    },

    /* ----- saving a New Archive ----- */

    save: async () => {
      let name = String(this.state.saveName || '').trim().replace(/[\\/]/g, '-');
      if (!name) {
        this.state.warn = 'Name the archive first';
        return;
      }
      if (!this.state.entries.length) {
        this.state.warn = 'Add files first';
        return;
      }
      let k = this.kindInfo;
      if (!name.toLowerCase().endsWith(k.suffix)) name += k.suffix;
      let dir = await showDirectoryPicker({ title: 'Save archive in…', startPath: PLAYER_HOME });
      if (!dir) return;
      let dest = normalize(dir + '/' + name);
      if (await vfs.exists(dest)) {
        this.state.warn = '/' + dest + ' already exists — pick another name';
        return;
      }
      await this._busy('Writing ' + name + '…', async () => {
        await this._write(dest, this.state.kind);
        this.state.isNew = false;
        this.state.archivePath = dest;
        this._setEntries(await this._list());
        this.state.status = 'Saved /' + dest + ' — ' + this.state.status;
      });
    },

    /* ----- extracting ----- */

    _pickDest: () => showDirectoryPicker({ title: 'Extract to…', startPath: dirname(this.state.archivePath) || PLAYER_HOME }),

    extractSelected: async () => {
      let paths = this._selectionWithChildren().filter((p) => !this.state.entries.find((e) => e.path === p)?.isDir);
      if (!paths.length) {
        this.state.warn = 'Select one or more files to extract';
        return;
      }
      if (this.state.isNew) return;
      let dest = await this.actions._pickDest();
      if (!dest) return;
      await this._busy('Extracting…', async () => {
        await this._extractTo(dest, this.kindInfo.multi ? paths : null);
        this.state.status = 'Extracted ' + paths.length + ' file(s) to /' + normalize(dest);
      });
    },

    extractAll: async () => {
      if (this.state.isNew || !this.state.entries.length) return;
      let dest = await this.actions._pickDest();
      if (!dest) return;
      await this._busy('Extracting…', async () => {
        await this._extractTo(dest, null);
        this.state.status = 'Extracted everything to /' + normalize(dest);
      });
    },

    /** Double-click: extract the entry to tmp/archiver/… and open it with its app. */
    openEntry: async (path) => {
      let e = this.state.entries.find((x) => x.path === path);
      if (!e || e.isDir) return;
      if (e.staged) return post('vfs.openPath', e.staged);
      if (!appForPath(e.name)) {
        this.state.warn = 'No application is associated with ' + e.name;
        return;
      }
      await this._busy('Opening ' + e.name + '…', async () => {
        let dir = await this._tmpDir('open');
        await this._extractTo(dir, this.kindInfo.multi ? [path] : null);
        await post('vfs.openPath', dir + '/' + path);
      });
    },

    /* ----- drop target (Explorer selections) ----- */

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
      if (e.dataTransfer?.files?.length) this.state.warn = 'Copy host files into the box first (drop them on Explorer), then add them here';
    },
  };
}
