/**
 * Stub resolver for a host: /etc/hosts, then the nameservers in
 * /etc/resolv.conf over UDP 53 (real DNS messages), like glibc's.
 * Used by node's dns module, WASI getaddrinfo, ping/ssh/curl/nc and dig.
 */
import { decodeMessage, encodeMessage, normName, reverseName, TYPES, typeNum } from './dns.js';
import { isIPv4 } from './ip.js';
import { netError } from './stack.js';

export function parseResolvConf(text) {
  let conf = { nameservers: [], search: [], timeout: 5, attempts: 2, ndots: 1 };
  for (let line of String(text || '').split('\n')) {
    let [k, ...v] = line.replace(/[#;].*$/, '').trim().split(/\s+/);
    if (k === 'nameserver' && isIPv4(v[0])) conf.nameservers.push(v[0]);
    else if (k === 'search' || k === 'domain') conf.search = v.filter(Boolean);
    else if (k === 'options')
      for (let o of v) {
        let [ok, ov] = o.split(':');
        if (ok === 'timeout') conf.timeout = Number(ov) || conf.timeout;
        if (ok === 'attempts') conf.attempts = Number(ov) || conf.attempts;
        if (ok === 'ndots') conf.ndots = Number(ov) || 0;
      }
  }
  return conf;
}

export function parseHosts(text) {
  let map = new Map();
  for (let line of String(text || '').split('\n')) {
    let [ip, ...names] = line.replace(/#.*$/, '').trim().split(/\s+/);
    if (!isIPv4(ip)) continue;
    for (let n of names) if (n && !map.has(normName(n))) map.set(normName(n), ip);
  }
  return map;
}

let seq = Math.floor(Math.random() * 65535);

/**
 * One query to one server: the decoded response (any rcode), or throws
 * ETIMEDOUT after `timeout` ms × attempts.
 */
export async function query(stack, server, name, type = 'A', { timeout = 5000, attempts = 1, rd = true, port = 53, uid = 0 } = {}) {
  let sock = stack.udpBind({ uid });
  try {
    for (let i = 0; i < attempts; i++) {
      let id = (seq = (seq + 1) & 0xffff);
      let msg = encodeMessage({ id, rd, questions: [{ name, type: typeNum(type) }] });
      try {
        sock.send(msg, { addr: server, port });
      } catch (err) {
        throw err;
      }
      let deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        let m;
        try {
          m = await sock.recv({ timeout: Math.max(1, deadline - Date.now()) });
        } catch (err) {
          if (err.code === 'EAGAIN') break;
          throw err;
        }
        if (m.from.addr !== server) continue;
        let res;
        try {
          res = decodeMessage(m.data);
        } catch {
          continue;
        }
        if (res.id === id && res.qr) return { ...res, server, bytes: m.data.length };
      }
    }
    throw netError('ETIMEDOUT', 'query', server, port);
  } finally {
    sock.close();
  }
}

/**
 * A host's resolver.
 * @param {() => import('./stack.js').Stack} getStack
 * @param {(path: string) => Promise<string|null>} readFile absolute path → text
 */
export function createResolver(getStack, readFile) {
  let cache = new Map(); // "name type" → { expires, result }

  async function conf() {
    return parseResolvConf(await readFile('/etc/resolv.conf').catch(() => null));
  }

  async function hosts() {
    let text = await readFile('/etc/hosts').catch(() => null);
    let map = parseHosts(text);
    if (!map.has('localhost')) map.set('localhost', '127.0.0.1');
    return map;
  }

  /** Ask the configured nameservers; follows CNAMEs. { rcode, answers, server } */
  async function lookupType(name, type = 'A') {
    let c = await conf();
    if (!c.nameservers.length) throw Object.assign(netError('ECONNREFUSED', 'queryA', name), { code: 'ECONNREFUSED', message: `queryA ECONNREFUSED ${name}` });
    let key = `${normName(name)} ${type}`;
    let hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.result;
    let last = null;
    for (let attempt = 0; attempt < c.attempts; attempt++) {
      for (let ns of c.nameservers) {
        try {
          let res = await query(getStack(), ns, name, type, { timeout: c.timeout * 1000 });
          if (res.rcode === 2 || res.rcode === 5) {
            last = res;
            continue;
          }
          let ttl = Math.min(...res.answers.map((a) => a.ttl), 300);
          cache.set(key, { expires: Date.now() + Math.max(0, ttl) * 1000, result: res });
          return res;
        } catch (err) {
          last = err;
        }
      }
    }
    if (last && !last.code) return last;
    throw last || netError('ETIMEDOUT', 'query', name);
  }

  /** Candidate names with the search list (ndots rule). */
  function candidates(name, c) {
    if (name.endsWith('.')) return [normName(name)];
    let dots = (name.match(/\./g) || []).length;
    let withSearch = c.search.map((s) => `${name}.${s}`);
    return dots >= c.ndots ? [name, ...withSearch] : [...withSearch, name];
  }

  /**
   * getaddrinfo-ish: IPv4 addresses for a host name (or the literal IP).
   * Errors: { code: 'ENOTFOUND' } (NXDOMAIN / no A), 'EAI_AGAIN' (no answer).
   */
  async function resolve4(name) {
    name = String(name || '').trim();
    if (isIPv4(name)) return [name];
    if (!name) throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND', hostname: name });
    let h = await hosts();
    let n = normName(name);
    if (h.has(n)) return [h.get(n)];
    if (n === 'localhost' || n.endsWith('.localhost')) return ['127.0.0.1'];
    let c = await conf();
    let timedOut = false;
    for (let cand of candidates(name, c)) {
      if (h.has(normName(cand))) return [h.get(normName(cand))];
      let res;
      try {
        res = await lookupType(cand, 'A');
      } catch {
        timedOut = true;
        continue;
      }
      if (res.rcode !== 0) continue;
      let ips = res.answers.filter((a) => a.type === TYPES.A).map((a) => a.data);
      if (ips.length) return ips;
    }
    let code = timedOut ? 'EAI_AGAIN' : 'ENOTFOUND';
    throw Object.assign(new Error(`getaddrinfo ${code} ${name}`), { __syserr: true, code, errno: timedOut ? -3001 : -3008, syscall: 'getaddrinfo', hostname: name, message: `getaddrinfo ${code} ${name}` });
  }

  async function reverse(ip) {
    let h = await hosts();
    for (let [n, a] of h) if (a === ip && n !== 'localhost') return [n];
    if (ip === '127.0.0.1') return ['localhost'];
    let res = await lookupType(reverseName(ip), 'PTR');
    let names = res.answers.filter((a) => a.type === TYPES.PTR).map((a) => normName(a.data));
    if (!names.length) throw Object.assign(new Error(`getHostByAddr ENOTFOUND ${ip}`), { __syserr: true, code: 'ENOTFOUND', syscall: 'getHostByAddr', hostname: ip });
    return names;
  }

  return { resolve4, reverse, lookupType, conf, hosts, flush: () => cache.clear() };
}
