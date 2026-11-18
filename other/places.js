/**
 * Flat places graph + presence for Tehboxen.
 *
 * places/<id>/place.yaml   — name, picture?, …
 * places/<id>/presence.yaml — users: [<player>, …]
 * places/<id>/<exit>        — symlink → sibling place (../cafe)
 * home/<user>/location      — symlink → places/<id>
 *
 * World content (places, cast, chats) lives in the VFS / world packs.
 * seedWorld only materializes an explicit `opts.places` graph or repairs
 * location symlinks — it does not embed a demo cast in host JS.
 *
 * Schedules are soft hints for agents; moveTo enforces exit topology unless force.
 */
import * as vfs from './vfs.js';
import { getUser, listUsers, DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, ROOT_UID } from './vfs-auth.js';
import { readYaml, writeYaml, ensureDir } from './messaging.js';

export let PLACES_ROOT = 'places';

export function placePath(id) {
  return PLACES_ROOT + '/' + String(id || '').replace(/^\/+/, '');
}

/** Extract place id from a places/<id>[/…] path. */
export function placeIdFromPath(path) {
  let p = String(path || '').replace(/^\/+/, '');
  if (!p.startsWith(PLACES_ROOT + '/')) return null;
  let rest = p.slice(PLACES_ROOT.length + 1);
  let id = rest.split('/')[0];
  return id || null;
}

export async function listPlaceIds() {
  await vfs.ensureReady();
  let all = await vfs.list();
  let ids = new Set();
  let prefix = PLACES_ROOT + '/';
  for (let p of all) {
    if (!p.startsWith(prefix)) continue;
    let id = p.slice(prefix.length).split('/')[0];
    if (id && id !== '.keep') ids.add(id);
  }
  return [...ids].sort();
}

/** Default Places bubble path when place.yaml omits `picture`. */
export function placeCoverPath(id) {
  return placePath(id) + '/pictures/cover.jpg';
}

export async function readPlace(id) {
  let meta = (await readYaml(placePath(id) + '/place.yaml', {}).catch(() => ({}))) || {};
  let cover = placeCoverPath(id);
  let picture = String(meta.picture || '').trim();
  if (!picture && (await vfs.exists(cover))) picture = cover;
  let allowed =
    meta.allowed_users == null
      ? null
      : Array.isArray(meta.allowed_users)
        ? meta.allowed_users.map(String)
        : null;
  return {
    ...meta,
    id: String(id),
    name: meta.name || String(id),
    about: meta.about || '',
    picture,
    // null = public (prop omitted); array = allow-list (empty = nobody)
    allowed_users: allowed,
  };
}

/**
 * Enter permission from place.yaml `allowed_users`.
 * Missing / null prop → public. Array → only listed usernames (plus root via force).
 */
export function isPlacePublic(place) {
  return place?.allowed_users == null;
}

export function canEnterPlace(username, place) {
  if (!place) return false;
  if (isPlacePublic(place)) return true;
  let u = String(username || '');
  if (!u) return false;
  return (place.allowed_users || []).includes(u);
}

export async function assertCanEnter(username, placeId, opts = {}) {
  let place = typeof placeId === 'object' ? placeId : await readPlace(placeId);
  let id = place.id || placeId;
  if (opts.force) return place;
  if (canEnterPlace(username, place)) return place;
  throw Object.assign(
    new Error(
      'moveTo: ' +
        username +
        ' is not allowed into ' +
        (place.name || id) +
        ' (not in allowed_users)',
    ),
    { code: 'EPERM', place: id },
  );
}

export async function readPresence(id, opts = {}) {
  let data = (await readYaml(placePath(id) + '/presence.yaml', { users: [] }, opts).catch(() => ({
    users: [],
  }))) || { users: [] };
  let users = Array.isArray(data.users) ? data.users.map(String) : [];
  return { ...data, users };
}

export async function writePresence(id, users, opts = {}) {
  let uniq = [...new Set((users || []).map(String))].sort();
  await writeYaml(placePath(id) + '/presence.yaml', { users: uniq }, opts);
  return uniq;
}

/**
 * List exit edges from a place: [{ name, targetId, targetPath }].
 * Exit = symlink child whose resolved target is another place dir.
 */
