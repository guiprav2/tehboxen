/**
 * A small arborist: resolves package.json dependencies into a hoisted
 * node_modules tree (npm v7+ placement rules, peer deps installed), diffs it
 * against what's installed (node_modules/.package-lock.json) and reifies it
 * into the VFS: parallel tarball downloads, bulk extraction, bin links,
 * lifecycle scripts, package-lock.json v3.
 */
import * as vfs from '../vfs.js';
import { packument, fetchTarball } from './registry.js';

let semverPromise = null;
export function loadSemver() {
  semverPromise ??= import('https://cdn.jsdelivr.net/npm/semver@7.7.2/+esm').then((m) => m.default || m);
  return semverPromise;
}

let enc = new TextEncoder();
let dec = new TextDecoder();

export class NpmError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

/* ---------- specs ---------- */

/** "name@range" / "@scope/name@range" / "alias@npm:name@range" → { name, spec, alias? } */
export function parseSpec(raw) {
  let s = String(raw);
  let at = s.startsWith('@') ? s.indexOf('@', 1) : s.indexOf('@');
  let name = at === -1 ? s : s.slice(0, at);
  let spec = at === -1 ? '' : s.slice(at + 1);
  if (spec.startsWith('npm:')) {
    let inner = parseSpec(spec.slice(4));
    return { name, spec: inner.spec || 'latest', realName: inner.name };
  }
  return { name, spec: spec || '' };
}

function specKind(spec) {
  if (!spec || spec === '*') return 'range';
  if (/^(git\+|git:|github:|gitlab:|bitbucket:|https?:|file:|link:|workspace:)/.test(spec) || /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec)) return 'unsupported';
  if (spec.startsWith('npm:')) return 'alias';
  return 'range';
}

/** Pick a version for spec from a packument (npm prefers dist-tags.latest when it satisfies). */
export async function pickVersion(doc, spec, { preferred } = {}) {
  let semver = await loadSemver();
  let versions = Object.keys(doc.versions || {});
  let tags = doc['dist-tags'] || {};
  if (spec && tags[spec]) return tags[spec];
  if (spec && semver.valid(spec) && doc.versions[spec]) return spec;
  let range = spec || '*';
  if (!semver.validRange(range, { loose: true })) return null;
  if (preferred && doc.versions[preferred] && semver.satisfies(preferred, range, { loose: true })) return preferred;
  let latest = tags.latest;
  if (latest && semver.satisfies(latest, range, { loose: true })) return latest;
  let notDeprecated = versions.filter((v) => !doc.versions[v].deprecated);
  return semver.maxSatisfying(notDeprecated.length ? notDeprecated : versions, range, { loose: true }) || semver.maxSatisfying(versions, range, { loose: true, includePrerelease: true });
}

/* ---------- tree ---------- */

class Node {
  constructor({ name, location, parent, version, manifest, realName }) {
    this.name = name;
    this.realName = realName || name;
    this.location = location;
    this.parent = parent;
    this.version = version;
    this.manifest = manifest || {};
    this.children = new Map();
    this.dev = true;
    this.optional = true;
    this.peer = false;
  }
  get resolved() {
    return this.manifest.dist?.tarball;
  }
  get integrity() {
    return this.manifest.dist?.integrity;
  }
  /** Find what `require(name)` from this node resolves to (walk up node_modules). */
  resolve(name) {
    for (let n = this; n; n = n.parent) {
      let hit = n.children.get(name);
      if (hit) return hit;
    }
    return null;
  }
}

function childLocation(parent, name) {
  return (parent.location ? parent.location + '/' : '') + 'node_modules/' + name;
}

function platformOk(manifest) {
  let check = (list, value) => {
    if (!Array.isArray(list) || !list.length) return true;
    let neg = list.filter((x) => x.startsWith('!')).map((x) => x.slice(1));
    let pos = list.filter((x) => !x.startsWith('!'));
    if (neg.includes(value)) return false;
    return !pos.length || pos.includes(value);
  };
  return check(manifest.os, 'linux') && check(manifest.cpu, 'x64') && check(manifest.libc, 'glibc');
}

