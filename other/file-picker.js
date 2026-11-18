/**
 * Tehboxen file / directory picker.
 *
 * Opens the FilePicker component via showModal and resolves to a path
 * (no leading slash), or null if cancelled.
 *
 * Options:
 *   title?: string
 *   startPath?: string
 *   mode?: 'file' | 'directory'
 *   accept?: 'any' | 'image' | 'media' | 'text'
 */
import { PLAYER, PLAYER_HOME } from './session.js';

export async function showFilePicker(options = {}) {
  if (typeof showModal !== 'function') {
    throw new Error('showModal is not available');
  }
  let [value, path] = await showModal('FilePicker', {
    title: options.title,
    startPath: options.startPath || PLAYER_HOME,
    mode: options.mode || 'file',
    accept: options.accept || 'any',
  });
  if (value !== 'ok' || !path) return null;
  return String(path).replace(/^\/+/, '');
}

export async function showDirectoryPicker(options = {}) {
  return showFilePicker({
    ...options,
    mode: 'directory',
    title: options.title || 'Choose folder',
  });
}
