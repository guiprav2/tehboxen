/**
 * The physical world: network segments (LANs and the flat Internet), the
 * JS routers, and every box's network ports. Runs on the desktop page.
 *
 * What exists comes from the root computer (box 'root', other/box/root.js):
 * /world/net/segments.yaml, /world/net/routers/*.yaml, /world/boxes/*.yaml.
 * The fabric only executes that description.
 *
 * Boxes other than the player's ('local', the page itself) are Workers
 * running other/box/kernel.js. All of them boot with the fabric and stay up;
 * packets that arrive while a box is still booting (or after it crashed and
 * is being restarted) are queued and delivered once its kernel is up.
 */
import { spawnModuleWorker } from '../node/spawn-worker.js';
import { parseCidr } from './ip.js';
import { Router, macFor } from './router.js';

let ARP_TIMEOUT = 3000;

export class Fabric {
  constructor({ log = (...a) => console.debug('[net]', ...a) } = {}) {
    this.log = log;
    this.segments = new Map(); // id → { id, latency, ports: Set<port> }
    this.ports = new Map(); // "owner/ifname" → port
    this.routers = new Map();
    this.boxes = new Map(); // id → BoxHandle
    this.taps = new Set(); // (segmentId, pkt) => void   (tcpdump on a segment)
  }

  segment(id, opts = {}) {
    if (!this.segments.has(id)) this.segments.set(id, { id, latency: Number(opts.latency ?? (id === 'internet' ? 12 : 0)), ports: new Set() });
    let s = this.segments.get(id);
    if (opts.latency != null) s.latency = Number(opts.latency);
    return s;
  }

  /** Plug a page-side stack's interface (routers, the player's box) into a segment. */
  attach(owner, ifname, segmentId, stack) {
    let port = {
      owner,
      ifname,
      segment: this.segment(segmentId),
      mac: () => stack.ifaces.get(ifname)?.mac,
      ips: () => stack.ifaces.get(ifname)?.addrs.map((a) => a.ip) || [],
      up: () => !!stack.ifaces.get(ifname)?.up,
      deliver: (pkt) => stack.receive(ifname, pkt),
      deliverArp: (arp, srcMac) => stack.receiveArp(ifname, arp, srcMac),
      unreachable: (pkt) => stack.arpFailed(ifname, pkt),
    };
    this._plug(port);
    // Page-side stacks ask the fabric directly for neighbors' MACs and to put frames on the wire.
    stack.macOf = (ifn, ip) => this.macOf(`${owner}/${ifn}`, ip);
    stack.transmitFrame = (ifn, mac, kind, payload) => this.transmitFrame(owner, ifn, mac, kind, payload);
    stack.on('change', () => this.pushMacs(port.segment));
    return port;
  }

  /** MAC of whoever owns `ip` on the segment of port `key` (the ARP answer). */
  macOf(key, ip) {
    let from = this.ports.get(key);
    if (!from) return null;
    for (let p of from.segment.ports) if (p !== from && p.ips().includes(ip)) return p.mac();
    return null;
  }

  /** IP → MAC of every port on a segment (pushed to box kernels). */
  macTable(seg) {
    let t = {};
    for (let p of seg.ports) for (let ip of p.ips()) t[ip] = p.mac();
    return t;
  }

  pushMacs(seg) {
    for (let p of seg.ports) p.macs?.(this.macTable(seg));
  }

  /** A frame injected by a packet socket: IPv4 or ARP, to one MAC or broadcast. */
  transmitFrame(owner, ifname, dstMac, kind, payload) {
    let from = this.ports.get(`${owner}/${ifname}`);
    if (!from) return;
    let bcast = dstMac === 'ff:ff:ff:ff:ff:ff';
    let srcMac = kind === 'arp' ? payload.sha : from.mac();
    let targets = [...from.segment.ports].filter((p) => p !== from && p.up() && (bcast || p.mac() === dstMac));
    let send = () => {
      for (let p of targets) {
        if (kind === 'arp') p.deliverArp?.(structuredClone(payload), srcMac);
        else p.deliver({ ...structuredClone(payload), srcMac, dstMac });
      }
    };
    if (from.segment.latency > 0) setTimeout(send, from.segment.latency);
    else queueMicrotask(send);
  }

  _plug(port) {
    let key = `${port.owner}/${port.ifname}`;
    this.unplug(key);
    this.ports.set(key, port);
    port.segment.ports.add(port);
  }

  unplug(key) {
    let p = this.ports.get(key);
    if (!p) return;
    p.segment.ports.delete(p);
    this.ports.delete(key);
  }

