/**
 * Cross-origin isolation for browsers without COEP `credentialless` (Safari,
 * every iOS browser). Netlify serves COOP + COEP credentialless (_headers),
 * which isolates Chrome and Firefox; WebKit ignores credentialless, so pages
 * there register this worker (other/session.js) and reload once.
 *
 * It re-serves same-origin responses with COOP same-origin + COEP
 * require-corp + CORP, and retries cross-origin no-cors loads (CDN scripts,
 * fonts, images) as CORS so they can carry a CORP header; ones whose server
 * doesn't allow CORS stay blocked, as require-corp demands.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()));

function isolated(res, extra = {}) {
  if (!res || res.type === 'opaque' || res.type === 'opaqueredirect' || res.status === 0) return res;
  let headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  for (let [k, v] of Object.entries(extra)) headers.set(k, v);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (ev) => {
  let req = ev.request;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  let url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  let sameOrigin = url.origin === self.location.origin;
  ev.respondWith(
    (async () => {
      if (sameOrigin) return isolated(await fetch(req));
      if (req.mode !== 'no-cors') return fetch(req);
      // A no-cors response can't carry CORP for us: ask for CORS instead, fall back to as-is.
      try {
        let res = await fetch(new Request(req, { mode: 'cors', credentials: 'omit' }));
        return isolated(res);
      } catch {
        return fetch(req);
      }
    })(),
  );
});
