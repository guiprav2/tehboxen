/**
 * NPC life — thin VFS helpers for agent-driven characters.
 *
 * Automation lanes: Relay monitor (chat only) · presence wakes (mood/move) ·
 * silent sim (mood/schedule, never chat). JS only loads/saves profiles, reports
 * where people are (location symlink is source of truth — never mirrored into
 * YAML), and applies explicit writes the agent requests. No automatic chat.
 */
import * as vfs from './vfs.js';
import { getUser, listUsers } from './vfs-auth.js';
import { readYaml, writeYaml } from './messaging.js';
import { whereIs, whoIsAt, moveTo, listExits } from './places.js';
import { provisionNpc, listNpcs } from './npc.js';
import { listChatsFor } from './chats.js';

export { whereIs, whoIsAt, moveTo, listExits, listNpcs };

let RESERVED = new Set(['root', 'nobody']);

export function profilePath(username) {
  return 'home/' + String(username) + '/profile.yaml';
}

/** Current FSM state definition, or null. */
export function stateDefFor(profile, stateName) {
  let name = stateName || profile?.runtime?.state || 'start';
  let states = profile?.state_machine?.states;
  if (!Array.isArray(states)) return null;
  return states.find((s) => s && s.name === name) || null;
}

/**
 * Whether the NPC is paying attention to their phone in the current state.
 * Default true when the flag is omitted. Sleeping / cooking etc. set false.
 */
export function phoneAttention(profile) {
  let def = stateDefFor(profile);
  if (def?.flags && Object.prototype.hasOwnProperty.call(def.flags, 'phone_attention')) {
    return !!def.flags.phone_attention;
  }
  return true;
}

/** Relay presence for UI: online when phone_attention, else offline. */
export function waPresence(profile) {
  return phoneAttention(profile) ? 'online' : 'offline';
}

/**
 * Compile an on_message.match rule into a RegExp.
 * Accepts `/pattern/flags`, plain strings (case-insensitive by default), or
 * strings that already start with `(?i)`.
 */
export function compileMessageMatch(match) {
  if (match == null || match === '') return null;
  if (match instanceof RegExp) return match;
  let s = String(match);
  let m = s.match(/^\/(.+)\/([a-z]*)$/i);
  if (m) {
    try {
      return new RegExp(m[1], m[2] || '');
    } catch {
      return null;
    }
  }
  // JS has no inline (?i) — strip a leading (?i) and use the i flag.
  let flags = 'i';
  if (s.startsWith('(?i)')) s = s.slice(4);
  else if (s.startsWith('(?-i)')) {
    s = s.slice(5);
    flags = '';
  }
  try {
    return new RegExp(s, flags);
  } catch {
    return null;
  }
}

/**
 * True when a transition's declarative `on_message` rule matches this inbound
 * chat event. Shape:
 *   on_message: { match: string|RegExp, from?: string|string[] }
 * `from` omitted → any sender. Match is tested against message text.
 */
export function messageMatchesTransition(transition, ev = {}) {
  let rule = transition?.on_message;
  if (!rule || typeof rule !== 'object') return false;
  let text = String(ev.text || '');
  if (!text) return false;
  if (rule.from != null) {
    let allow = Array.isArray(rule.from) ? rule.from : [rule.from];
    let who = String(ev.from || '');
    if (!allow.map(String).includes(who)) return false;
  }
  let re = compileMessageMatch(rule.match);
  if (!re) return false;
  return re.test(text);
}

/**
 * Scan the NPC's current-state transitions for a declarative `on_message` edge
 * that matches this inbound message. First match wins (array order).
 *
 * On hit: setNpcState(to, { keepUntil }) — keepUntil defaults true so a
 * shift-end deadline survives short work substates like cooking. Pass
 * `transition.on_message.keepUntil: false` to clear/replace until.
 *
 * Returns `{ applied, from, to, transition }` or `{ applied: false }`.
 */
export async function considerMessageTransition(username, ev = {}) {
  let id = String(username || '');
  if (!id || id === 'root' || id === 'nobody') {
    return { applied: false, reason: 'skip-user' };
  }
  let profile = await loadProfile(id);
  if (!profile) return { applied: false, reason: 'no-profile' };
  let fromState = profile.runtime?.state || 'start';
  let def = stateDefFor(profile, fromState);
  let transitions = def?.transitions || [];
  let hit = null;
  for (let t of transitions) {
    if (messageMatchesTransition(t, ev)) {
      hit = t;
      break;
    }
  }
  if (!hit || !hit.to) return { applied: false, reason: 'no-match', state: fromState };

  let keepUntil = hit.on_message?.keepUntil !== false;
  let opts = { keepUntil };
  // Message-driven substates (cooking, …) need duration wakes — clear quiet
  // hold unless the edge explicitly sets on_message.hold: true.
  if (hit.on_message?.hold === true) opts.hold = true;
  else opts.hold = false;

  await setNpcState(id, hit.to, opts);
  try {
    let { syncUser } = await import('./npc-events.js');
    await syncUser(id);
  } catch (err) {
    console.warn('considerMessageTransition syncUser', id, err);
  }
  return {
    applied: true,
    from: fromState,
    to: hit.to,
    transition: hit,
    keepUntil,
  };
}