  /** A stack hands a packet to the wire: deliver to the next hop (or everyone, for broadcasts). */
  transmit(owner, ifname, nextHop, pkt) {
    let from = this.ports.get(`${owner}/${ifname}`);
    if (!from) return;
    let seg = from.segment;
    for (let t of this.taps) {
      try {
        t(seg.id, pkt);
      } catch {}
    }
    let bcast = nextHop === '255.255.255.255';
    let targets = [];
    for (let p of seg.ports) {
      if (p === from || !p.up()) continue;
      if (bcast) targets.push(p);
      else if (p.ips().includes(nextHop)) targets.push(p);
    }
    if (!targets.length) {
      if (!bcast) setTimeout(() => from.unreachable(pkt), ARP_TIMEOUT);
      return;
    }
    let srcMac = from.mac?.();
    let send = () => {
      for (let p of targets) {
        let copy = targets.length > 1 ? structuredClone(pkt) : pkt;
        copy.srcMac = srcMac;
        copy.dstMac = bcast ? 'ff:ff:ff:ff:ff:ff' : p.mac?.();
        p.deliver(copy);
      }
    };
    if (seg.latency > 0) setTimeout(send, seg.latency);
    else queueMicrotask(send);
  }

  /* ---------- world ---------- */

  /**
   * Build everything from the root computer's description.
   * @param {{ segments, routers, boxes, leases }} world
   */
  async build(world) {
    // Routers synchronously first: callers may await `routersReady` before boxes are up.
    this.routersReady = this._buildRouters(world);
    await this.routersReady;
    for (let [id, spec] of Object.entries(world.boxes || {})) {
      if (id === 'local' || id === 'root') continue;
      let h = this.boxes.get(id);
      if (!h) this.boxes.set(id, new BoxHandle(this, id, spec));
      else if (JSON.stringify(stripState(h.spec)) !== JSON.stringify(stripState(spec))) {
        // Changed in /world: reboot it with the new spec (reprovisioned if its image changed).
        let image = h.spec.image;
        h.stop();
        h.update({ ...spec, reprovision: (spec.image || 'base') !== (image || 'base') });
      }
    }
    for (let [id, h] of [...this.boxes]) {
      if (id !== 'root' && !(id in (world.boxes || {}))) {
        h.stop();
        h.unplugAll();
        this.boxes.delete(id);
      }
    }
    // Every box runs all the time: boot them all now (in parallel).
    await Promise.allSettled([...this.boxes.values()].map((h) => h.wake()));
  }

  async _buildRouters(world) {
    for (let r of this.routers.values()) r.stop();
    for (let key of [...this.ports.keys()]) if (key.startsWith('router:')) this.unplug(key);
    this.routers.clear();
    for (let [id, s] of Object.entries(world.segments || {})) this.segment(id, s || {});
    for (let [id, cfg] of Object.entries(world.routers || {})) {
      let r = new Router(id, cfg, this);
      this.routers.set(id, r);
      try {
        await r.start(world.leases?.[id] || {});
      } catch (err) {
        this.log(`router ${id}: ${err?.message || err}`);
      }
    }
  }

  saveLeases(routerId, leases) {
    this.boxes.get('root')?.rpc('world.saveLeases', { router: routerId, leases }).catch(() => {});
  }
}

/**
 * A box running in a Worker. Its ports answer for the static addresses in
 * its spec (or its last DHCP lease) while it boots.
 */
export class BoxHandle {
  constructor(fabric, id, spec) {
    this.fabric = fabric;
    this.id = id;
    this.spec = spec || {};
    this.worker = null;
    this.state = 'off';
    this.queue = [];
    this.addrs = {}; // ifname → [ip] (mirrored from the kernel when awake)
    this.pending = new Map();
    this.seq = 0;
    this.handlers = {}; // kernel → page rpc ops
    this.plugAll();
  }

  update(spec) {
    this.spec = spec || {};
    this.plugAll();
  }

  ifaces() {
    return (this.spec.interfaces || []).map((i) => ({ ...i, mac: i.mac || macFor(`${this.id}/${i.name}`) }));
  }

  plugAll() {
    this.unplugAll();
    for (let i of this.ifaces()) {
      let c = parseCidr(i.addr);
      if (!this.addrs[i.name]?.length) this.addrs[i.name] = c ? [c.ip] : this.spec.lastLease?.[i.name] ? [this.spec.lastLease[i.name]] : [];
      let port = {
        owner: `box:${this.id}`,
        ifname: i.name,
        segment: this.fabric.segment(i.segment),
        mac: () => i.mac,
        ips: () => this.addrs[i.name] || [],
        up: () => true,
        deliver: (pkt) => this.deliver(i.name, pkt),
        deliverArp: (arp, srcMac) => this.post({ t: 'arp', ifname: i.name, arp, srcMac }),
        unreachable: (pkt) => this.post({ t: 'arpfail', ifname: i.name, pkt }),
        macs: (table) => this.post({ t: 'macs', ifname: i.name, table }),
      };
      this.fabric._plug(port);
    }
  }