export async function listExits(id) {
  await vfs.ensureReady();
  let dir = placePath(id);
  let all = await vfs.list();
  let prefix = dir + '/';
  let exits = [];
  let seen = new Set();
  for (let p of all) {
    if (!p.startsWith(prefix)) continue;
    let rest = p.slice(prefix.length);
    if (rest.includes('/')) continue; // only direct children
    if (rest === '.keep' || rest === 'place.yaml' || rest === 'presence.yaml') continue;
    if (!(await vfs.isSymlink(p))) continue;
    let raw = await vfs.readlink(p);
    let resolved = vfs.resolveLinkTarget(p, raw);
    let targetId = placeIdFromPath(resolved);
    if (!targetId || targetId === id) continue;
    if (seen.has(targetId)) continue;
    seen.add(targetId);
    exits.push({ name: rest, targetId, targetPath: placePath(targetId), linkPath: p });
  }
  return exits;
}

export async function whereIs(username) {
  let u = await getUser(username);
  if (!u) return null;
  let loc = (u.home || 'home/' + username) + '/location';
  if (!(await vfs.isSymlink(loc)) && !(await vfs.exists(loc))) return null;
  let raw = await vfs.readlink(loc);
  if (!raw) return null;
  let resolved = vfs.resolveLinkTarget(loc, raw);
  return placeIdFromPath(resolved);
}

export async function whoIsAt(placeId) {
  let { users } = await readPresence(placeId);
  return users;
}

/**
 * Move user to dest place. Unless force, dest must be an exit from current place
 * (or user has no location yet — first placement).
 */
export async function moveTo(username, destId, opts = {}) {
  await vfs.ensureReady();
  let user = await getUser(username);
  if (!user) throw new Error('moveTo: unknown user ' + username);
  let dest = String(destId || '');
  if (!dest) throw new Error('moveTo: destination required');
  if (!(await vfs.isDirectory(placePath(dest)))) {
    throw new Error('moveTo: no such place ' + dest);
  }

  await assertCanEnter(username, dest, opts);

  let home = user.home || 'home/' + username;
  let locPath = home + '/location';
  let from = await whereIs(username);

  if (!opts.force && from && from !== dest) {
    let exits = await listExits(from);
    if (!exits.some((e) => e.targetId === dest)) {
      throw new Error('moveTo: no exit from ' + from + ' to ' + dest);
    }
  }

  let fromPres = from && from !== dest ? placePath(from) + '/presence.yaml' : null;
  let toPres = placePath(dest) + '/presence.yaml';
  let logPath = opts.log !== false ? home + '/location-log.yaml' : null;
  let lockPaths = [locPath, toPres];
  if (fromPres) lockPaths.push(fromPres);
  if (logPath) lockPaths.push(logPath);

  await vfs.withLocks(lockPaths, async (leases) => {
    await vfs.symlink(placePath(dest), locPath, {
      force: true,
      uid: user.uid,
      gid: user.gid,
      lease: leases[locPath],
      actor: opts.actor,
    });

    if (fromPres) {
      let old = await readPresence(from, { lease: leases[fromPres] });
      await writePresence(
        from,
        old.users.filter((u) => u !== username),
        { lease: leases[fromPres] },
      );
    }
    let neu = await readPresence(dest, { lease: leases[toPres] });
    if (!neu.users.includes(username)) {
      await writePresence(dest, [...neu.users, username], {
        lease: leases[toPres],
      });
    }

    if (logPath) {
      try {
        let log = (await readYaml(logPath, [], { lease: leases[logPath] }).catch(() => [])) || [];
        if (!Array.isArray(log)) log = [];
        log.push({ at: new Date().toISOString(), from: from || null, to: dest });
        if (log.length > 200) log = log.slice(-200);
        await writeYaml(logPath, log, { lease: leases[logPath] });
      } catch {}
    }
  }, { mode: 'w', actor: opts.actor });

  return { user: username, from: from || null, to: dest };
}

/**
 * Graph for the Places map app.
 * Pass `{ viewer }` (e.g. the player) to hide places they cannot enter and edges into them.
 * The viewer's current location is always kept so the map has a center.
 */
