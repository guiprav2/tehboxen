/**
 * Start a module Worker.
 *
 * On pages isolated by our coi-sw.js (Safari, Firefox for Android) a URL
 * worker would fetch its own imports outside the service worker and have them
 * refused, so there the worker starts from a one-line blob module that
 * imports the real script: blob workers inherit the creator's service worker
 * and COEP. Everywhere else (Netlify headers, Webfoundry previews, whose
 * service worker routes requests by the requesting page's URL and can't serve
 * a blob: client) it's a plain `new Worker(url)`.
 */
function useBlob() {
  // Page: are we controlled by coi-sw.js? Worker: were we started that way ourselves?
  if (typeof window !== 'undefined') return /\/coi-sw\.js$/.test(globalThis.navigator?.serviceWorker?.controller?.scriptURL || '');
  return globalThis.location?.protocol === 'blob:';
}

export function spawnModuleWorker(url, options = {}) {
  if (!useBlob()) return new Worker(url, { ...options, type: 'module' });
  let blobUrl = URL.createObjectURL(new Blob([`import ${JSON.stringify(String(url))};\n`], { type: 'text/javascript' }));
  try {
    return new Worker(blobUrl, { ...options, type: 'module' });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
  }
}