/**
 * Build the ideal tree.
 * @param {object} o
 * @param {object} o.rootPkg package.json
 * @param {object} [o.lock] package-lock.json (preferred versions)
 * @param {Set<string>} [o.update] names to re-resolve ignoring the lock
 * @param {(msg: string) => void} [o.warn]
 * @param {boolean} [o.legacyPeerDeps]
 * @param {boolean} [o.strictLock] npm ci: versions must come from the lock
 */
export async function buildIdealTree(o) {
  let semver = await loadSemver();
  let root = new Node({ name: o.rootPkg.name || '', location: '', parent: null, version: o.rootPkg.version, manifest: o.rootPkg });
  root.dev = false;
  root.optional = false;
  let lockPkgs = o.lock?.packages || {};
  let queue = [];
  let edges = []; // { from, name, spec, type }
  let addEdges = (node, manifest, isRoot) => {
    let push = (deps, type) => {
      for (let [name, spec] of Object.entries(deps || {})) edges.push({ from: node, name, spec: String(spec), type });
    };
    push(manifest.dependencies, 'prod');
    push(manifest.optionalDependencies, 'optional');
    if (isRoot) push(manifest.devDependencies, 'dev');
    if (!o.legacyPeerDeps) {
      let meta = manifest.peerDependenciesMeta || {};
      let peers = Object.fromEntries(Object.entries(manifest.peerDependencies || {}).filter(([n]) => !meta[n]?.optional));
      push(peers, 'peer');
    }
    queue.push(...edges.splice(0));
  };
  addEdges(root, o.rootPkg, true);
  let allEdges = [];

  while (queue.length) {
    let edge = queue.shift();
    allEdges.push(edge);
    let { from, name, spec, type } = edge;
    let kind = specKind(spec);
    if (kind === 'unsupported') {
      if (type === 'optional') {
        o.warn?.(`skipping optional dependency ${name}@${spec}: only registry dependencies are supported`);
        continue;
      }
      throw new NpmError('EUNSUPPORTEDPROTOCOL', `Unsupported dependency spec "${name}@${spec}": Tehboxen npm installs from the npm registry only.`);
    }
    let realName = name;
    if (kind === 'alias') {
      let inner = parseSpec(spec.slice(4));
      realName = inner.name;
      spec = inner.spec || 'latest';
    }
    // Already satisfied where require() would find it?
    let existing = from.resolve(name);
    if (existing && existing !== root && existing.realName === realName && (semver.satisfies(existing.version, spec || '*', { loose: true }) || existing.manifest?.version === spec)) {
      edge.to = existing;
      continue;
    }
    // Placement: as high as possible without shadowing a different version.
    let target = from;
    for (let n = from; n; n = n.parent) {
      let hit = n.children.get(name);
      if (hit) break;
      target = n;
    }
    if (target.children.has(name)) {
      // Same package declared twice by one dependent with incompatible ranges: keep the first.
      edge.to = target.children.get(name);
      o.warn?.(`conflicting ranges for ${name} required by ${from.name || 'the root project'}: keeping ${edge.to.version}`);
      continue;
    }
    let location = childLocation(target, name);
    let lockEntry = !o.update?.has(name) ? lockPkgs[location] : null;
    let doc;
    try {
      doc = await packument(realName);
    } catch (err) {
      if (type === 'optional') {
        o.warn?.(`skipping optional dependency ${name}: ${err.message.split('\n')[0]}`);
        continue;
      }
      throw new NpmError(err.code || 'E404', err.message);
    }
    let version = await pickVersion(doc, spec, { preferred: lockEntry?.version });
    if (o.strictLock && lockEntry?.version) version = lockEntry.version;
    if (!version || !doc.versions[version]) {
      if (type === 'optional') continue;
      throw new NpmError('ETARGET', `No matching version found for ${realName}@${spec}.`);
    }
    let manifest = doc.versions[version];
    if (!platformOk(manifest)) {
      if (type === 'optional') {
        o.warn?.(`skipping optional dependency ${name}@${version}: unsupported platform (wanted os=${manifest.os || 'any'} cpu=${manifest.cpu || 'any'}, current linux x64)`);
        continue;
      }
      throw new NpmError('EBADPLATFORM', `Unsupported platform for ${name}@${version}: wanted {"os":"${manifest.os || 'any'}","cpu":"${manifest.cpu || 'any'}"} (current: {"os":"linux","cpu":"x64"})`);
    }
    let node = new Node({ name, realName, location, parent: target, version, manifest });
    target.children.set(name, node);
    edge.to = node;
    addEdges(node, manifest, false);
  }

  // Flags: dev = not reachable from root's prod/optional/peer edges; optional = only via optional edges.
  let mark = (start, field, follow) => {
    let stack = [...start];
    let seen = new Set();
    while (stack.length) {
      let n = stack.pop();
      if (!n || seen.has(n)) continue;
      seen.add(n);
      n[field] = false;
      for (let e of allEdges) if (e.from === n && e.to && follow(e)) stack.push(e.to);
    }
  };
  let rootEdges = allEdges.filter((e) => e.from === root);
  mark(rootEdges.filter((e) => e.type !== 'dev').map((e) => e.to), 'dev', () => true);
  mark(rootEdges.filter((e) => e.type !== 'optional').map((e) => e.to), 'optional', (e) => e.type !== 'optional');
  for (let e of allEdges) if (e.type === 'peer' && e.to) e.to.peer = e.to.peer || e.to.dev;
  root.edges = allEdges;
  return root;
}

