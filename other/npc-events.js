/**
 * Duration wakes for NPC natural-language state machines.
 *
 * Watches home/<user>/profile.yaml. When runtime.state maps to a state with
 * duration.{min_s,max_s}, waits a random delay in that range and appends an
 * event to var/npc_events.yaml (append-only). Host monitors that file with
 * Relay wakes — never a 1-minute everyone-talk loop.
 * Live FSM state is runtime.state only (no state_machine.initial_state).
 */
import * as vfs from './vfs.js';
import { readYaml, appendYamlItem, ensureDir } from './messaging.js';
import { profilePath, loadProfile } from './npc-life.js';

export let NPC_EVENTS_PATH = 'var/npc_events.yaml';

/** @type {Map<string, { timer: any, token: string, state: string }>} */
let pending = new Map();
/** Dedup immediate `start` wakes: user → state_entered_at last emitted. */
let startEmitted = new Map();
let started = false;
let unsub = null;

function stateDef(profile, stateName) {
  let states = profile?.state_machine?.states;
  if (!Array.isArray(states)) return null;
  return states.find((s) => s && s.name === stateName) || null;
}

function durationBounds(def) {
  let d = def?.duration;
  if (!d || typeof d !== 'object') return null;
  let min = Number(d.min_s ?? d.min ?? d.minSec);
  let max = Number(d.max_s ?? d.max ?? d.maxSec);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  if (min < 0) min = 0;
  if (max < min) max = min;
  // Cap runaway profiles (agents may use long spans; JS still schedules).
  if (max > 24 * 3600) max = 24 * 3600;
  return { min, max };
}

function randBetween(min, max) {
  if (max <= min) return min;
  return min + Math.random() * (max - min);
}

function clearUser(username) {
  let hit = pending.get(username);
  if (!hit) return;
  try {
    clearTimeout(hit.timer);
  } catch {}
  pending.delete(username);
}

async function appendEvent(ev) {
  await ensureDir('var');
  if (!(await vfs.exists(NPC_EVENTS_PATH))) {
    // create-once empty file (not `[]` — that breaks YAML list appends)
    await vfs.withLock(
      NPC_EVENTS_PATH,
      (lease) => vfs.write(NPC_EVENTS_PATH, '', { lease }),
      { mode: 'w', actor: 'npc-events' },
    );
  }
  await appendYamlItem(NPC_EVENTS_PATH, ev, { actor: 'npc-events' });
}

/**
 * Re-read profile and (re)schedule a duration wake for the current state.
 */
export async function syncUser(username) {
  let id = String(username || '');
  if (!id || id === 'root' || id === 'nobody' || id === 'godshand') {
    clearUser(id);
    return null;
  }
  let profile;
  try {
    profile = await loadProfile(id);
  } catch {
    clearUser(id);
    return null;
  }
  if (!profile) {
    clearUser(id);
    return null;
  }
  let stateName = profile.runtime?.state || 'start';
  let def = stateDef(profile, stateName);
  let bounds = durationBounds(def);
  let enteredAt = profile.runtime?.state_entered_at || new Date().toISOString();
  let untilRaw = profile.runtime?.state_until;
  let untilMs = untilRaw ? Date.parse(untilRaw) : NaN;
  let untilDelay =
    Number.isFinite(untilMs) ? Math.max(0, untilMs - Date.now()) : null;

  // `start` has no duration — emit a one-shot state_due so the host watcher
  // wakes an agent to fan out via NL triggers (time / context).
  if (stateName === 'start') {
    clearUser(id);
    if (startEmitted.get(id) === enteredAt) {
      return { user: id, state: stateName, scheduled: false, start_wake: 'dedup' };
    }
    startEmitted.set(id, enteredAt);
    let token = 'start-' + id + '-' + String(enteredAt).replace(/\W+/g, '').slice(0, 24);
    await appendEvent({
      type: 'state_due',
      user: id,
      state: 'start',
      at: new Date().toISOString(),
      entered_at: enteredAt,
      waited_ms: 0,
      phone_attention: def?.flags?.phone_attention !== false,
      token,
    });
    return { user: id, state: 'start', scheduled: true, delay_ms: 0, token, start_wake: true };
  }

  // Schedule wake: normally the sooner of duration.{min,max} and
  // runtime.state_until. When runtime.state_hold is set, honor only until
  // (quiet holds — skip duration reconsider ticks).
  let delayMs = null;
  let reason = null;
  let hold = !!profile.runtime?.state_hold;
  if (hold && untilDelay != null) {
    delayMs = untilDelay;
    reason = 'until';
  } else {
    if (bounds) {
      delayMs = Math.round(randBetween(bounds.min, bounds.max) * 1000);
      reason = 'duration';
    }
    if (untilDelay != null) {
      if (delayMs == null || untilDelay < delayMs) {
        delayMs = untilDelay;
        reason = 'until';
      }
    }
  }

  if (delayMs == null) {
    clearUser(id);
    startEmitted.delete(id);
    return { user: id, state: stateName, scheduled: false };
  }

  let prev = pending.get(id);
  let untilKey = untilRaw || '';
  if (prev && prev.state === stateName && prev.untilKey === untilKey && reason === prev.reason) {
    return { user: id, state: stateName, scheduled: true, reused: true };
  }
  clearUser(id);
  startEmitted.delete(id);

  let token =
    't-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  let timer = setTimeout(() => {
    pending.delete(id);
    appendEvent({
      type: 'state_due',
      user: id,
      state: stateName,
      at: new Date().toISOString(),
      entered_at: enteredAt,
      waited_ms: delayMs,
      until: untilRaw || null,
      reason,
      phone_attention: def?.flags?.phone_attention !== false,
      token,
    }).catch((err) => console.warn('npc-events append', id, err));
  }, delayMs);
  pending.set(id, { timer, token, state: stateName, untilKey, reason });
  return {
    user: id,
    state: stateName,
    scheduled: true,
    delay_ms: delayMs,
    reason,
    until: untilRaw || null,
    token,
  };
}

async function onVfsChange(ev) {
  let p = String(ev?.path || '');
  // home/<user>/profile.yaml
  let m = /^home\/([^/]+)\/profile\.yaml$/.exec(p);
  if (!m) return;
  try {
    await syncUser(m[1]);
  } catch (err) {
    console.warn('npc-events sync', m[1], err);
  }
}

/** Scan all NPC profiles once (boot / reconnect). */
export async function syncAll() {
  await vfs.ensureReady();
  let all = await vfs.list();
  let users = new Set();
  for (let p of all) {
    let m = /^home\/([^/]+)\/profile\.yaml$/.exec(p);
    if (m) users.add(m[1]);
  }
  let out = [];
  for (let u of [...users].sort()) {
    out.push(await syncUser(u));
  }
  return out.filter(Boolean);
}

export function listPending() {
  return [...pending.entries()].map(([user, v]) => ({
    user,
    state: v.state,
    token: v.token,
  }));
}

/** Start the watcher once per page lifetime. */
export async function startNpcEvents() {
  if (started) return { already: true };
  await vfs.ensureReady();
  await ensureDir('var');
  unsub = vfs.onChange((ev) => {
    onVfsChange(ev);
  });
  started = true;
  let synced = await syncAll();
  return { started: true, synced: synced.length };
}

export function stopNpcEvents() {
  if (unsub) {
    try {
      unsub();
    } catch {}
    unsub = null;
  }
  for (let u of [...pending.keys()]) clearUser(u);
  started = false;
}