/**
 * Transition an NPC's FSM: writes runtime.state (+ entered_at) and optional
 * runtime.state_until (ISO wake deadline for npc-events).
 *
 * opts.until — Date | ISO string | null to clear
 * opts.keepUntil — leave existing state_until alone (use when diving into a
 *   short substate like cooking while a shift-end until should still apply)
 * opts.hold — when true with an until, npc-events schedules only that until
 *   (skips the state's duration.* reconsider). Cleared on the next transition
 *   unless keepUntil+hold or hold is set again. Use for quiet holds (e.g.
 *   pre-service at_work until the owner opens).
 */
export async function setNpcState(username, stateName, opts = {}) {
  let id = String(username || '');
  let next = String(stateName || '');
  if (!id || !next) throw new Error('setNpcState: user and state required');
  let profile = await loadProfile(id);
  if (!profile) throw new Error('setNpcState: no profile for ' + id);
  profile.runtime = profile.runtime || defaultRuntime();
  profile.runtime.state = next;
  profile.runtime.state_entered_at = new Date().toISOString();
  profile.runtime.updated_at = profile.runtime.state_entered_at;
  if (opts.keepUntil) {
    // preserve runtime.state_until
  } else if (opts.until === null || opts.until === '') {
    delete profile.runtime.state_until;
  } else if (opts.until != null) {
    let d = opts.until instanceof Date ? opts.until : new Date(opts.until);
    if (Number.isNaN(d.getTime())) throw new Error('setNpcState: invalid until');
    profile.runtime.state_until = d.toISOString();
  } else {
    // omitted until → clear (new state without a deadline)
    delete profile.runtime.state_until;
  }
  if (opts.hold === true) {
    profile.runtime.state_hold = true;
  } else if (opts.hold === false || !opts.keepUntil) {
    // Explicit hold:false clears quiet hold even when keepUntil preserves the deadline.
    delete profile.runtime.state_hold;
  }
  await saveProfile(id, profile);
  return profile.runtime;
}

/** Mutable runtime defaults (no place, no last_contact_at). */
export function defaultRuntime() {
  return {
    state: 'start',
    state_entered_at: new Date().toISOString(),
    mood: {
      playful: 0.4,
      aroused: 0.15,
      lonely: 0.2,
      irritable: 0.05,
      sleepy: 0.1,
    },
    drives: {
      company: 0.35,
      sex: 0.2,
      rest: 0.15,
    },
    energy: 0.7,
    relations: {},
    updated_at: new Date().toISOString(),
  };
}