export function* walk(node) {
  for (let child of [...node.children.values()].sort((a, b) => (a.location < b.location ? -1 : 1))) {
    yield child;
    yield* walk(child);
  }
}

/* ---------- lockfiles ---------- */

function lockEntry(node) {
  let m = node.manifest;
  let e = { version: node.version, resolved: node.resolved, integrity: node.integrity };
  if (node.realName !== node.name) e.name = node.realName;
  if (node.dev) e.dev = true;
  if (node.optional && !node.dev) e.optional = true;
  if (node.peer) e.peer = true;
  if (m.license) e.license = typeof m.license === 'string' ? m.license : m.license.type;
  for (let k of ['dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'bin', 'engines', 'os', 'cpu']) if (m[k] && Object.keys(m[k]).length) e[k] = m[k];
  if (m.hasInstallScript) e.hasInstallScript = true;
  if (m.deprecated) e.deprecated = m.deprecated;
  return e;
}

export function toLockfile(root, rootPkg) {
  let rootEntry = { name: rootPkg.name, version: rootPkg.version };
  for (let k of ['license', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'bin', 'engines']) if (rootPkg[k] && Object.keys(rootPkg[k]).length) rootEntry[k] = rootPkg[k];
  let packages = { '': rootEntry };
  for (let n of walk(root)) packages[n.location] = lockEntry(n);
  return { name: rootPkg.name, version: rootPkg.version, lockfileVersion: 3, requires: true, packages };
}

/** Rebuild a tree from a lockfile (npm ci / ls / outdated). */
export function treeFromLock(lock, rootPkg) {
  let root = new Node({ name: rootPkg?.name || lock?.name || '', location: '', parent: null, version: rootPkg?.version, manifest: rootPkg || {} });
  let byLoc = new Map([['', root]]);
  let locs = Object.keys(lock?.packages || {}).filter((l) => l).sort((a, b) => a.split('/node_modules/').length - b.split('/node_modules/').length || (a < b ? -1 : 1));
  for (let loc of locs) {
    let e = lock.packages[loc];
    let i = loc.lastIndexOf('node_modules/');
    let name = loc.slice(i + 'node_modules/'.length);
    let parentLoc = loc.slice(0, Math.max(0, i - 1));
    let parent = byLoc.get(parentLoc) || root;
    let manifest = { ...e, dist: { tarball: e.resolved, integrity: e.integrity } };
    let node = new Node({ name, realName: e.name || name, location: loc, parent, version: e.version, manifest });
    node.dev = !!e.dev;
    node.optional = !!e.optional;
    node.peer = !!e.peer;
    parent.children.set(name, node);
    byLoc.set(loc, node);
  }
  return root;
}

/* ---------- reify ---------- */

let pool = async (items, limit, fn) => {
  let results = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        let idx = i++;
        results[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return results;
};

/**
 * Make node_modules match `ideal`.
 * @param {object} o
 * @param {string} o.dir project dir (absolute, '/home/x/app')
 * @param {object} o.host syscall host (other/node/host.js) for the npm user
 * @param {{uid,gid}} o.actor
 * @param {object} o.ideal tree  @param {object|null} o.actualLock node_modules/.package-lock.json
 * @param {Set<string>} o.omit  'dev' | 'optional' | 'peer'
 * @param {boolean} o.ignoreScripts
 * @param {(cmd, opts) => Promise<{code,stdout,stderr}>} o.exec
 * @param {(s) => void} o.log  @param {(s) => void} o.warn
 * @param {boolean} [o.dryRun]
 */
export async function reify(o) {
  let key = o.dir.replace(/^\/+/, '');
  let want = new Map();
  for (let n of walk(o.ideal)) {
    if ((n.dev && o.omit.has('dev')) || (n.optional && !n.dev && o.omit.has('optional')) || (n.peer && o.omit.has('peer'))) continue;
    want.set(n.location, n);
  }
  let have = new Map(Object.entries(o.actualLock?.packages || {}).filter(([l]) => l && l.includes('node_modules/')));
  let removed = [...have.keys()].filter((l) => !want.has(l));
  let added = [];
  let changed = [];
  for (let [loc, n] of want) {
    let h = have.get(loc);
    if (!h) added.push(n);
    else if (h.version !== n.version || (n.resolved && h.resolved && h.resolved !== n.resolved)) changed.push(n);
  }
  let summary = { added: added.length, removed: removed.length, changed: changed.length, audited: want.size + 1 };
  if (o.dryRun) {
    for (let l of removed) o.log(`remove ${l.replace(/.*node_modules\//, '')} ${have.get(l).version}`);
    for (let n of added) o.log(`add ${n.name} ${n.version}`);
    for (let n of changed) o.log(`change ${n.name} ${have.get(n.location).version} => ${n.version}`);
    return summary;
  }

  // Remove stale packages (deepest first), and the old copy of changed ones.
  let rmList = [...removed, ...changed.map((n) => n.location)].sort((a, b) => b.length - a.length);
  for (let loc of rmList) await o.host.call('rm', { path: `${o.dir}/${loc}`, recursive: true, force: true }).catch(() => {});

  // Download + extract in parallel; write each package with one bulk VFS write.
  let toInstall = [...added, ...changed];
  if (toInstall.length) await o.host.call('mkdir', { path: `${o.dir}/node_modules`, recursive: true });
  let failed = new Set();
  await pool(toInstall, 8, async (n) => {
    try {
      let files = await fetchTarball({ resolved: n.resolved, integrity: n.integrity, shasum: n.manifest.dist?.shasum, name: n.realName, version: n.version });
      await vfs.writeMany(
        files.map((f) => ({ path: `${key}/${n.location}/${f.path}`, data: isText(f.data) ? dec.decode(f.data) : f.data, mode: f.mode & 0o111 ? 0o755 : 0o644 })),
        { uid: o.actor.uid, gid: o.actor.gid },
      );
      n.files = files;
    } catch (err) {
      if (n.optional) {
        o.warn(`skipping optional dependency ${n.name}@${n.version}: ${err.message}`);
        failed.add(n);
        return;
      }
      throw new NpmError(err.code || 'EFETCH', `${n.name}@${n.version}: ${err.message}`);
    }
  });

  // Bin links: node_modules/.bin next to each package's node_modules dir.
  for (let n of want.values()) {
    if (failed.has(n)) continue;
    let bins = normalizeBins(n);
    if (!bins.length) continue;
    let parentDir = n.location.slice(0, n.location.lastIndexOf('node_modules/') + 'node_modules'.length);
    await o.host.call('mkdir', { path: `${o.dir}/${parentDir}/.bin`, recursive: true });
    for (let [binName, binPath] of bins) {
      let link = `${o.dir}/${parentDir}/.bin/${binName}`;
      let target = `../${n.name}/${binPath.replace(/^\.\//, '')}`;
      await o.host.call('rm', { path: link, force: true }).catch(() => {});
      await o.host.call('symlink', { target, path: link }).catch((err) => o.warn(`could not link bin ${binName}: ${err.message}`));
      await o.host.call('chmod', { path: `${o.dir}/${n.location}/${binPath.replace(/^\.\//, '')}`, mode: 0o755 }).catch(() => {});
    }
  }

  // Lifecycle scripts (deepest first, like npm's rebuild order).
  if (!o.ignoreScripts) {
    let withScripts = toInstall.filter((n) => !failed.has(n) && (n.manifest.hasInstallScript || n.manifest.scripts)).sort((a, b) => b.location.split('node_modules').length - a.location.split('node_modules').length);
    for (let n of withScripts) {
      let pkg = null;
      try {
        pkg = JSON.parse(dec.decode(await o.host.call('readFile', { path: `${o.dir}/${n.location}/package.json` })));
      } catch {}
      let scripts = { ...(pkg?.scripts || {}) };
      let hasGyp = n.files?.some((f) => f.path === 'binding.gyp');
      if (hasGyp && !scripts.install && !scripts.preinstall) scripts.install = 'node-gyp rebuild';
      for (let event of ['preinstall', 'install', 'postinstall']) {
        if (!scripts[event]) continue;
        let r = await runScript({ ...o, pkgDir: `${o.dir}/${n.location}`, pkg: pkg || n.manifest, event, script: scripts[event] });
        if (r.code) {
          if (n.optional) {
            o.warn(`optional dependency ${n.name}@${n.version} failed its ${event} script; removing it`);
            await o.host.call('rm', { path: `${o.dir}/${n.location}`, recursive: true, force: true }).catch(() => {});
            want.delete(n.location);
            break;
          }
          throw new NpmError('ELIFECYCLE', `${n.location}: ${event} script failed`, { event, script: scripts[event], path: `${o.dir}/${n.location}`, exitCode: r.code, output: r.stdout + r.stderr });
        }
      }
    }
  }

  // Hidden lockfile = what's actually installed now.
  let hidden = { name: o.ideal.name, lockfileVersion: 3, requires: true, packages: {} };
  for (let [loc, n] of want) if (!failed.has(n)) hidden.packages[loc] = lockEntry(n);
  if (want.size) await o.host.call('writeFile', { path: `${o.dir}/node_modules/.package-lock.json`, data: JSON.stringify(hidden, null, 2) + '\n' });
  else await o.host.call('rm', { path: `${o.dir}/node_modules/.package-lock.json`, force: true }).catch(() => {});
  return summary;
}

function isText(bytes) {
  let n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function normalizeBins(n) {
  let bin = n.manifest.bin;
  if (!bin) return [];
  if (typeof bin === 'string') return [[(n.realName || n.name).replace(/^@[^/]+\//, ''), bin]];
  return Object.entries(bin);
}

/** Run one package script the way npm does (env, PATH with node_modules/.bin dirs). */
export async function runScript(o) {
  let binDirs = [];
  for (let d = o.pkgDir; d && d !== '/'; d = d.slice(0, d.lastIndexOf('/')) || '/') {
    binDirs.push(`${d}/node_modules/.bin`);
    if (d === '/') break;
  }
  let env = {
    ...o.env,
    PATH: [...binDirs, o.env?.PATH || '/usr/local/bin:/usr/bin:/bin'].join(':'),
    npm_lifecycle_event: o.event,
    npm_lifecycle_script: o.script,
    npm_package_name: o.pkg?.name || '',
    npm_package_version: o.pkg?.version || '',
    npm_package_json: `${o.pkgDir}/package.json`,
    npm_command: o.command || 'run-script',
    npm_node_execpath: '/usr/bin/node',
    npm_execpath: '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    INIT_CWD: o.initCwd || o.env?.PWD || o.pkgDir,
    NODE: '/usr/bin/node',
  };
  o.log?.(`\n> ${o.pkg?.name || ''}${o.pkg?.version ? '@' + o.pkg.version : ''} ${o.event}\n> ${o.script}\n`);
  let r = await o.exec(o.script + (o.args?.length ? ' ' + o.args.map(shq).join(' ') : ''), { cwd: o.pkgDir, env });
  if (r.stdout) o.out?.(r.stdout);
  if (r.stderr) o.errOut?.(r.stderr);
  return r;
}

export function shq(a) {
  let s = String(a);
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export { enc, dec };
