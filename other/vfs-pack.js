/**
 * Pack / unpack the Tehboxen VFS as a shareable ZIP (world packs, backups).
 *
 * Zip layout:
 *   manifest.json  — { format, version, title, created, mode, count }
 *   store.json     — dumpStore() snapshot (entries with base64 blobs)
 */
import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import { dumpStore, importStore, factoryReset } from './vfs.js';

export let PACK_FORMAT = 'tehboxen-vfs-zip';
export let PACK_VERSION = 1;

export async function exportVfsZip(opts = {}) {
  let snap = await dumpStore();
  let title = String(opts.title || 'Tehboxen World').slice(0, 120);
  let manifest = {
    format: PACK_FORMAT,
    version: PACK_VERSION,
    title,
    created: snap.created,
    count: snap.count,
    note:
      'Tehboxen VFS pack. Import with Danger Zone (replace = wipe first; merge = overwrite keys in pack). No executable guest JS.',
  };
  let zip = new JSZip();
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('store.json', JSON.stringify(snap));
  let blob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  return { blob, manifest, count: snap.count };
}

export async function importVfsZip(blobOrArrayBuffer, opts = {}) {
  let mode = opts.mode === 'merge' ? 'merge' : 'replace';
  let zip = await JSZip.loadAsync(blobOrArrayBuffer);
  let storeFile = zip.file('store.json');
  if (!storeFile) throw new Error('Not a Tehboxen pack (missing store.json)');
  let raw = await storeFile.async('string');
  let snap = JSON.parse(raw);
  if (!snap || snap.format !== 'tehboxen-vfs') {
    throw new Error('Invalid store.json in pack');
  }
  let manFile = zip.file('manifest.json');
  let manifest = null;
  if (manFile) {
    try {
      manifest = JSON.parse(await manFile.async('string'));
    } catch {}
  }
  let result = await importStore(snap, { mode });
  return { ...result, manifest, title: manifest?.title || '' };
}

export async function downloadBlob(blob, filename) {
  let url = URL.createObjectURL(blob);
  try {
    let a = document.createElement('a');
    a.href = url;
    a.download = filename || 'tehboxen-world.zip';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

export { factoryReset };
