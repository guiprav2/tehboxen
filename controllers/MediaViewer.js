import * as vfs from '../other/vfs.js';
import { mediaExt, videoExt } from '../other/vfs.js';

export default class MediaViewer {
  state = {
    path: '',
    url: '',
    error: '',
    isImage: false,
    isVideo: false,
  };

  _objectUrl = null;

  actions = {
    onDetach: () => {
      this.actions._revoke();
      this.state.path = '';
      this.state.url = '';
      this.state.error = '';
      this.state.isImage = false;
      this.state.isVideo = false;
    },

    open: async (path) => {
      this.actions._revoke();
      this.state.path = String(path || '');
      this.state.error = '';
      this.state.isVideo = videoExt(this.state.path);
      this.state.isImage = mediaExt(this.state.path) && !this.state.isVideo;
      if (!this.state.isImage && !this.state.isVideo) {
        this.state.url = '';
        this.state.error = 'Not an image or video — open in Editor instead.';
        d.update();
        return;
      }
      try {
        let blob = await vfs.withLock(this.state.path, (lease) => vfs.readBlob(this.state.path, { lease }), { mode: 'r', actor: 'ui:mediaViewer' });
        if (!blob) {
          this.state.error = 'File not found';
          this.state.url = '';
          d.update();
          return;
        }
        this._objectUrl = URL.createObjectURL(blob);
        this.state.url = this._objectUrl;
      } catch (err) {
        this.state.error = String(err?.message || err);
        this.state.url = '';
      }
      d.update();
    },

    openInEditor: async () => {
      if (!this.state.path) return;
      post('desktop.openApp', 'editor', { openPath: this.state.path });
    },

    _revoke: () => {
      if (this._objectUrl) {
        try {
          URL.revokeObjectURL(this._objectUrl);
        } catch {}
        this._objectUrl = null;
      }
    },
  };
}
