/**
 * In-page drag & drop of VFS paths between Tehboxen windows (Explorer ↔
 * Explorer, Explorer → WinZip). dataTransfer contents can't be read during
 * dragover, so the dragged paths also live here while the drag is in flight.
 */

export let MIME = 'application/x-tehboxen-paths';

let current = null;

export function startPathDrag(ev, paths, sourceWin) {
  current = { paths: [...paths], sourceWin };
  try {
    ev.dataTransfer.setData(MIME, JSON.stringify(paths));
    ev.dataTransfer.setData('text/plain', paths.map((p) => '/' + p).join('\n'));
    ev.dataTransfer.effectAllowed = 'copyMove';
  } catch {}
}

export function endPathDrag() {
  current = null;
}

/** Paths being dragged inside Tehboxen, or null for a host (OS) file drag. */
export function draggedPaths(ev) {
  if (current) return current;
  try {
    let raw = ev?.dataTransfer?.getData?.(MIME);
    if (raw) return { paths: JSON.parse(raw), sourceWin: null };
  } catch {}
  return null;
}

export function isPathDrag(ev) {
  if (current) return true;
  try {
    return [...(ev?.dataTransfer?.types || [])].includes(MIME);
  } catch {
    return false;
  }
}
