/**
 * NPC provisioning helpers for Tehboxen multi-user VFS.
 * Creates home/<id>/ with a skeleton profile and empty .relay/.
 */
import * as vfs from './vfs.js';
import {
  getUser,
  saveUser,
  saveGroup,
  getGroup,
  nextUid,
  nextGid,
  actorFromUser,
  DEFAULT_DIR_MODE,
  DEFAULT_FILE_MODE,
} from './vfs-auth.js';

function slugify(id) {
  return String(id || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_+.-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * @param {{ id: string, gecos?: string, phone?: string, about?: string, color?: string }} opts
 */
export async function provisionNpc(opts = {}) {
  await vfs.ensureReady();
  let id = slugify(opts.id);
  if (!id) throw new Error('provisionNpc: id required');
  if (id === 'root' || id === 'nobody' || id === 'grok') {
    throw new Error('provisionNpc: reserved id ' + id);
  }
  if (await getUser(id)) throw new Error('provisionNpc: user exists: ' + id);

  let uid = await nextUid();
  let gid;
  let existingGroup = await getGroup(id);
  if (existingGroup) gid = existingGroup.gid;
  else {
    gid = await nextGid();
    await saveGroup({ name: id, gid, members: [id] });
  }

  let home = 'home/' + id;
  await saveUser({
    name: id,
    uid,
    gid,
    home,
    shell: '/bin/boxsh',
    gecos: opts.gecos || id,
  });

  // Add to world group so shared trees are group-readable.
  let world = await getGroup('world');
  if (world && !world.members?.includes(id)) {
    await saveGroup({ ...world, members: [...(world.members || []), id] });
  }

  await vfs.withLock(home + '/.keep', (lease) => vfs.write(home + '/.keep', '', { lease }), { mode: 'w' });
  await vfs.setStat(home, {
    kind: 'dir',
    mode: 0o750,
    uid,
    gid,
  });

  let { writeYaml } = await import('./messaging.js');
  let { defaultRuntime } = await import('./npc-life.js');
  await writeYaml(home + '/profile.yaml', {
    id,
    name: opts.gecos || id,
    phone: opts.phone || undefined,
    about: opts.about || '',
    color: opts.color || undefined,
    runtime: defaultRuntime(),
  });
  await vfs.setStat(home + '/profile.yaml', {
    kind: 'file',
    mode: DEFAULT_FILE_MODE,
    uid,
    gid,
  });

  await vfs.withLock(home + '/.relay/.keep', (lease) => vfs.write(home + '/.relay/.keep', '', { lease }), { mode: 'w' });
  await vfs.setStat(home + '/.relay', {
    kind: 'dir',
    mode: DEFAULT_DIR_MODE,
    uid,
    gid,
  });

  // Pictures dir for portrait.jpg and other character stills (no shared gallery).
  await vfs.withLock(home + '/Pictures/.keep', (lease) => vfs.write(home + '/Pictures/.keep', '', { lease }), {
    mode: 'w',
  });
  await vfs.setStat(home + '/Pictures', {
    kind: 'dir',
    mode: DEFAULT_DIR_MODE,
    uid,
    gid,
  });

  // Seat at the first existing place when the VFS already has a world graph.
  // World packs own place ids — host code never invents apartment/cast names.
  try {
    let { listPlaceIds, placePath } = await import('./places.js');
    let placeIds = await listPlaceIds();
    let dest = placeIds[0];
    if (dest && typeof vfs.symlink === 'function') {
      let locPath = home + '/location';
      await vfs.withLock(
        locPath,
        (lease) =>
          vfs.symlink(placePath(dest), locPath, {
            force: true,
            uid,
            gid,
            lease,
          }),
        { mode: 'w' },
      );
    }
  } catch (err) {
    console.warn('provisionNpc location', err);
  }

  return actorFromUser(id);
}

export async function listNpcs() {
  await vfs.ensureReady();
  let { listUsers } = await import('./vfs-auth.js');
  let users = await listUsers();
  return Object.values(users).filter(
    (u) =>
      !['root', 'nobody', 'grok'].includes(u.name) && !u.human && Number(u.uid) >= 1001,
  );
}
