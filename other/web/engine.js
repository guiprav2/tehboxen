/**
 * The desktop side of the in-world web browser. Pages of an in-world origin live on their own
 * real subdomain (other/web/hosts.js) with a service worker (tbweb-sw.js) that sends every request
 * here through a hidden broker frame of that origin (other/web/broker.html). This module answers
 * them over the player's own network stack, as the player — the same net/http/https/tls modules
 * node programs get (other/node/netmods.js, other/node/tls.js), so HTTPS is verified against the
 * world's trust bundle and DNS, routing and firewalls apply like for any program on the box.
 *
 *   import { initWebEngine, bootUrl } from './web/engine.js';
 *   initWebEngine();                       // once, on the desktop
 *   iframe.src = bootUrl('https://example.box/');
 *   onWebPage((frameWindow, { url, title }) => …);   // pages report where they are
 */
import { Buffer } from 'https://cdn.jsdelivr.net/npm/buffer@6.0.3/+esm';
import { createNetModules } from '../node/netmods.js';
import { createProcNet } from '../net/procnet.js';
import { actorFromUser } from '../vfs-auth.js';
import { PLAYER } from '../session.js';
import * as vfs from '../vfs.js';
import { engineHost, bootUrl, worldUrlOf } from './hosts.js';

export { bootUrl, worldUrlOf };

let CA = '/etc/ssl/certs/ca-certificates.crt';
let caText = '';
let modsPromise = null;
let brokers = new Map(); // engine origin → { frame, ready: Promise }
let pageListeners = new Set();
let started = false;

async function readText(abs) {
  let key = abs.replace(/^\/+/, '');
  try {
    let v = await vfs.withLock(key, (lease) => vfs.read(key, { lease }), { mode: 'r' });
    return v == null ? '' : typeof v === 'string' ? v : await new Response(v).text();
  } catch {
    return '';
  }
}

function netMods() {
  modsPromise ??= (async () => {
    let actor = await actorFromUser(PLAYER);
    let listeners = [];
    let procNet = createProcNet({ actor, pid: 0, comm: 'browser', push: (m) => listeners.forEach((f) => f(m)) });
    caText = await readText(CA);
    return createNetModules({
      sys: { async: (op, args) => procNet.call(op, args), sync: () => Promise.reject(new Error('no sync syscalls on the page')) },
      ref: () => () => {},
      subscribe: (f) => listeners.push(f),
      readFile: (p) => {
        if (p === CA) return caText;
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      },
    });
  })();
  return modsPromise;
}

/** One HTTP(S) exchange over the simulated network: { status, statusText, headers: [[k, v]…], body } | { error }. */
export async function worldFetch({ method = 'GET', url, headers = {}, body = null }) {
  let { http, https } = await netMods();
  let u = new URL(url);
  let mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    let done = (v) => resolve(v);
    let req = mod.request({ method, hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { ...headers, connection: 'close' } }, (res) => {
      let chunks = [];
      res.on('data', (c) => chunks.push(Buffer.from(c)));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        let pairs = [];
        for (let i = 0; i < (res.rawHeaders || []).length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        done({ status: res.statusCode, statusText: res.statusMessage || '', headers: pairs, body: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });
      });
      res.on('error', (e) => done({ error: e.message }));
    });
    req.on('error', (e) => done({ error: errorText(e, u) }));
    req.setTimeout?.(30000, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    if (body) req.write(Buffer.from(body));
    req.end();
  });
}

function errorText(e, u) {
  let code = e?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `DNS_PROBE_FINISHED_NXDOMAIN — ${u.hostname} doesn't resolve`;
  if (code === 'ECONNREFUSED') return `ERR_CONNECTION_REFUSED — nothing is listening on ${u.hostname}:${u.port || (u.protocol === 'https:' ? 443 : 80)}`;
  if (code === 'ETIMEDOUT') return `ERR_TIMED_OUT — ${u.hostname} didn't answer`;
  if (/CERT|SELF_SIGNED|UNABLE_TO|ALTNAME/.test(code)) return `NET::ERR_CERT_INVALID — ${e.message} (${code})`;
  return `${code} ${e?.message || e}`.trim();
}

/** A hidden broker frame for an engine origin (one per in-world site, kept for the session). */
function ensureBroker(origin) {
  let b = brokers.get(origin);
  if (b) return b.ready;
  let frame = document.createElement('iframe');
  frame.hidden = true;
  frame.setAttribute('aria-hidden', 'true');
  frame.style.display = 'none';
  let resolve;
  let ready = new Promise((r) => (resolve = r));
  brokers.set(origin, { frame, ready, resolve });
  frame.src = `${origin}/other/web/broker.html`;
  document.body.append(frame);
  return ready;
}

function connectBroker(origin, source) {
  let b = brokers.get(origin);
  if (!b || b.frame.contentWindow !== source) return;
  let ch = new MessageChannel();
  ch.port1.onmessage = async (ev) => {
    let m = ev.data;
    let reply = ev.ports[0];
    if (m?.t !== 'fetch' || !reply) return;
    let res;
    try {
      // Re-read the trust bundle now and then: the world may have rotated its CAs.
      if (!caText) caText = await readText(CA);
      res = await worldFetch(m.req);
    } catch (err) {
      res = { error: String(err?.message || err) };
    }
    reply.postMessage(res, res.body ? [res.body] : []);
  };
  b.frame.contentWindow.postMessage({ t: 'tbweb-broker-port' }, origin, [ch.port2]);
  b.resolve(true);
}

/** Pages report { url, title } (tbweb-page); the browser app matches frames by window. */
export function onWebPage(fn) {
  pageListeners.add(fn);
  return () => pageListeners.delete(fn);
}

export function initWebEngine() {
  if (started) return;
  started = true;
  let suffix = '.' + engineHost();
  addEventListener('message', async (ev) => {
    let m = ev.data;
    if (!m || typeof m.t !== 'string' || !m.t.startsWith('tbweb-')) return;
    let host;
    try {
      host = new URL(ev.origin).host;
    } catch {
      return;
    }
    if (!host.endsWith(suffix)) return; // only the engine's own subdomains
    if (m.t === 'tbweb-need-broker') {
      if (m.origin !== ev.origin) return;
      for (let fn of pageListeners) fn(ev.source, { boot: true });
      await ensureBroker(ev.origin);
      ev.source?.postMessage({ t: 'tbweb-broker-ok', id: m.id }, ev.origin);
    } else if (m.t === 'tbweb-broker-ready') connectBroker(ev.origin, ev.source);
    else if (m.t === 'tbweb-page') for (let fn of pageListeners) fn(ev.source, { url: String(m.url || worldUrlOf(ev.origin) || ''), title: String(m.title || ''), error: !!m.error });
  });
}
