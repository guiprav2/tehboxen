/**
 * npm registry access from the browser.
 *
 * registry.npmjs.org sends `Access-Control-Allow-Origin: *` on GETs but 404s
 * CORS preflights, so every request must stay "simple": GET with only the
 * safelisted Accept header. Abbreviated packuments (the install format npm
 * itself uses) keep metadata small.
 */
export let REGISTRY = 'https://registry.npmjs.org';

let dec = new TextDecoder();
let packuments = new Map(); // name → Promise<packument>, per page, 5 min TTL

let encName = (name) => (name.startsWith('@') ? '@' + encodeURIComponent(name.slice(1)) : encodeURIComponent(name));

/** Abbreviated (install) metadata, or the full document with { full: true }. */
export function packument(name, { full = false, registry = REGISTRY } = {}) {
  let key = (full ? 'full:' : '') + name;
  let hit = packuments.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.promise;
  let promise = (async () => {
    let res = await fetch(`${registry}/${encName(name)}`, {
      headers: full ? {} : { Accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
    });
    if (res.status === 404) throw Object.assign(new Error(`404 Not Found - GET ${registry}/${encName(name)} - Not found\n\n'${name}' is not in this registry.`), { code: 'E404' });
    if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} - GET ${registry}/${encName(name)}`), { code: 'E' + res.status });
    return res.json();
  })();
  packuments.set(key, { at: Date.now(), promise });
  promise.catch(() => packuments.delete(key));
  return promise;
}

function b64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Verify an SRI string ("sha512-…", possibly several) or a legacy sha1 hex shasum. */
async function verify(bytes, integrity, shasum) {
  if (integrity) {
    let ok = false;
    for (let part of String(integrity).split(/\s+/)) {
      let m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(part);
      if (!m) continue;
      let algo = { sha512: 'SHA-512', sha384: 'SHA-384', sha256: 'SHA-256', sha1: 'SHA-1' }[m[1]];
      let digest = b64(new Uint8Array(await crypto.subtle.digest(algo, bytes)));
      if (digest === m[2]) ok = true;
      else return false;
    }
    if (ok) return true;
  }
  if (shasum) {
    let hex = [...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex === shasum;
  }
  return true;
}

/** Download a tarball, check its integrity, gunzip and untar it. */
export async function fetchTarball({ resolved, integrity, shasum, name, version }) {
  let res = await fetch(resolved);
  if (!res.ok) throw Object.assign(new Error(`${res.status} ${res.statusText} - GET ${resolved}`), { code: 'E' + res.status });
  let gz = new Uint8Array(await res.arrayBuffer());
  if (!(await verify(gz, integrity, shasum))) {
    throw Object.assign(new Error(`Integrity check failed for ${name}@${version} (${resolved})\n  wanted: ${integrity || shasum}`), { code: 'EINTEGRITY' });
  }
  let tar = new Uint8Array(await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  return untar(tar);
}

/* ---------- tar ---------- */

function cstr(bytes, off, len) {
  let end = off;
  while (end < off + len && bytes[end] !== 0) end++;
  return dec.decode(bytes.subarray(off, end));
}
function octal(bytes, off, len) {
  let s = cstr(bytes, off, len).trim();
  return s ? parseInt(s, 8) : 0;
}

/**
 * Minimal tar reader (ustar + pax + GNU long names), npm-tarball flavored:
 * the leading "package/" (or whatever single top folder) is stripped.
 * @returns {Array<{ path: string, data: Uint8Array, mode: number }>}
 */
export function untar(bytes) {
  let out = [];
  let off = 0;
  let longName = null;
  let pax = {};
  while (off + 512 <= bytes.length) {
    let header = bytes.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    let name = cstr(header, 0, 100);
    let mode = octal(header, 100, 8);
    let size = octal(header, 124, 12);
    let type = String.fromCharCode(header[156] || 48);
    let magic = cstr(header, 257, 6);
    if (magic.startsWith('ustar')) {
      let prefix = cstr(header, 345, 155);
      if (prefix) name = prefix + '/' + name;
    }
    let dataStart = off + 512;
    let data = bytes.subarray(dataStart, dataStart + size);
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === 'x' || type === 'g') {
      let text = dec.decode(data);
      let rec = {};
      for (let line of text.split('\n')) {
        let m = /^\d+ ([^=]+)=(.*)$/.exec(line);
        if (m) rec[m[1]] = m[2];
      }
      if (type === 'x') pax = rec;
      continue;
    }
    let path = pax.path || longName || name;
    longName = null;
    pax = {};
    if (type !== '0' && type !== '\0' && type !== '7') continue; // directories / links: implied by files
    let clean = path.replace(/^\.\//, '').split('/').slice(1).join('/');
    if (!clean || clean.split('/').includes('..')) continue;
    out.push({ path: clean, data: data.slice(), mode: mode & 0o777 });
  }
  return out;
}