  unplugAll() {
    for (let key of [...this.fabric.ports.keys()]) if (key.startsWith(`box:${this.id}/`)) this.fabric.unplug(key);
  }

  deliver(ifname, pkt) {
    if (this.state === 'up') return this.worker.postMessage({ t: 'frame', ifname, pkt });
    this.queue.push({ ifname, pkt });
    if (this.queue.length > 256) this.queue.shift();
    this.wake();
  }

  post(msg) {
    if (this.state === 'up') this.worker.postMessage(msg);
  }

  /** Boot the box (idempotent); resolves when its kernel is up. */
  wake() {
    if (this.booting) return this.booting;
    if (this.state === 'up') return Promise.resolve();
    this.state = 'booting';
    this.fabric.log(`waking ${this.id}`);
    this.booting = new Promise((resolve, reject) => {
      let w = spawnModuleWorker(new URL('../box/kernel.js', import.meta.url), { name: `box:${this.id}` });
      this.worker = w;
      w.addEventListener('error', (ev) => {
        this.fabric.log(`box ${this.id} crashed: ${ev.message || ev}`);
        this.stop();
        reject(new Error(ev.message || 'box crashed'));
        // Reboot after a crash, like a watchdog.
        setTimeout(() => this.wake().catch(() => {}), 5000);
      });
      w.addEventListener('message', (ev) => this.onMessage(ev.data || {}, resolve));
      w.postMessage({ t: 'boot', id: this.id, spec: { ...this.spec, interfaces: this.ifaces() } });
    });
    this.booting.catch(() => {});
    return this.booting;
  }

  async onMessage(m, resolve) {
    if (m.t === 'tx') {
      return this.fabric.transmit(`box:${this.id}`, m.ifname, m.nextHop, m.pkt);
    }
    if (m.t === 'addrs') {
      this.addrs = m.addrs;
      for (let i of this.ifaces()) this.fabric.pushMacs(this.fabric.segment(i.segment));
      return;
    }
    if (m.t === 'txframe') return this.fabric.transmitFrame(`box:${this.id}`, m.ifname, m.mac, m.kind, m.payload);
    if (m.t === 'up') {
      this.state = 'up';
      this.booting = null;
      this.fabric.log(`${this.id} is up`);
      let q = this.queue;
      this.queue = [];
      for (let f of q) this.worker.postMessage({ t: 'frame', ifname: f.ifname, pkt: f.pkt });
      for (let i of this.ifaces()) this.fabric.pushMacs(this.fabric.segment(i.segment));
      return resolve();
    }
    if (m.t === 'res') {
      let p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      return m.ok ? p.resolve(m.value) : p.reject(Object.assign(new Error(m.error?.message || 'error'), m.error));
    }
    if (m.t === 'rpc') {
      // kernel → page (images from the root computer, leases, …)
      let fn = this.handlers[m.op] || pageOps[m.op];
      try {
        let value = await fn(this, m.args || {});
        this.worker.postMessage({ t: 'res', id: m.id, ok: true, value });
      } catch (err) {
        this.worker.postMessage({ t: 'res', id: m.id, ok: false, error: { message: String(err?.message || err), code: err?.code } });
      }
      return;
    }
    if (m.t === 'log') this.fabric.log(`${this.id}: ${m.text}`);
  }

  /** page → kernel request (wakes the box). */
  async rpc(op, args = {}, transfer = []) {
    await this.wake();
    let id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ t: 'rpc', id, op, args }, transfer);
    });
  }

  /** Power off (removed from the world, or before a reboot). */
  stop() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.state = 'off';
    this.booting = null;
    for (let p of this.pending.values()) p.reject(new Error('box stopped'));
    this.pending.clear();
  }
}

let stripState = (spec) => {
  let { lastLease, reprovision, ...rest } = spec || {};
  return rest;
};

/** Requests box kernels make to the page. */
let pageOps = {
  /** The image a box is provisioned from, read off the root computer. */
  async image(box, { name }) {
    let root = box.fabric.boxes.get('root');
    return root.rpc('world.image', { name });
  },
  /** The world's trust bundle (/world/pki/trust). */
  async trust(box) {
    return box.fabric.boxes.get('root').rpc('world.trust');
  },
  async saveLease(box, { ifname, ip }) {
    box.spec.lastLease = { ...(box.spec.lastLease || {}), [ifname]: ip };
    let root = box.fabric.boxes.get('root');
    await root?.rpc('world.saveBoxLease', { box: box.id, ifname, ip });
  },
};
