import * as vfs from '../other/vfs.js';
import { mediaExt, imageExt, videoExt, zipExt, appForPath } from '../other/vfs.js';

export default class Vfs {
  state = {
    ready: false,
    lastChange: null,
  };

  _unsub = null;

  actions = {
    init: async () => {
      await vfs.ensureReady();
      if (!this._unsub) {
        this._unsub = vfs.onChange((ev) => {
          this.state.lastChange = { ...ev, at: Date.now() };
          d.update();
        });
      }
      this.state.ready = true;
    },

    api: () => vfs,

    /**
     * Open a file with its associated app. Editor and WinZip get a new window
     * per file; Media Viewer is a single window that switches to the file.
     */
    openPath: async (path) => {
      let p = String(path || '').replace(/^\/+/, '');
      if (!p) return;
      let app = appForPath(p);
      if (!app) {
        throw new Error(
          'No application is associated with this file type (' +
            (p.split('.').pop() || 'unknown') +
            ')',
        );
      }
      if (app === 'winzip' || zipExt(p)) {
        return post('desktop.openApp', 'winzip', { openPath: p });
      }
      if (app === 'mediaViewer' || mediaExt(p)) {
        await post('mediaViewer.open', p);
        return post('desktop.openApp', 'mediaViewer');
      }
      return post('desktop.openApp', 'editor', { openPath: p });
    },

    listDir: async (dir = 'home') => {
      await vfs.ensureReady();
      let prefix = String(dir || '').replace(/^\/+|\/+$/g, '');
      let all = await vfs.list();
      let names = new Map();
      let entry = (name, path, isDir) => ({
        name,
        path,
        isDir: !!isDir,
        isMedia: !isDir && mediaExt(name),
        isImage: !isDir && imageExt(name),
        isVideo: !isDir && videoExt(name),
        isZip: !isDir && zipExt(name),
      });
      for (let path of all) {
        if (prefix) {
          if (path === prefix) continue;
          if (!path.startsWith(prefix + '/')) continue;
          let rest = path.slice(prefix.length + 1);
          let name = rest.split('/')[0];
          if (!name || name === '.keep') continue;
          let isDir = rest.includes('/');
          if (!names.has(name)) names.set(name, entry(name, prefix + '/' + name, isDir));
          else if (isDir) Object.assign(names.get(name), entry(name, prefix + '/' + name, true));
        } else {
          let name = path.split('/')[0];
          if (!name || name === '.keep') continue;
          let isDir = path.includes('/');
          if (!names.has(name)) names.set(name, entry(name, name, isDir));
          else if (isDir) Object.assign(names.get(name), entry(name, name, true));
        }
      }
      let out = [...names.values()];
      await Promise.all(
        out.map(async (e) => {
          try {
            e.mtime = (await vfs.getStat(e.path))?.mtime || 0;
          } catch {
            e.mtime = 0;
          }
        }),
      );
      return out.sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    },
  };
}
