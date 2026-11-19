/**
 * The root computer: the world-building box. It has no network; the world
 * builder (godshand) and the dbg RPC reach it out of band. Its /world tree
 * describes everything the fabric runs:
 *
 *   /world/net/segments.yaml            segments (LANs, the Internet) and their latency
 *   /world/net/routers/<id>.yaml        JS routers (other/net/router.js)
 *   /world/boxes/<id>.yaml              boxes: image, hostname, interfaces, users, files
 *   /world/images/<name>/image.yaml     image manifest (from, packages, users, groups)
 *   /world/images/<name>/rootfs/…       files copied into new boxes
 *   /world/state/                       runtime state the fabric persists (DHCP leases)
 *
 * The repo's world-seed/ is only the generic infrastructure a fresh world
 * starts with (the Internet, public DNS, a home LAN); world packs and the
 * world builder add the rest here.
 */
import YAML from 'https://cdn.jsdelivr.net/npm/yaml@2.6.1/+esm';
import * as vfs from '../vfs.js';

let SEED_BASE = new URL('../../world-seed/', import.meta.url);
let GODSHAND = 999;

let readText = async (key) => {
  try {
    let v = await vfs.withLock(key, (lease) => vfs.read(key, { lease }), { mode: 'r' });
    return v == null ? null : typeof v === 'string' ? v : await new Response(v).text();
  } catch {
    return null;
  }
};
let readBytes = async (key) => {
  let v = await vfs.withLock(key, (lease) => vfs.read(key, { lease }), { mode: 'r' });
  if (v == null) return null;
  if (typeof v === 'string') return v;
  return new Uint8Array(await new Response(v).arrayBuffer());
};

async function sha(text) {
  let h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(h)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Copy world-seed/ into /world. Files the world builder edited since they
 * were seeded are left alone; untouched ones follow seed updates.
 */
export async function seedWorld() {
  let index;
  try {
    index = await (await fetch(new URL('index.json', SEED_BASE))).json();
  } catch (err) {
    console.warn('world seed unavailable', err);
    return;
  }
  let state = JSON.parse((await readText('world/.seed.json')) || '{}');
  if (state.version === index.version) return;
  let hashes = state.hashes || {};
  let writes = [];
  for (let f of index.files) {
    let text = f.data ?? (await (await fetch(new URL(f.path, SEED_BASE))).text());
    let key = 'world/' + f.path;
    let cur = await readText(key);
    let h = await sha(text);
    if (cur != null && hashes[f.path] && (await sha(cur)) !== hashes[f.path]) continue; // edited: keep
    if (cur === text) {
      hashes[f.path] = h;
      continue;
    }
    hashes[f.path] = h;
    writes.push({ path: key, data: text, mode: f.mode ? parseInt(f.mode, 8) : 0o644, uid: GODSHAND, gid: GODSHAND });
  }
  if (writes.length) await vfs.writeMany(writes, { uid: GODSHAND, gid: GODSHAND, dirMode: 0o755 });
  for (let d of ['world', 'world/state']) {
    if (!(await vfs.exists(d + '/.keep'))) await vfs.writeMany([{ path: d + '/.keep', data: '', uid: GODSHAND, gid: GODSHAND }], { uid: GODSHAND, gid: GODSHAND });
    let st = await vfs.getStat(d);
    await vfs.setStat(d, { ...(st || {}), kind: 'dir', mode: 0o755, uid: GODSHAND, gid: GODSHAND });
  }
  await vfs.writeMany([{ path: 'world/.seed.json', data: JSON.stringify({ version: index.version, hashes }, null, 1), mode: 0o644, uid: GODSHAND, gid: GODSHAND }], { uid: GODSHAND, gid: GODSHAND });
}

async function listUnder(prefix) {
  let out = [];
  for (let { path, kind } of await vfs.listKinds()) {
    if (kind !== 'file' || !path.startsWith(prefix) || path.endsWith('/.keep')) continue;
    out.push(path);
  }
  return out.sort();
}

let parse = (text, where) => {
  try {
    return YAML.parse(text || '') || {};
  } catch (err) {
    throw new Error(`${where}: ${err.message}`);
  }
};

export let rootOps = {
  /** The whole world description, parsed. */
  async 'world.read'() {
    let segments = parse(await readText('world/net/segments.yaml'), 'segments.yaml');
    let routers = {};
    for (let p of await listUnder('world/net/routers/')) if (/\.ya?ml$/.test(p)) routers[p.split('/').pop().replace(/\.ya?ml$/, '')] = parse(await readText(p), p);
    let boxes = {};
    for (let p of await listUnder('world/boxes/')) if (/\.ya?ml$/.test(p)) boxes[p.split('/').pop().replace(/\.ya?ml$/, '')] = parse(await readText(p), p);
    let leases = {};
    for (let p of await listUnder('world/state/dhcp/')) leases[p.split('/').pop().replace(/\.json$/, '')] = JSON.parse((await readText(p)) || '{}');
    let boxLeases = JSON.parse((await readText('world/state/box-leases.json')) || '{}');
    for (let [id, l] of Object.entries(boxLeases)) if (boxes[id]) boxes[id].lastLease = l;
    return { segments, routers, boxes, leases };
  },

  /**
   * An image flattened through its `from:` chain:
   * { version, packages, users, groups, files: [{ path, data, mode, owner, group }] }
   */
  async 'world.image'({ name }) {
    let chain = [];
    for (let n = name, guard = 0; n && guard < 8; guard++) {
      let manifest = parse(await readText(`world/images/${n}/image.yaml`), `${n}/image.yaml`);
      if (!Object.keys(manifest).length && !(await vfs.exists(`world/images/${n}/.keep`))) throw new Error(`no such image: ${n}`);
      chain.unshift({ name: n, manifest });
      n = manifest.from;
    }
    let out = { version: '', packages: [], users: [], groups: [], files: [] };
    let files = new Map();
    for (let { name: n, manifest } of chain) {
      out.version += `${n}:${manifest.version || 1};`;
      for (let p of manifest.packages || []) if (!out.packages.includes(p)) out.packages.push(p);
      out.users.push(...(manifest.users || []));
      out.groups.push(...(manifest.groups || []));
      let modes = manifest.modes || {};
      let owners = manifest.owners || {};
      let prefix = `world/images/${n}/rootfs/`;
      for (let p of await listUnder(prefix)) {
        let rel = p.slice(prefix.length);
        let st = await vfs.getStat(p);
        let [owner, group] = String(owners['/' + rel] || '').split(':');
        files.set(rel, { path: rel, data: await readBytes(p), mode: modes['/' + rel] != null ? parseInt(modes['/' + rel], 8) : (st?.mode ?? 0o644) & 0o7777, owner: owner || 0, group: group || owner || 0 });
      }
    }
    out.files = [...files.values()];
    return out;
  },

  async 'world.saveLeases'({ router, leases }) {
    await vfs.writeMany([{ path: `world/state/dhcp/${router}.json`, data: JSON.stringify(leases, null, 1), mode: 0o644, uid: GODSHAND, gid: GODSHAND }], { uid: GODSHAND, gid: GODSHAND });
  },

  async 'world.saveBoxLease'({ box, ifname, ip }) {
    let all = JSON.parse((await readText('world/state/box-leases.json')) || '{}');
    all[box] = { ...(all[box] || {}), [ifname]: ip };
    await vfs.writeMany([{ path: 'world/state/box-leases.json', data: JSON.stringify(all, null, 1), mode: 0o644, uid: GODSHAND, gid: GODSHAND }], { uid: GODSHAND, gid: GODSHAND });
  },
};
