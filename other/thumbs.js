import * as vfs from './vfs.js';
import { imageExt, videoExt } from './vfs.js';

/** path → { mtime, promise } */
let cache = new Map();

export function canThumb(path) {
  return imageExt(path) || videoExt(path);
}

/** Thumbnail URL for an image or video in the VFS (videos: first frame). */
export function getThumb(path, mtime = 0) {
  let hit = cache.get(path);
  if (hit && hit.mtime === mtime) return hit.promise;
  if (hit) release(hit);
  let entry = { mtime, url: null, promise: null };
  entry.promise = (async () => {
    let blob = await vfs.withLock(path, (lease) => vfs.readBlob(path, { lease }), { mode: 'r' });
    if (!blob) return null;
    entry.url = imageExt(path) ? await imageThumb(blob) : await videoThumb(blob);
    return entry.url;
  })().catch((err) => {
    console.warn('thumbnail failed', path, err);
    return null;
  });
  cache.set(path, entry);
  return entry.promise;
}

export function dropThumb(path) {
  let hit = cache.get(path);
  if (!hit) return;
  release(hit);
  cache.delete(path);
}

function release(entry) {
  if (entry.url && entry.url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(entry.url);
    } catch {}
  }
}

async function imageThumb(blob) {
  // Downscale big images so a folder of photos stays light.
  if (blob.size < 200_000 || blob.type === 'image/svg+xml') {
    return URL.createObjectURL(blob);
  }
  try {
    let bmp = await createImageBitmap(blob);
    let url = drawCover(bmp, bmp.width, bmp.height);
    bmp.close?.();
    return url;
  } catch {
    return URL.createObjectURL(blob);
  }
}

function drawCover(src, w, h, size = 256) {
  let s = Math.min(w, h);
  let canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas
    .getContext('2d')
    .drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
  return canvas.toDataURL('image/jpeg', 0.82);
}

/** First frame of a video, as a JPEG data URL. */
export function videoThumb(blob) {
  return new Promise((resolve, reject) => {
    let url = URL.createObjectURL(blob);
    let video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    let done = (fn, arg) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {}
      URL.revokeObjectURL(url);
      fn(arg);
    };
    let timer = setTimeout(() => done(reject, new Error('video thumbnail timeout')), 8000);
    video.addEventListener('error', () => done(reject, new Error('video decode failed')));
    video.addEventListener('loadeddata', () => {
      // Seeking to 0 guarantees the first frame is the one painted.
      if (video.currentTime !== 0) video.currentTime = 0;
      requestAnimationFrame(() => {
        try {
          done(resolve, drawCover(video, video.videoWidth, video.videoHeight));
        } catch (err) {
          done(reject, err);
        }
      });
    });
    video.src = url;
  });
}
