/**
 * Network boot on the desktop page: start the root computer, read the world
 * from it, build the fabric (segments, JS routers, every box) and bring up
 * the player's own machine ('local': this page) on its segment.
 *
 * Only one tab hosts the world at a time (Web Locks): boxes have their own
 * stores and daemons, and two copies would fight over them. Other tabs get a
 * machine with loopback only and say why.
 */
import * as vfs from '../vfs.js';
import { Fabric, BoxHandle } from './fabric.js';
import { Stack } from './stack.js';
import { parseCidr } from './ip.js';
import { macFor } from './router.js';
import { setLocalNet } from './local.js';

let fabric = null;
let started = null;
export let networkStatus = { state: 'off', message: '' };

export let getFabric = () => fabric;

let readText = async (abs) => {
  let key = String(abs).replace(/^\/+/, '');
  try {
    let v = await vfs.withLock(key, (lease) => vfs.read(key, { lease }), { mode: 'r' });
    return v == null ? null : typeof v === 'string' ? v : await new Response(v).text();
  } catch {
    return null;
  }
};
let writeRoot = (abs, text) => vfs.writeMany([{ path: String(abs).replace(/^\/+/, ''), data: String(text), mode: 0o644, uid: 0, gid: 0 }], { uid: 0, gid: 0 });

/** Start once per page (idempotent). */
export function startNetwork() {
  started ??= boot().catch((err) => {
    networkStatus = { state: 'error', message: String(err?.message || err) };
    console.warn('[net] boot failed', err);
  });
  return started;
}

async function hostTheWorld() {
  if (!navigator.locks?.request) return true;
  return new Promise((resolve) => {
    navigator.locks.request('tehboxen-world', { ifAvailable: true }, (lock) => {
      if (!lock) return resolve(false);
      resolve(true);
      return new Promise(() => {}); // held for the page's lifetime
    });
  });
}

async function boot() {
  await vfs.ensureReady();
  if (!(await hostTheWorld())) {
    let stack = new Stack({ hostname: 'tehboxen' });
    setLocalNet({ stack, hostname: 'tehboxen', boxId: 'local', readFile: readText });
    networkStatus = { state: 'offline', message: 'the world is running in another tab; this tab has loopback only' };
    return;
  }
  networkStatus = { state: 'booting', message: '' };
  fabric = new Fabric();
  let root = new BoxHandle(fabric, 'root', {});
  fabric.boxes.set('root', root);
  await root.wake();
  let world = await root.rpc('world.read');
  let spec = world.boxes?.local || { hostname: 'tehboxen', interfaces: [] };
  let hostname = spec.hostname || 'tehboxen';
  let stack = new Stack({ hostname, transmit: (ifname, nextHop, pkt) => fabric.transmit('box:local', ifname, nextHop, pkt) });
  let dhcp = [];
  for (let i of spec.interfaces || []) {
    stack.addIface(i.name, { mac: i.mac || macFor(`local/${i.name}`), segment: i.segment });
    fabric.attach('box:local', i.name, i.segment, stack);
    let c = parseCidr(i.addr);
    if (c) {
      stack.addAddr(i.name, c.ip, c.prefix);
      if (i.gateway) stack.addRoute({ dst: '0.0.0.0', prefix: 0, via: i.gateway, dev: i.name });
    } else if (i.addr === 'dhcp') dhcp.push(i);
  }
  let rules = await readText('/etc/iptables/rules.v4');
  if (rules) {
    try {
      stack.nf.restore(rules);
    } catch (err) {
      console.warn('[net] iptables-restore', err.message);
    }
  }
  setLocalNet({ stack, hostname, boxId: 'local', readFile: readText });
  if ((await readText('/etc/hosts')) == null) await writeRoot('/etc/hosts', `127.0.0.1\tlocalhost\n127.0.1.1\t${hostname}\n`);
  // Routers first (DHCP needs them), every other box boots in the background.
  let built = fabric.build(world);
  await fabric.routersReady;
  for (let i of dhcp) {
    let { dhcpClient } = await import('./dhcp.js');
    try {
      let lease = await dhcpClient(stack, i.name, { hostname, requested: spec.lastLease?.[i.name] });
      await writeRoot('/etc/resolv.conf', (lease.domain ? `search ${lease.domain}\n` : '') + lease.dns.map((n) => `nameserver ${n}`).join('\n') + '\n');
      root.rpc('world.saveBoxLease', { box: 'local', ifname: i.name, ip: lease.ip }).catch(() => {});
    } catch (err) {
      console.warn(`[net] dhclient ${i.name}:`, err.message);
    }
  }
  networkStatus = { state: 'up', message: '' };
  await built;
}

/** Re-read /world from the root computer and apply it (new/changed/removed boxes, routers). */
export async function applyWorld() {
  if (!fabric) throw new Error('the world is not running in this tab');
  let world = await fabric.boxes.get('root').rpc('world.read');
  await fabric.build(world);
  return listBoxes();
}

/** Boxes and routers with their state and addresses. */
export function listBoxes() {
  if (!fabric) return [];
  let out = [];
  for (let [id, h] of fabric.boxes) out.push({ id, kind: 'box', state: h.state, hostname: h.spec.hostname || (id === 'root' ? 'root' : id), image: h.spec.image || (id === 'root' ? null : 'base'), addrs: h.addrs });
  for (let [id, r] of fabric.routers) out.push({ id, kind: 'router', state: 'up', hostname: r.cfg.hostname || id, addrs: Object.fromEntries([...r.stack.ifaces.values()].filter((i) => !i.loopback).map((i) => [i.name, i.addrs.map((a) => a.ip)])) });
  return out;
}

/** A box's handle (wakes it), for exec/put/get from the dbg RPC and worldctl. */
export async function boxHandle(id) {
  if (!fabric) throw new Error('the world is not running in this tab');
  let h = fabric.boxes.get(id);
  if (!h) throw Object.assign(new Error(`no such box: ${id}`), { code: 'ENOENT' });
  await h.wake();
  return h;
}

/**
 * Factory reset of the whole world: power off every box and delete the stores
 * of the root computer and all boxes (the player's own store is wiped by
 * vfs.factoryReset). The next desktop boot reseeds /world and reprovisions.
 */
export async function wipeWorld() {
  if (fabric) {
    for (let r of fabric.routers.values()) r.stop();
    for (let h of fabric.boxes.values()) h.stop();
  }
  let names = [];
  try {
    names = (await indexedDB.databases()).map((d) => d.name).filter((n) => /^tehboxen-box-/.test(n || ''));
  } catch {}
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          let req = indexedDB.deleteDatabase(name);
          req.onsuccess = req.onerror = () => resolve();
          // Still open somewhere (a worker shutting down): it completes once closed.
          req.onblocked = () => setTimeout(resolve, 500);
        }),
    ),
  );
  return names;
}
