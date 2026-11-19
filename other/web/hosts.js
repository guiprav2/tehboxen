/**
 * The web browser's address space. Every in-world origin (scheme, host, port) is served from its
 * own real subdomain of the engine host, so the real browser isolates their cookies, storage,
 * service workers and windows exactly like the Internet's:
 *
 *   https://resolver1.public-dns.net      → sxresolver1-public--dns-net.web.<desktop host>
 *   http://shop.example.box:8080          → h8080xshop-example-box.web.<desktop host>
 *
 * label = 's' (https) | 'h' (http), the port when it isn't the default, 'x', then the host with
 * '-' → '--' and '.' → '-'. The engine host is "web." + the desktop's host and port (dev: any
 * *.localhost resolves to 127.0.0.1; deployed: a wildcard DNS record and certificate).
 * tbweb-sw.js carries a copy of this codec (service workers here are classic scripts).
 */
export let engineHost = (loc = location) => `web.${loc.hostname}${loc.port ? ':' + loc.port : ''}`;
export let engineScheme = (loc = location) => loc.protocol;

export function labelOf(worldOrigin) {
  let u = new URL(worldOrigin);
  let https = u.protocol === 'https:';
  if (!https && u.protocol !== 'http:') throw new Error(`unsupported scheme ${u.protocol}`);
  let port = u.port && Number(u.port) !== (https ? 443 : 80) ? u.port : '';
  let label = (https ? 's' : 'h') + port + 'x' + u.hostname.toLowerCase().replace(/-/g, '--').replace(/\./g, '-');
  if (label.length > 63) throw new Error(`${u.hostname}: host name too long for the browser`);
  return label;
}

export function originOfLabel(label) {
  let m = /^([hs])(\d*)x(.+)$/.exec(label || '');
  if (!m) return null;
  let host = '';
  for (let i = 0; i < m[3].length; i++) {
    if (m[3][i] !== '-') host += m[3][i];
    else if (m[3][i + 1] === '-') (host += '-'), i++;
    else host += '.';
  }
  return `${m[1] === 's' ? 'https' : 'http'}://${host}${m[2] ? ':' + m[2] : ''}`;
}

/** The engine origin serving an in-world URL's origin. */
export let engineOrigin = (worldUrl, loc = location) => `${engineScheme(loc)}//${labelOf(new URL(worldUrl).origin)}.${engineHost(loc)}`;

/** Where to point a frame to open `worldUrl`: through the origin's bootstrap (installs its worker). */
export function bootUrl(worldUrl, loc = location) {
  let u = new URL(worldUrl);
  return `${engineOrigin(worldUrl, loc)}/other/web/boot.html?to=${encodeURIComponent(u.pathname + u.search + u.hash)}`;
}

/** The in-world URL an engine URL stands for (null if it isn't one). */
export function worldUrlOf(engineUrl, loc = location) {
  let u = new URL(engineUrl);
  let suffix = '.' + engineHost(loc);
  if (!(u.host.endsWith(suffix))) return null;
  let origin = originOfLabel(u.host.slice(0, -suffix.length));
  return origin && origin + u.pathname + u.search + u.hash;
}
