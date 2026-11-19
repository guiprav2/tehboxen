/**
 * A box's kernel: the Worker that *is* one machine of the world (named
 * 'box:<id>', so other/vfs.js opens that box's own store). It owns the
 * box's network stack, provisions the box from its image on first boot,
 * runs /etc/rc as root, and serves requests from the page (exec, consoles).
 *
 * Everything else (shell, node and WASI processes, packages) is the same
 * code as on the player's machine: module singletons are per realm, so
 * here they are this box's.
 *
 * The root computer (id 'root') is a box too: it holds the world's
 * description under /world (other/box/root.js) and has no network.
 */
import * as vfs from '../vfs.js';
import { Stack } from '../net/stack.js';
import { parseCidr } from '../net/ip.js';
import { setLocalNet, setHostname } from '../net/local.js';

let BOX = vfs.BOX_ID;
let stack = null;
let spec = {};
let seq = 0;
let pending = new Map();
let shells = [];
let macTables = {}; // ifname → { ip: mac } of the segment (pushed by the fabric)

let post = (m, transfer) => self.postMessage(m, transfer || []);
let log = (text) => post({ t: 'log', text });

/** kernel → page request. */
export function pageRpc(op, args = {}) {
  let id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ t: 'rpc', id, op, args });
  });
}

let readText = async (abs) => {
  let key = String(abs).replace(/^\/+/, '');
  try {
    let v = await vfs.withLock(key, (lease) => vfs.read(key, { lease }), { mode: 'r' });
    return v == null ? null : typeof v === 'string' ? v : await new Response(v).text();
  } catch {
    return null;
  }
};
let writeText = (abs, text, mode = 0o644, uid = 0, gid = 0) => vfs.writeMany([{ path: String(abs).replace(/^\/+/, ''), data: String(text), mode, uid, gid }], { uid: 0, gid: 0 });

/** A root shell (or `user`'s) on this box. */
async function shellFor(user = 'root') {
  let { createShell } = await import('../shell.js');
  let sh = createShell(vfs.createVfsFs(), { home: user === 'root' ? 'root' : `home/${user}` });
  await sh.become(user);
  return sh;
}

/* ---------- provisioning ---------- */

async function provision() {
  if (BOX === 'root') return;
  let image = spec.image || 'base';
  let marker = await readText('/var/lib/box/provisioned');
  let want = `${image}`;
  let got = (marker || '').trim();
  if (got && got.split('@')[0] === want && !spec.reprovision) return;
  log(`provisioning from image ${image}`);
  let img = await pageRpc('image', { name: image });
  await applyImage(img);
  await writeText('/var/lib/box/provisioned', `${image}@${img.version || 1}\n`);
}

async function applyImage(img) {
  for (let g of img.groups || []) {
    let cur = (await vfs.listGroups())[g.name];
    await vfs.saveGroup({ name: g.name, gid: Number(g.gid ?? cur?.gid ?? (await vfs.nextGid())), members: [...new Set([...(cur?.members || []), ...(g.members || [])])] });
  }
  for (let u of [...(img.users || []), ...(spec.users || [])]) {
    let cur = (await vfs.listUsers())[u.name];
    let uid = Number(u.uid ?? cur?.uid ?? (await vfs.nextUid()));
    let gid = Number(u.gid ?? cur?.gid ?? uid);
    let home = String(u.home ?? (u.name === 'root' ? 'root' : `home/${u.name}`)).replace(/^\/+/, '');
    if (!(await vfs.listGroups())[u.name] && gid === uid) await vfs.saveGroup({ name: u.name, gid, members: [u.name] });
    await vfs.saveUser({ name: u.name, uid, gid, home, shell: u.shell || '/bin/sh', gecos: u.gecos || u.name });
    for (let gname of u.groups || []) {
      let g = (await vfs.listGroups())[gname];
      if (g && !g.members.includes(u.name)) await vfs.saveGroup({ ...g, members: [...g.members, u.name] });
    }
    if (u.password != null) await vfs.setPassword(u.name, String(u.password));
    if (home && !(await vfs.exists(home + '/.keep'))) await vfs.writeMany([{ path: home + '/.keep', data: '', mode: 0o644, uid, gid }], { uid, gid, dirMode: 0o755 });
    if (home) {
      let st = await vfs.getStat(home);
      await vfs.setStat(home, { ...(st || {}), kind: 'dir', mode: u.homeMode ? parseInt(u.homeMode, 8) : home === 'root' ? 0o700 : 0o750, uid, gid });
    }
  }
  // Box-specific files (box.yaml `files: { /etc/x: "text" | { data, mode, owner, group } }`) win over the image.
  let extra = Object.entries(spec.files || {}).map(([p, v]) => (typeof v === 'string' ? { path: p, data: v } : { path: p, ...v, mode: v.mode != null ? parseInt(v.mode, 8) : undefined }));
  let files = [...(img.files || []).filter((f) => !extra.some((e) => e.path.replace(/^\/+/, '') === f.path)), ...extra.map((e) => ({ ...e, path: e.path.replace(/^\/+/, '') }))];
  let users = await vfs.listUsers();
  let groups = await vfs.listGroups();
  let idOf = (v, table, fallback) => (v == null ? fallback : /^\d+$/.test(String(v)) ? Number(v) : Number(table[v]?.uid ?? table[v]?.gid ?? fallback));
  for (let i = 0; i < files.length; i += 200) {
    await vfs.writeMany(
      files.slice(i, i + 200).map((f) => ({ path: f.path, data: f.data, mode: f.mode ?? 0o644, uid: idOf(f.owner ?? f.uid, users, 0), gid: idOf(f.group ?? f.gid, groups, 0) })),
      { uid: 0, gid: 0, dirMode: 0o755 },
    );
  }
  if (img.packages?.length) {
    let { installPackage } = await import('../packages.js');
    for (let name of img.packages) {
      try {
        await installPackage(name);
      } catch (err) {
        log(`package ${name}: ${err?.message || err}`);
      }
    }
  }
}

