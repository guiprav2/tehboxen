/**
 * The in-world web's service worker. Registered by other/web/boot.html on each site subdomain
 * (<label>.web.<desktop host>, see other/web/hosts.js), never on the desktop's own origin.
 *
 * Every request a page of this origin makes — same-origin or not, navigation or subresource — is
 * answered from the simulated Internet: the URL is mapped back to its in-world form, handed to
 * this origin's broker frame (other/web/broker.html), which relays it to the desktop's engine
 * (other/web/engine.js: HTTP/HTTPS over the player's network stack), and the reply becomes a
 * synthesized Response. Nothing reaches the real network except the engine's own static files.
 *
 * Cookies live in this origin's real cookie jar (Cookie Store API; a memory jar elsewhere), so
 * document.cookie and HTTP cookies agree and stay isolated per in-world site.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (ev) => ev.waitUntil(self.clients.claim()));

/* ---------- address codec (a copy of other/web/hosts.js) ---------- */

let ENGINE_SUFFIX = location.host.slice(location.host.indexOf('.web.') + 1); // "web.<desktop host>"
let labelOf = (worldOrigin) => {
  let u = new URL(worldOrigin);
  let https = u.protocol === 'https:';
  let port = u.port && Number(u.port) !== (https ? 443 : 80) ? u.port : '';
  return (https ? 's' : 'h') + port + 'x' + u.hostname.toLowerCase().replace(/-/g, '--').replace(/\./g, '-');
};
let originOfLabel = (label) => {
  let m = /^([hs])(\d*)x(.+)$/.exec(label || '');
  if (!m) return null;
  let host = '';
  for (let i = 0; i < m[3].length; i++) {
    if (m[3][i] !== '-') host += m[3][i];
    else if (m[3][i + 1] === '-') (host += '-'), i++;
    else host += '.';
  }
  return `${m[1] === 's' ? 'https' : 'http'}://${host}${m[2] ? ':' + m[2] : ''}`;
};
let engineOriginOf = (worldOrigin) => `${location.protocol}//${labelOf(worldOrigin)}.${ENGINE_SUFFIX}`;
let SELF_WORLD = originOfLabel(location.host.slice(0, location.host.indexOf('.web.')));
/** In-world URL for a request URL: engine hosts decode; anything else is already in-world. */
let worldUrlOf = (url) => {
  let u = new URL(url);
  if (u.host.endsWith('.' + ENGINE_SUFFIX)) {
    let o = originOfLabel(u.host.slice(0, -ENGINE_SUFFIX.length - 1));
    return o && o + u.pathname + u.search;
  }
  return u.protocol === 'http:' || u.protocol === 'https:' ? u.href.replace(/#.*$/, '') : null;
};
/** Where a navigation to an in-world URL goes: same origin → plain path; else that origin's boot. */
let navUrlOf = (worldUrl) => {
  let u = new URL(worldUrl);
  if (u.origin === SELF_WORLD) return u.pathname + u.search + u.hash;
  return `${engineOriginOf(u.origin)}/other/web/boot.html?to=${encodeURIComponent(u.pathname + u.search + u.hash)}`;
};

/* ---------- broker ---------- */

async function broker() {
  for (let attempt = 0; attempt < 30; attempt++) {
    let all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    let b = all.find((c) => /^\/other\/web\/broker(\.html)?$/.test(new URL(c.url).pathname));
    if (b) return b;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function relay(req) {
  let b = await broker();
  if (!b) throw new Error('no broker: open this site with the Tehboxen web browser');
  let ch = new MessageChannel();
  let reply = new Promise((resolve, reject) => {
    ch.port1.onmessage = (ev) => (ev.data?.error ? reject(new Error(ev.data.error)) : resolve(ev.data));
    setTimeout(() => reject(new Error('timed out')), 60000);
  });
  b.postMessage({ t: 'tbweb-fetch', req }, [ch.port2, ...(req.body ? [req.body] : [])]);
  return reply;
}

/* ---------- cookies ---------- */

let memJar = new Map(); // name → { value, path, expires }
async function cookieHeader(worldUrl) {
  let path = new URL(worldUrl).pathname;
  let list = [];
  if (self.cookieStore) {
    // Only this site's own (host-only) cookies: Domain= cookies come from the parent domain (the
    // desktop's analytics…) or are a page's attempt at a cross-site supercookie.
    for (let c of await self.cookieStore.getAll()) if (!c.domain && (!c.path || path.startsWith(c.path))) list.push(`${c.name}=${c.value}`);
  } else {
    let now = Date.now();
    for (let [name, c] of memJar) {
      if (c.expires && c.expires < now) memJar.delete(name);
      else if (path.startsWith(c.path || '/')) list.push(`${name}=${c.value}`);
    }
  }
  return list.join('; ');
}
async function storeCookie(line) {
  let [pair, ...attrs] = String(line).split(';');
  let eq = pair.indexOf('=');
  if (eq < 1) return;
  let name = pair.slice(0, eq).trim();
  let value = pair.slice(eq + 1).trim();
  let o = { name, value, path: '/' };
  for (let a of attrs) {
    let [k, ...v] = a.trim().split('=');
    let val = v.join('=');
    k = k.toLowerCase();
    if (k === 'path' && val) o.path = val;
    if (k === 'max-age') o.expires = Date.now() + Number(val) * 1000;
    if (k === 'expires' && o.expires == null) o.expires = Date.parse(val);
    if (k === 'samesite') o.sameSite = val.toLowerCase();
  }
  let expired = o.expires != null && o.expires <= Date.now();
  if (self.cookieStore) {
    try {
      if (expired) await self.cookieStore.delete({ name, path: o.path });
      else await self.cookieStore.set({ name, value, path: o.path, expires: o.expires ?? null, sameSite: ['strict', 'lax', 'none'].includes(o.sameSite) ? o.sameSite : 'lax' });
    } catch {}
  } else if (expired) memJar.delete(name);
  else memJar.set(name, o);
}

/* ---------- HTML ---------- */

/**
 * Links, forms and frames that leave this in-world origin go through the target's bootstrap
 * (navigations to a subdomain without our worker would reach the static server). Subresources
 * need nothing: whatever URL they name, this worker answers them. A small script reports the
 * page's in-world URL and title to the browser and catches links added later.
 */
function rewriteHtml(html, baseWorldUrl) {
  let nav = /(<(?:a|area|form|iframe|frame)\b[^>]*?\s(?:href|action|src)\s*=\s*)(["'])([^"']*)\2/gi;
  html = html.replace(nav, (m, pre, q, url) => {
    if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) return m;
    try {
      let abs = new URL(url, baseWorldUrl);
      return pre + q + navUrlOf(abs.href).replace(/&/g, '&amp;') + q;
    } catch {
      return m;
    }
  });
  let inject = `<script src="/other/web/page.js" data-world="${baseWorldUrl.replace(/"/g, '&quot;')}"></script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (h) => h + inject);
  return inject + html;
}

/* ---------- fetch ---------- */

let ISOLATION = { 'Cross-Origin-Embedder-Policy': 'credentialless', 'Cross-Origin-Resource-Policy': 'cross-origin' };

function errorPage(status, title, detail, worldUrl = '') {
  let esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  let html = `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title><script src="/other/web/page.js" data-world="${esc(worldUrl)}" data-error="1"></script><body style="font:15px system-ui;padding:3em;color:#334;background:#f6f7fb"><h2>${esc(title)}</h2><p>${esc(worldUrl)}</p><p>${esc(detail)}</p></body>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...ISOLATION } });
}

async function handle(ev) {
  let req = ev.request;
  let worldUrl = worldUrlOf(req.url);
  if (!worldUrl) return errorPage(400, 'Bad address', req.url);
  let headers = {};
  for (let [k, v] of req.headers) {
    if (['cookie', 'accept-encoding', 'host', 'connection'].includes(k)) continue;
    if (k === 'origin' || k === 'referer') {
      let w = worldUrlOf(v) || v;
      headers[k] = k === 'origin' ? new URL(w).origin : w;
    } else headers[k] = v;
  }
  let cookies = await cookieHeader(worldUrl);
  if (cookies && new URL(worldUrl).origin === SELF_WORLD) headers.cookie = cookies;
  let body = ['GET', 'HEAD'].includes(req.method) ? null : await req.arrayBuffer();
  let res;
  try {
    res = await relay({ method: req.method, url: worldUrl, headers, body });
  } catch (err) {
    return errorPage(502, "This site can't be reached", err.message, worldUrl);
  }
  if (res.error) return errorPage(502, "This site can't be reached", res.error, worldUrl);
  let out = new Headers(ISOLATION);
  let location = null;
  for (let [k, v] of res.headers) {
    let lk = k.toLowerCase();
    if (lk === 'set-cookie') {
      if (new URL(worldUrl).origin === SELF_WORLD) await storeCookie(v);
      continue;
    }
    if (['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'cross-origin-resource-policy'].includes(lk)) continue;
    if (lk === 'location') {
      location = new URL(v, worldUrl).href;
      continue;
    }
    out.append(k, v);
  }
  if (location && res.status >= 300 && res.status < 400) {
    out.set('Location', req.mode === 'navigate' ? navUrlOf(location) : location);
    return new Response(null, { status: res.status, headers: out });
  }
  let bodyOut = res.body;
  if (req.mode === 'navigate' && /text\/html/i.test(out.get('content-type') || '')) {
    bodyOut = rewriteHtml(new TextDecoder().decode(res.body), worldUrl);
  }
  return new Response([101, 204, 205, 304].includes(res.status) || req.method === 'HEAD' ? null : bodyOut, { status: res.status, statusText: res.statusText, headers: out });
}

self.addEventListener('fetch', (ev) => {
  let url = new URL(ev.request.url);
  // The engine's own files (bootstrap, broker, page script, this worker) come from the server.
  if (url.origin === location.origin && (url.pathname.startsWith('/other/web/') || url.pathname === '/tbweb-sw.js')) return;
  ev.respondWith(handle(ev));
});