function deepMerge(base, patch) {
  if (patch == null) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return patch;
  if (typeof base !== 'object' || typeof patch !== 'object') return patch;
  let out = { ...base };
  for (let [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export async function loadProfile(username) {
  await vfs.ensureReady();
  let path = profilePath(username);
  let data = (await readYaml(path, null).catch(() => null)) || null;
  return data;
}

export async function saveProfile(username, data) {
  await vfs.ensureReady();
  let u = await getUser(username);
  if (!u) throw new Error('saveProfile: unknown user ' + username);
  let path = profilePath(username);
  await writeYaml(path, data);
  try {
    await vfs.setStat(path, {
      kind: 'file',
      mode: 0o644,
      uid: u.uid,
      gid: u.gid,
    });
  } catch {}
  return data;
}

/**
 * Merge a runtime patch into profile.runtime and bump updated_at.
 * Agent sets mood / drives / energy / relations / state explicitly.
 */
export async function patchRuntime(username, patch = {}) {
  let profile = (await loadProfile(username)) || {};
  let runtime = deepMerge(defaultRuntime(), profile.runtime || {});
  runtime = deepMerge(runtime, patch || {});
  runtime.updated_at = new Date().toISOString();
  // Never persist a mirrored place field if an agent accidentally sends one.
  if (runtime.place != null) delete runtime.place;
  if (runtime.last_contact_at != null) delete runtime.last_contact_at;
  profile.runtime = runtime;
  await saveProfile(username, profile);
  return runtime;
}

/** Users the life loop should consider (everyone except reserved system accounts). */
export async function listLifeNpcs() {
  await vfs.ensureReady();
  let users = await listUsers();
  return Object.values(users)
    .filter((u) => u?.name && !RESERVED.has(u.name))
    .map((u) => u.name)
    .sort();
}

async function recentChatDigest(username, limit = 4) {
  let out = [];
  try {
    let chats = await listChatsFor(username, 'relay');
    for (let c of chats.slice(0, 8)) {
      let view =
        c.kind === 'group' && c.viewId
          ? 'home/' + username + '/.relay/' + c.viewId + '/messages.yaml'
          : null;
      // DM views: peer folder is the other participant
      if (!view) {
        let peers = (c.participants || []).filter((p) => p !== username);
        let peer = peers[0];
        if (peer) view = 'home/' + username + '/.relay/' + peer + '/messages.yaml';
      }
      let events = view ? (await readYaml(view, []).catch(() => [])) || [] : [];
      if (!Array.isArray(events)) events = [];
      let msgs = events.filter(
        (m) =>
          m &&
          typeof m === 'object' &&
          String(m.type || '') !== 'receipt' &&
          !(m.msg != null && m.by != null && m.from == null && m.text == null),
      );
      let last = msgs.slice(-limit);
      out.push({
        id: c.chatId,
        title: c.title || (c.participants || []).filter((p) => p !== username).join(', ') || c.chatId,
        kind: c.kind,
        last: last.map((m) => ({
          from: m.from,
          text: String(m.text || '').slice(0, 200),
          time: m.time,
        })),
      });
    }
  } catch {}
  return out;
}

/** One NPC snapshot for the agent (location from symlink only). */
export async function snapshotNpc(username) {
  let profile = (await loadProfile(username)) || {};
  let runtime = deepMerge(defaultRuntime(), profile.runtime || {});
  let place = await whereIs(username);
  let present = place ? await whoIsAt(place) : [];
  let exits = place ? await listExits(place) : [];
  let chats = await recentChatDigest(username);
  let stateName = runtime.state || 'start';
  let states = profile.state_machine?.states || [];
  let stateDef = states.find((s) => s.name === stateName) || null;
  return {
    id: username,
    name: profile.name || username,
    archetype: profile.archetype || '',
    place,
    present,
    exits: exits.map((e) => e.targetId),
    schedule: profile.schedule || [],
    personality_16pf: profile.personality_16pf || null,
    runtime,
    fsm: {
      state: stateName,
      description: stateDef?.description || '',
      transitions: stateDef?.transitions || [],
      behaviors: stateDef?.behaviors || [],
    },
    chats,
  };
}

/** All life NPCs — primary payload for the 1-minute agent wake. */
export async function snapshotWorld() {
  let ids = await listLifeNpcs();
  let npcs = [];
  for (let id of ids) {
    try {
      npcs.push(await snapshotNpc(id));
    } catch (err) {
      npcs.push({ id, error: String(err?.message || err) });
    }
  }
  let { listHumans } = await import('./vfs.js');
  let players = {};
  for (let h of await listHumans()) {
    let at = await whereIs(h);
    players[h] = { place: at, present: at ? await whoIsAt(at) : [] };
  }
  return {
    at: new Date().toISOString(),
    players,
    npcs,
  };
}

/** Soft daily schedule hints baked into Tyler (agent may ignore). */
export function tylerProfileTemplate() {
  return {
    id: 'tyler',
    name: 'Tyler',
    archetype: 'gym-rat, warm-dominant, playful',
    about: 'Sweaty confidence, easy grin, always half a flirt away from trouble.',
    phone: '+3160000TYLR',
    color: '#ff7a59',
    physical: {
      hair: { color: 'dark brown', length: 'short', style: 'messy on purpose' },
      face: { eyes: { color: 'brown', gaze: 'direct' }, smile: 'easy, a little cocky' },
      body: { height_cm: 183, build: 'athletic, broad shoulders' },
    },
    clothes: {
      everyday: ['fitted tee', 'joggers', 'clean sneakers'],
      at_home: ['hoodie', 'boxers'],
      going_out: ['black shirt', 'dark jeans'],
    },
    personality_16pf: {
      warmth: 0.55,
      dominance: 0.7,
      liveliness: 0.65,
      social_boldness: 0.75,
      rule_consciousness: -0.35,
      privateness: -0.25,
      tension: -0.1,
    },
    // Soft hints only — agent decides whether to honor them.
    schedule: [
      { at: '07:30', place: 'gym', note: 'morning lift if nothing more interesting is on' },
      { at: '12:00', place: 'cafe', note: 'lunch / people-watching' },
      { at: '17:30', place: 'park', note: 'cool-down walk' },
      { at: '21:00', place: 'club', note: 'night out when energy is high' },
      { at: '02:00', place: 'cafe', note: 'wind-down / late snack; may linger with company' },
    ],
    state_machine: {
      states: [
        {
          name: 'social_idle',
          description: 'Baseline; approachable, lightly playful.',
          behaviors: ['easy eye contact', 'warm small talk', 'light teasing if rapport exists'],
          transitions: [
            {
              event: 'clear_flirt_or_chemistry',
              to: 'flirting',
              conditions: 'mood.playful high enough AND drives.company or drives.sex elevated',
            },
            { event: 'tired_or_overstimulated', to: 'withdrawn', conditions: 'energy low OR mood.sleepy high' },
            { event: 'bored_alone', to: 'disengaged', conditions: 'mood.lonely high AND no good company' },
          ],
        },
        {
          name: 'flirting',
          description: 'Playful escalation without full commitment.',
          behaviors: ['teasing', 'light touch', 'held eye contact', 'double entendres'],
          transitions: [
            { event: 'strong_reciprocation_and_privacy_ok', to: 'seduction' },
            { event: 'partner_pulls_back', to: 'social_idle' },
            { event: 'interrupted', to: 'social_idle' },
          ],
        },
        {
          name: 'seduction',
          description: 'Clear intent; directive and warm.',
          behaviors: ['closer distance', 'explicit interest', 'suggest private place'],
          transitions: [
            { event: 'private_and_mutual', to: 'intimate' },
            { event: 'needs_more_time', to: 'flirting' },
            { event: 'hard_no', to: 'social_idle' },
          ],
        },
        {
          name: 'intimate',
          description: 'Sexual activity underway.',
          behaviors: ['attentive', 'vocal', 'checks consent'],
          transitions: [
            { event: 'session_ends', to: 'afterglow' },
            { event: 'pause', to: 'intimate_pause' },
            { event: 'stop_signal', to: 'social_idle' },
          ],
        },
        {
          name: 'intimate_pause',
          description: 'Short break mid-session.',
          transitions: [
            { event: 'resume', to: 'intimate' },
            { event: 'end', to: 'afterglow' },
          ],
        },
        {
          name: 'afterglow',
          description: 'Post-sex wind-down.',
          transitions: [
            { event: 'another_round', to: 'intimate' },
            { event: 'done', to: 'social_idle' },
            { event: 'needs_space', to: 'withdrawn' },
          ],
        },
        {
          name: 'disengaged',
          description: 'Polite but checked out.',
          transitions: [
            { event: 'interesting_stimulus', to: 'social_idle' },
            { event: 'prolonged_boredom', to: 'withdrawn' },
          ],
        },
        {
          name: 'withdrawn',
          description: 'Low social energy.',
          transitions: [
            { event: 'energy_returns', to: 'social_idle' },
            { event: 'compelling_invite', to: 'social_idle' },
          ],
        },
      ],
      global_modifiers: [
        'Personality biases how the agent nudges mood/drives; it does not hard-gate transitions.',
        'Honor schedule only when not tangled with a player or another scene that matters more.',
      ],
    },
    other_details: [
      'Notices when a player is nearby and will often text if he has not seen them in a while.',
      'Gym talk and food pics are easy openers; dirty jokes come once rapport is warm.',
      'Will ignore a schedule stop if mid-flirt or mid-care with someone he likes.',
    ],
    runtime: defaultRuntime(),
  };
}

/**
 * Ensure Tyler exists with a life profile. Idempotent: keeps existing runtime
 * mood/drives if profile already present; refreshes static template fields when
 * opts.forceTemplate is true.
 */
export async function ensureTyler(opts = {}) {
  await vfs.ensureReady();
  let existing = await getUser('tyler');
  if (!existing) {
    await provisionNpc({
      id: 'tyler',
      gecos: 'Tyler',
      phone: '+3160000TYLR',
      about: 'Sweaty confidence, easy grin.',
      color: '#ff7a59',
    });
  }
  let cur = await loadProfile('tyler');
  let template = tylerProfileTemplate();
  if (!cur || opts.forceTemplate) {
    if (cur?.runtime) template.runtime = deepMerge(defaultRuntime(), cur.runtime);
    await saveProfile('tyler', template);
  } else if (!cur.runtime || !cur.state_machine || !cur.schedule) {
    let merged = {
      ...template,
      ...cur,
      schedule: cur.schedule || template.schedule,
      state_machine: cur.state_machine || template.state_machine,
      personality_16pf: cur.personality_16pf || template.personality_16pf,
      runtime: deepMerge(defaultRuntime(), cur.runtime || {}),
    };
    await saveProfile('tyler', merged);
  } else {
    // Strip forbidden mirrored fields if an older profile wrote them.
    if (cur.runtime?.place != null || cur.runtime?.last_contact_at != null) {
      await patchRuntime('tyler', {});
    }
  }
  return snapshotNpc('tyler');
}

/**
 * Demo life hook — world cast lives in the VFS / world packs, not host JS.
 * Kept as a no-op so older callers (Danger Zone, agents) do not break.
 */
export async function ensureDemoLife(opts = {}) {
  return snapshotWorld();
}