/** Keep engine-owned packages current (unattended upgrades). */
async function upgradePackages() {
  let { PACKAGES, installedInfo, installPackage } = await import('../packages.js');
  for (let [name, p] of Object.entries(PACKAGES)) {
    let info = await installedInfo(name);
    if (info && info.version !== p.version) {
      log(`upgrading ${name} ${info.version} → ${p.version}`);
      await installPackage(name, { force: true }).catch((err) => log(`upgrade ${name}: ${err?.message || err}`));
    }
  }
}

/* ---------- network ---------- */

async function startNetwork() {
  let hostname = spec.hostname || (await readText('/etc/hostname'))?.trim() || BOX;
  stack = new Stack({
    hostname,
    transmit: (ifname, nextHop, pkt) => post({ t: 'tx', ifname, nextHop, pkt }),
    log,
  });
  setLocalNet({ stack, hostname, boxId: BOX, readFile: readText });
  // Neighbors' MACs come from the fabric (per interface); injected frames go back to it.
  stack.macOf = (ifname, ip) => macTables[ifname]?.[ip] || null;
  stack.transmitFrame = (ifname, mac, kind, payload) => post({ t: 'txframe', ifname, mac, kind, payload });
  setHostname(hostname);
  if (BOX === 'root') return;
  stack.bootGraceUntil = Date.now() + 20000;
  if ((await readText('/etc/hostname')) == null) await writeText('/etc/hostname', hostname + '\n');
  let hosts = await readText('/etc/hosts');
  if (hosts == null) await writeText('/etc/hosts', `127.0.0.1\tlocalhost\n127.0.1.1\t${hostname}\n`);
  let dhcp = [];
  for (let i of spec.interfaces || []) {
    stack.addIface(i.name, { mac: i.mac, segment: i.segment });
    let c = parseCidr(i.addr);
    if (c) stack.addAddr(i.name, c.ip, c.prefix);
    else if (i.addr === 'dhcp') dhcp.push(i);
    if (c && i.gateway) {
      try {
        stack.addRoute({ dst: '0.0.0.0', prefix: 0, via: i.gateway, dev: i.name });
      } catch {}
    }
    if (c && i.onlink) stack.addRoute({ dst: '0.0.0.0', prefix: 0, dev: i.name });
  }
  if ((await readText('/etc/resolv.conf')) == null) {
    let ns = spec.dns || ['8.8.8.8', '1.1.1.1'];
    await writeText('/etc/resolv.conf', ns.map((n) => `nameserver ${n}`).join('\n') + '\n');
  }
  let rules = await readText('/etc/iptables/rules.v4');
  if (rules) {
    try {
      stack.nf.restore(rules);
    } catch (err) {
      log(`iptables-restore: ${err.message}`);
    }
  }
  let sysctl = await readText('/etc/sysctl.conf');
  for (let line of String(sysctl || '').split('\n')) {
    let m = /^\s*([\w.]+)\s*=\s*(\S+)/.exec(line);
    if (m && m[1] in stack.sysctl) stack.sysctl[m[1]] = m[2];
  }
  let report = () => post({ t: 'addrs', addrs: Object.fromEntries([...stack.ifaces.values()].filter((i) => !i.loopback).map((i) => [i.name, i.addrs.map((a) => a.ip)])) });
  stack.on('change', report);
  report();
  // DHCP until busybox udhcpc is ported (then /etc/rc runs it).
  for (let i of dhcp) {
    import('../net/dhcp.js').then(async ({ dhcpClient }) => {
      try {
        let lease = await dhcpClient(stack, i.name, { hostname, requested: spec.lastLease?.[i.name] });
        pageRpc('saveLease', { ifname: i.name, ip: lease.ip }).catch(() => {});
        if (lease.dns.length && !spec.dns) await writeText('/etc/resolv.conf', (lease.domain ? `search ${lease.domain}\n` : '') + lease.dns.map((n) => `nameserver ${n}`).join('\n') + '\n');
      } catch (err) {
        log(`dhclient ${i.name}: ${err.message}`);
      }
    });
  }
}

