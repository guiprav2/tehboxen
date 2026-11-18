import { PLAYER, PLAYER_HOME } from '../other/session.js';
import { imageExt, mediaExt, textExt } from '../other/vfs.js';

/**
 * Tehboxen VFS file/directory picker (modal via showModal('FilePicker', props)).
 *
 * props:
 *   title?: string
 *   startPath?: string   (default: the player home)
 *   mode?: 'file' | 'directory'
 *   accept?: 'any' | 'image' | 'media' | 'text'
 */
export default class FilePicker {
  constructor(props = {}) {
    this.props = props;
    this.title = props.title || (props.mode === 'directory' ? 'Choose folder' : 'Open file');
    this.mode = props.mode === 'directory' ? 'directory' : 'file';
    this.accept = props.accept || 'any';
    this.cwd = String(props.startPath || PLAYER_HOME).replace(/^\/+|\/+$/g, '');
    this.selected = null;
    this.selectedIsDir = false;
    this.entries = [];
    this.error = '';
    this._booted = false;
  }

  get cwdLabel() {
    return this.cwd ? this.cwd : '';
  }

  async boot(_el) {
    if (this._booted) return;
    this._booted = true;
    try {
      await post('vfs.init');
    } catch {}
    await this.refresh();
  }

  matchesAccept(entry) {
    if (!entry || entry.isDir) return true;
    if (this.mode === 'directory') return false;
    let name = entry.name || entry.path || '';
    let path = entry.path || name;
    if (this.accept === 'image') {
      return !!(imageExt(name) || imageExt(path));
    }
    if (this.accept === 'media') {
      return !!(mediaExt(name) || mediaExt(path));
    }
    if (this.accept === 'text') {
      return !!(textExt(name) || textExt(path));
    }
    return true;
  }

  async refresh() {
    this.error = '';
    try {
      let all = await post('vfs.listDir', this.cwd);
      this.entries = (all || []).filter(e => this.matchesAccept(e));
    } catch (err) {
      this.error = String(err?.message || err);
      this.entries = [];
    }
    d.update();
  }

  async goUp() {
    let parts = this.cwd.split('/').filter(Boolean);
    parts.pop();
    this.cwd = parts.join('/');
    this.selected = null;
    this.selectedIsDir = false;
    await this.refresh();
  }

  select(entry) {
    if (!entry) return;
    this.selected = entry.path;
    this.selectedIsDir = !!entry.isDir;
    d.update();
  }

  async activate(entry, event) {
    if (!entry) return;
    if (entry.isDir) {
      this.cwd = entry.path;
      this.selected = null;
      this.selectedIsDir = false;
      await this.refresh();
      return;
    }
    if (this.mode === 'directory') return;
    this.selected = entry.path;
    this.selectedIsDir = false;
    this.confirm(event);
  }

  canConfirm() {
    if (!this.selected) return false;
    if (this.mode === 'directory') return !!this.selectedIsDir;
    // file mode: allow Open on a folder to enter it
    return true;
  }

  _dialogFrom(event) {
    let t = event?.target;
    if (t?.closest) {
      let dlg = t.closest('dialog');
      if (dlg) return dlg;
    }
    return document.querySelector('dialog[open]');
  }

  cancel(event) {
    let dialog = this._dialogFrom(event);
    if (!dialog) return;
    dialog.returnValue = 'cancel';
    dialog.returnDetail = [];
    dialog.close();
  }

  async confirm(event) {
    if (!this.canConfirm()) return;
    // Enter directories instead of returning them in file mode
    if (this.mode === 'file' && this.selectedIsDir) {
      this.cwd = this.selected;
      this.selected = null;
      this.selectedIsDir = false;
      await this.refresh();
      return;
    }
    let dialog = this._dialogFrom(event);
    if (!dialog) return;
    dialog.returnValue = 'ok';
    dialog.returnDetail = [this.selected];
    dialog.close();
  }
}