export async function loadGraph(opts = {}) {
  let viewer = opts.viewer != null ? String(opts.viewer) : null;
  let here = viewer ? await whereIs(viewer) : null;
  let ids = await listPlaceIds();
  let nodes = [];
  let edges = [];
  let edgeKeys = new Set();
  let visible = new Set();
  let placeById = {};
  for (let id of ids) {
    let place = await readPlace(id);
    placeById[id] = place;
    let ok =
      !viewer ||
      id === here ||
      canEnterPlace(viewer, place);
    if (!ok) continue;
    visible.add(id);
    let presence = await readPresence(id);
    nodes.push({
      id,
      name: place.name,
      picture: place.picture || '',
      about: place.about || '',
      users: presence.users,
      allowed_users: place.allowed_users,
      public: isPlacePublic(place),
    });
  }
  for (let id of visible) {
    for (let ex of await listExits(id)) {
      let a = id;
      let b = ex.targetId;
      if (!visible.has(b)) continue;
      // Also require the viewer could enter the destination (belt + suspenders).
      if (viewer && !canEnterPlace(viewer, placeById[b] || (await readPlace(b)))) {
        continue;
      }
      let key = a < b ? a + '::' + b : b + '::' + a;
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push({ from: a, to: b });
    }
  }
  return { nodes, edges, here };
}

/**
 * Materialize an explicit places graph into the VFS, or repair location links.
 *
 * Pass `opts.places` (array of { id, name, about?, picture?, allowed_users?, exits?,
 * owner? }) to create or update places. Omit `allowed_users` for public places.
 * With no `places`, only repairs existing users' location symlinks / presence.
 */
export async function seedWorld(opts = {}) {
  await vfs.ensureReady();
  let world = opts.places;
  if (world && world.length) {
    let { getGroup, getUser } = await import('./vfs-auth.js');
    let worldGrp = await getGroup('world');
    let worldGid = Number(worldGrp?.gid ?? 100);

    for (let pl of world) {
      let dir = placePath(pl.id);
      await ensureDir(dir);
      let owner = pl.owner ? await getUser(pl.owner) : null;
      let uid = owner ? Number(owner.uid) : ROOT_UID;
      let gid = owner ? Number(owner.gid) : worldGid;
      let mode = pl.mode != null ? Number(pl.mode) : 0o755;
      await vfs.setStat(dir, {
        kind: 'dir',
        mode,
        uid,
        gid,
      });
      let metaPath = dir + '/place.yaml';
      let prev = (await readYaml(metaPath, null).catch(() => null)) || null;
      if (!prev || opts.forceMeta || !prev.picture) {
        let meta = {
          name: pl.name,
          about: pl.about || prev?.about || '',
          picture: pl.picture || prev?.picture || '',
        };
        if (pl.allowed_users !== undefined) {
          meta.allowed_users =
            pl.allowed_users == null
              ? undefined
              : [...pl.allowed_users].map(String);
          if (meta.allowed_users === undefined) delete meta.allowed_users;
        } else if (prev?.allowed_users != null) {
          meta.allowed_users = prev.allowed_users;
        }
        // Drop undefined keys from YAML noise
        if (meta.allowed_users === undefined) delete meta.allowed_users;
        await writeYaml(metaPath, meta);
      }
      if (!(await vfs.exists(dir + '/presence.yaml'))) {
        await writeYaml(dir + '/presence.yaml', { users: [] });
      }
      for (let dest of pl.exits || []) {
        let linkPath = dir + '/' + dest;
        let target = '../' + dest;
        if (await vfs.isSymlink(linkPath)) continue;
        if (await vfs.exists(linkPath)) {
          await vfs.withLock(linkPath, (lease) => vfs.remove(linkPath, { lease }), { mode: 'w' });
        }
        await vfs.withLock(
          linkPath,
          (lease) =>
            vfs.symlink(target, linkPath, {
              force: true,
              uid: ROOT_UID,
              gid: worldGid,
              lease,
            }),
          { mode: 'w' },
        );
      }
    }
  }

  // Migrate legacy location markers → real symlinks when a default is known.
  let users = await listUsers();
  let ids = await listPlaceIds();
  let fallback = opts.defaultPlace || ids[0] || null;
  if (fallback) {
    for (let u of Object.values(users)) {
      if (!u?.name || u.name === 'nobody' || u.name === 'root') continue;
      let home = u.home || 'home/' + u.name;
      if (!home) continue;
      let current = await whereIs(u.name);
      let dest = current || fallback;
      await moveTo(u.name, dest, { force: true, log: !current });
    }
  }

  return loadGraph();
}