/* ---------- init ---------- */

async function runRc() {
  if (BOX === 'root') return;
  let rc = await readText('/etc/rc');
  if (rc == null) return;
  let sh = await shellFor('root');
  shells.push(sh); // keeps rc's background jobs (daemons) referenced
  sh.setBackgroundSink((text) => log(String(text).trimEnd()));
  let r = await sh.run('sh /etc/rc');
  if (r.code) log(`/etc/rc exited ${r.code}: ${(r.stderr || '').trim().slice(0, 500)}`);
}

async function boot(msg) {
  spec = msg.spec || {};
  await vfs.ensureReady();
  if (BOX === 'root') {
    let { seedWorld } = await import('./root.js');
    await seedWorld();
  } else {
    await provision();
    await upgradePackages().catch(() => {});
  }
  // Base system (busybox) in the background: commands that need it wait for it.
  import('../packages.js').then((m) => m.ensureBaked()).catch(() => {});
  await startNetwork();
  await runRc();
  // Daemons started by rc get a few seconds to listen; then closed ports refuse again.
  if (stack) stack.bootGraceUntil = Date.now() + 5000;
  post({ t: 'up' });
}

/* ---------- page → kernel ---------- */

let ops = {
  /** Run a command line (as root, or `user`): { code, stdout, stderr }. */
  async exec({ cmd, user = 'root', cwd }) {
    let sh = await shellFor(user);
    if (cwd) await sh.run(`cd ${JSON.stringify(cwd)}`);
    return sh.run(String(cmd));
  },
  /** Write a file into the box (world building / provisioning): data is text or bytes. */
  async put({ path, data, mode = 0o644, owner = 0, group = 0 }) {
    await vfs.writeMany([{ path: String(path).replace(/^\/+/, ''), data, mode, uid: Number(owner) || 0, gid: Number(group) || 0 }], { uid: 0, gid: 0, dirMode: 0o755 });
    return true;
  },
  /** Read a file: text, or bytes for binary content; null if missing. */
  async get({ path }) {
    let key = String(path).replace(/^\/+/, '');
    let v = await vfs.withLock(key, (lease) => vfs.read(key, { lease }), { mode: 'r' }).catch(() => null);
    if (v == null || typeof v === 'string') return v;
    return new Uint8Array(await new Response(v).arrayBuffer());
  },
  async ping() {
    return { box: BOX, hostname: stack?.hostname, addrs: stack ? Object.fromEntries([...stack.ifaces.values()].map((i) => [i.name, i.addrs.map((a) => `${a.ip}/${a.prefix}`)])) : {} };
  },
};

self.addEventListener('message', async (ev) => {
  let m = ev.data || {};
  if (m.t === 'frame') return stack?.receive(m.ifname, m.pkt);
  if (m.t === 'arpfail') return stack?.arpFailed(m.ifname, m.pkt);
  if (m.t === 'arp') return stack?.receiveArp(m.ifname, m.arp, m.srcMac);
  if (m.t === 'macs') {
    macTables[m.ifname] = m.table;
    return;
  }
  if (m.t === 'boot') {
    try {
      await boot(m);
    } catch (err) {
      log(`boot failed: ${err?.stack || err}`);
      post({ t: 'up' });
    }
    return;
  }
  if (m.t === 'res') {
    let p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    return m.ok ? p.resolve(m.value) : p.reject(Object.assign(new Error(m.error?.message || 'error'), m.error));
  }
  if (m.t === 'rpc') {
    try {
      let fn = ops[m.op];
      if (!fn && BOX === 'root') fn = (await import('./root.js')).rootOps[m.op];
      if (!fn) throw new Error(`unknown op ${m.op}`);
      let value = await fn(m.args || {});
      post({ t: 'res', id: m.id, ok: true, value });
    } catch (err) {
      post({ t: 'res', id: m.id, ok: false, error: { message: String(err?.message || err), code: err?.code } });
    }
  }
});

export { ops as kernelOps, shellFor, readText, writeText, log as kernelLog };
