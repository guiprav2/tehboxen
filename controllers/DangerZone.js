import {
  exportVfsZip,
  importVfsZip,
  downloadBlob,
  factoryReset,
} from '../other/vfs-pack.js';

/**
 * Danger Zone — full VFS export / import / factory reset.
 * Import modes: replace (wipe then load) or merge (overwrite keys in pack).
 */
export default class DangerZone {
  state = {
    busy: false,
    status: '',
    error: '',
    lastExport: null,
    importMode: 'merge', // 'merge' | 'replace'
    confirmImport: '',
    confirmReset: '',
    packTitle: 'Tehboxen World',
  };

  _fileInput = null;

  actions = {
    onAttach: async (_el, winId) => {
      try {
        if (winId) post('desktop.registerWindow', winId);
      } catch {}
    },

    onDetach: () => {},

    setImportMode: (mode) => {
      this.state.importMode = mode === 'replace' ? 'replace' : 'merge';
      d.update();
    },

    setPackTitle: (v) => {
      this.state.packTitle = String(v || '').slice(0, 120);
    },

    setConfirmImport: (v) => {
      this.state.confirmImport = String(v || '');
    },

    setConfirmReset: (v) => {
      this.state.confirmReset = String(v || '');
    },

    exportPack: async () => {
      if (this.state.busy) return;
      this.state.busy = true;
      this.state.error = '';
      this.state.status = 'Packing VFS…';
      d.update();
      try {
        let title = this.state.packTitle.trim() || 'Tehboxen World';
        let { blob, manifest, count } = await exportVfsZip({ title });
        let stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
        let safe = title.replace(/[^\w\-]+/g, '_').replace(/^_|_$/g, '') || 'world';
        let name = safe + '-' + stamp + '.zip';
        await downloadBlob(blob, name);
        this.state.lastExport = { name, count, created: manifest.created };
        this.state.status = 'Exported ' + count + ' entries → ' + name;
      } catch (err) {
        this.state.error = err?.message || String(err);
        this.state.status = '';
      } finally {
        this.state.busy = false;
        d.update();
      }
    },

    pickImportFile: () => {
      if (this.state.busy) return;
      if (!this._fileInput) {
        let input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.className = 'hidden';
        input.addEventListener('change', () => {
          let file = input.files && input.files[0];
          input.value = '';
          if (file) post('dangerZone.importPack', file);
        });
        document.body.appendChild(input);
        this._fileInput = input;
      }
      this._fileInput.click();
    },

    importPack: async (file) => {
      if (this.state.busy) return;
      let mode = this.state.importMode;
      let need = mode === 'replace' ? 'REPLACE' : 'MERGE';
      if (this.state.confirmImport.trim().toUpperCase() !== need) {
        this.state.error =
          'Type ' + need + ' in the confirm box before importing (' + mode + ').';
        d.update();
        return;
      }
      this.state.busy = true;
      this.state.error = '';
      this.state.status =
        mode === 'replace'
          ? 'Replacing entire VFS…'
          : 'Merging pack (overwriting colliding paths)…';
      d.update();
      try {
        let buf = await file.arrayBuffer();
        let result = await importVfsZip(buf, { mode });
        this.state.status =
          (mode === 'replace' ? 'Replaced' : 'Merged') +
          ' ' +
          result.count +
          ' entries' +
          (result.title ? ' · ' + result.title : '') +
          '. Reloading…';
        this.state.confirmImport = '';
        d.update();
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        this.state.error = err?.message || String(err);
        this.state.status = '';
        this.state.busy = false;
        d.update();
      }
    },

    factoryReset: async () => {
      if (this.state.busy) return;
      if (this.state.confirmReset.trim().toUpperCase() !== 'RESET') {
        this.state.error = 'Type RESET in the confirm box before factory reset.';
        d.update();
        return;
      }
      this.state.busy = true;
      this.state.error = '';
      this.state.status = 'Wiping VFS (OS skeleton only — import a world pack for places/cast)…';
      d.update();
      try {
        // Host JS no longer embeds a demo cast. Reset leaves the empty OS
        // seed from vfs.factoryReset; restore world via Import pack.
        await factoryReset();
        this.state.status = 'Factory reset done. Import a world pack for places/NPCs. Reloading…';
        this.state.confirmReset = '';
        d.update();
        setTimeout(() => location.reload(), 600);
      } catch (err) {
        this.state.error = err?.message || String(err);
        this.state.status = '';
        this.state.busy = false;
        d.update();
      }
    },
  };
}
