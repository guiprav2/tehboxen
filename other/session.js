/**
 * Logged-in human account for this browser profile.
 *
 * The login screen (pages/index.html) writes the session, then does a full
 * page load into pages/desktop.html, so every module that reads PLAYER at
 * import time sees the right user. Logging out clears it and reloads.
 */
let KEY = 'tehboxen.session';

export function readSession() {
  try {
    let s = JSON.parse(localStorage.getItem(KEY) || 'null');
    return s && typeof s.user === 'string' && s.user ? s : null;
  } catch {
    return null;
  }
}

export function writeSession(user) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ user, at: new Date().toISOString() }));
  } catch {}
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

/** Username of the logged-in player ('guest' before login). */
export let PLAYER = readSession()?.user || 'guest';

/** VFS home of the logged-in player (no leading slash). */
export let PLAYER_HOME = 'home/' + PLAYER;

// Webfoundry previews boot with ?isolate=<editor origin>; the preview shell
// needs it on every full page load to register with the service worker.
// Remember the query string from the first load and carry it across.
let SEARCH_KEY = 'tehboxen.bootSearch';
try {
  if (/[?&]isolate=/.test(location.search)) sessionStorage.setItem(SEARCH_KEY, location.search);
} catch {}

/**
 * Cross-origin isolation (SharedArrayBuffer for node/WASI processes). Netlify's
 * COEP credentialless isolates Chrome/Firefox; WebKit (Safari, all iOS
 * browsers) only knows require-corp, which coi-sw.js adds. Register it when
 * the page isn't isolated (outside Webfoundry previews) and reload once.
 */
function ensureIsolation() {
  if (globalThis.crossOriginIsolated || !globalThis.navigator?.serviceWorker || !globalThis.isSecureContext) return;
  if (/^\/(files|preview)\//.test(location.pathname) || /[?&]isolate=/.test(location.search)) return;
  let RELOADED = 'tehboxen.coiReload';
  navigator.serviceWorker
    .register('/coi-sw.js', { scope: '/' })
    .then(async () => {
      await navigator.serviceWorker.ready;
      try {
        // Already reloaded under the worker and still not isolated: don't loop.
        if (sessionStorage.getItem(RELOADED)) return;
        sessionStorage.setItem(RELOADED, '1');
      } catch {
        return;
      }
      location.reload();
    })
    .catch((err) => console.warn('coi-sw', err));
}
ensureIsolation();

/** Full page load to another page, keeping the preview's query string. */
export function hardNavigate(page) {
  let url = new URL(page, location.href);
  let search = location.search;
  if (!/[?&]isolate=/.test(search)) {
    try {
      search = sessionStorage.getItem(SEARCH_KEY) || search;
    } catch {}
  }
  url.search = search;
  location.assign(url.href);
}

