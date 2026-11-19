#!/usr/bin/env node
/**
 * Host-side NPC wake monitor (Node — same stack as dbgserver).
 *
 * Tails `.tehboxen-dbg/events.ndjson` and prints one line per wake for the agent's monitor
 * `monitor` to pick up:
 *
 *   ACTION_REQUIRED: npc_message|<npc>|<peer>|<text>|<msgKey>|<dm|group>
 *   ACTION_REQUIRED: npc_state_due|<npc>|<state>|<at>|<token>
 *
 * Wakes when:
 *  1. `home/<npc>/.relay/<peer>/messages.yaml` changes and the newest event
 *     is from another NPC (players' messages are lane 1, bin/watch-relay.mjs).
 *  2. `var/npc_events.yaml` gains a new `state_due` (from other/npc-events.js).
 *
 * Usage:
 *   node bin/watch-npc.mjs
 *   # then: monitor(command="node bin/watch-npc.mjs", persistent=true)
 *
 * Env:
 *   TEHBOXEN_DBG   — dbg dir (default: <cwd>/.tehboxen-dbg)
 *   WATCH_NPC_STATE — state file (default: $TEHBOXEN_DBG/watch-npc-state.json)
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

let __dirname = path.dirname(fileURLToPath(import.meta.url));
let ROOT = path.resolve(__dirname, '..');
let DBG = process.env.TEHBOXEN_DBG || path.join(ROOT, '.tehboxen-dbg');
let EVENTS = path.join(DBG, 'events.ndjson');
let STATE_PATH =
  process.env.WATCH_NPC_STATE || path.join(DBG, 'watch-npc-state.json');
let LOG_PATH = process.env.WATCH_NPC_LOG || path.join(DBG, 'watch-npc.log');
let RPC_DIR = path.join(DBG, 'rpc');

let SKIP_USERS = new Set(['root', 'nobody', 'guest']);
let DEBOUNCE_MS = 200;
let RPC_TIMEOUT_MS = 20000;

/** @type {{ offset: number, answered: Record<string, true>, npcEventCount: number }} */
let state = { offset: 0, answered: {}, npcEventCount: 0 };

let pendingMsg = new Map(); // path -> timer
let pendingNpcEvents = null;

/** Diagnostics only — never stdout (monitor wakes on every stdout line). */
function log(...args) {
  let line = '[watch-npc] ' + args.map(String).join(' ') + '\n';
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

function wake(line) {
  // stdout only — monitor tool watches this
  console.log(line);
}

async function loadState() {
  try {
    let raw = await fsp.readFile(STATE_PATH, 'utf8');
    let j = JSON.parse(raw);
    state.offset = Number(j.offset) || 0;
    state.answered = j.answered && typeof j.answered === 'object' ? j.answered : {};
    state.npcEventCount = Number(j.npcEventCount) || 0;
  } catch {
    // first run: start at EOF so we don't replay history
    try {
      let st = await fsp.stat(EVENTS);
      state.offset = st.size;
    } catch {
      state.offset = 0;
    }
  }
}

async function saveState() {
  // Unique tmp name: overlapping saves must not rename each other's file away.
  let tmp = STATE_PATH + '.' + process.pid + '.' + randomUUID() + '.tmp';
  await fsp.writeFile(
    tmp,
    JSON.stringify(
      {
        offset: state.offset,
        answered: state.answered,
        npcEventCount: state.npcEventCount,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await fsp.rename(tmp, STATE_PATH);
}

function rpc(op, args = {}, user = 'root') {
  return new Promise(async (resolve, reject) => {
    let id = randomUUID();
    let req = path.join(RPC_DIR, `req-${id}.json`);
    let res = path.join(RPC_DIR, `res-${id}.json`);
    await fsp.mkdir(RPC_DIR, { recursive: true });
    await fsp.writeFile(
      req,
      JSON.stringify({ id, op, user, args }),
      'utf8',
    );
    let t0 = Date.now();
    let timer = setInterval(async () => {
      try {
        if (!(await fsp.stat(res).catch(() => null))) {
          if (Date.now() - t0 > RPC_TIMEOUT_MS) {
            clearInterval(timer);
            reject(new Error('RPC timeout ' + op));
          }
          return;
        }
        clearInterval(timer);
        let body = JSON.parse(await fsp.readFile(res, 'utf8'));
        try {
          await fsp.unlink(res);
        } catch {}
        if (!body.ok) reject(new Error(body.error || 'rpc failed'));
        else resolve(body.result);
      } catch (err) {
        clearInterval(timer);
        reject(err);
      }
    }, 80);
  });
}

/** Parse home/<user>/.relay/<peer>/messages.yaml */
function parseNpcMessagePath(p) {
  let m = /^home\/([^/]+)\/\.relay\/([^/]+)\/messages\.yaml$/.exec(p || '');
  if (!m) return null;
  let user = m[1];
  let peer = m[2];
  if (SKIP_USERS.has(user)) return null;
  if (peer === '.keep' || peer === 'profile.yaml') return null;
  return { user, peer, kind: peer.startsWith('g-') ? 'group' : 'dm' };
}

/** Human (player) usernames, from the users db via RPC; cached 15s. */
let humansCache = { at: 0, set: new Set() };
async function humans() {
  if (Date.now() - humansCache.at < 15000) return humansCache.set;
  try {
    let result = await rpc('eval', {
      body: `let { listHumans } = await import('../other/vfs.js'); return await listHumans();`,
    });
    let list = result?.value ?? result ?? [];
    humansCache = { at: Date.now(), set: new Set(Array.isArray(list) ? list : []) };
  } catch (err) {
    log('listHumans failed', err.message || err);
  }
  return humansCache.set;
}

function msgKey(ev) {
  if (!ev || typeof ev !== 'object') return '';
  if (ev.id) return String(ev.id);
  return [ev.from, ev.time, ev.text, (ev.files || []).join(',')].join('|');
}

function isReceipt(ev) {
  return ev && (ev.type === 'receipt' || (ev.msg && ev.by && !ev.text && !ev.from));
}

async function readMessages(user, peer) {
  let p = `home/${user}/.relay/${peer}/messages.yaml`;
  // eval: short lock + YAML parse via messaging helper
  let result = await rpc('eval', {
    body: `
      let { readYaml } = await import('../other/messaging.js');
      let path = ${JSON.stringify(p)};
      let data = await vfs.withLock(
        path,
        (lease) => readYaml(path, [], { lease }),
        { mode: 'r', actor: 'watch-npc' },
      );
      return Array.isArray(data) ? data : [];
    `,
  });
  return result?.value ?? result ?? [];
}

async function readNpcEvents() {
  let p = 'var/npc_events.yaml';
  let result = await rpc('eval', {
    body: `
      let { readYaml } = await import('../other/messaging.js');
      let path = ${JSON.stringify(p)};
      if (!(await vfs.exists(path))) return [];
      let data = await vfs.withLock(
        path,
        (lease) => readYaml(path, [], { lease }),
        { mode: 'r', actor: 'watch-npc' },
      );
      return Array.isArray(data) ? data : [];
    `,
  });
  return result?.value ?? result ?? [];
}

async function npcPhoneAttention(user) {
  try {
    let result = await rpc('eval', {
      body: `
        let { loadProfile, phoneAttention } = await import('../other/npc-life.js');
        let p = await loadProfile(${JSON.stringify(user)});
        return { ok: !!p, attention: p ? phoneAttention(p) : false, fsm: p?.runtime?.state || null };
      `,
    });
    let v = result?.value ?? result ?? {};
    return { attention: !!v.attention, fsm: v.fsm || null };
  } catch (err) {
    log('phoneAttention failed', user, err.message || err);
    return { attention: true, fsm: null }; // fail open so we don't drop wakes forever
  }
}

async function emitNpcMessageWake(user, peer, kind, ev) {
  let key = `${user}|${peer}|${msgKey(ev)}`;
  if (state.answered[key]) return false;
  state.answered[key] = true;
  let keys = Object.keys(state.answered);
  if (keys.length > 2000) {
    for (let k of keys.slice(0, keys.length - 1500)) delete state.answered[k];
  }
  await saveState();
  let text = String(ev.text || '')
    .replace(/\|/g, '/')
    .replace(/\n/g, ' ')
    .slice(0, 200);
  wake(
    `ACTION_REQUIRED: npc_message|${user}|${peer}|${text}|${msgKey(ev)}|${kind}`,
  );
  return true;
}

async function handleNpcMessage(user, peer, kind) {
  let attn = await npcPhoneAttention(user);
  if (!attn.attention) {
    log('defer inbox', user, peer, 'fsm=' + attn.fsm, 'phone_attention=false');
    return;
  }
  let list;
  try {
    list = await readMessages(user, peer);
  } catch (err) {
    log('readMessages failed', user, peer, err.message || err);
    return;
  }
  // Newest message-like event not from this npc
  for (let i = list.length - 1; i >= 0; i--) {
    let ev = list[i];
    if (!ev || isReceipt(ev)) continue;
    let from = String(ev.from || '');
    if (!from || from === user) continue;
    if (from === 'me' || from === 'them') continue;
    // Player outbound is lane 1 (`bin/watch-relay.mjs`); don't double-wake.
    if ((await humans()).has(from)) return;
    await emitNpcMessageWake(user, peer, kind, ev);
    return;
  }
}

/** After a state_due, if the NPC now has phone attention, flush deferred inbox. */
async function flushDeferredInbox(user) {
  let attn = await npcPhoneAttention(user);
  if (!attn.attention) return;
  let result;
  try {
    result = await rpc('eval', {
      body: `
        let prefix = 'home/' + ${JSON.stringify(user)} + '/.relay/';
        let all = await vfs.list();
        let peers = [];
        for (let p of all) {
          if (!p.startsWith(prefix) || !p.endsWith('/messages.yaml')) continue;
          let peer = p.slice(prefix.length).split('/')[0];
          if (!peer || peer.startsWith('.')) continue;
          peers.push(peer);
        }
        return peers;
      `,
    });
  } catch (err) {
    log('flush list peers failed', user, err.message || err);
    return;
  }
  let peers = result?.value ?? result ?? [];
  for (let peer of peers) {
    let kind = String(peer).startsWith('g-') ? 'group' : 'dm';
    try {
      let list = await readMessages(user, peer);
      for (let i = list.length - 1; i >= 0; i--) {
        let ev = list[i];
        if (!ev || isReceipt(ev)) continue;
        let from = String(ev.from || '');
        if (!from || from === user || from === 'me' || from === 'them') continue;
        let key = `${user}|${peer}|${msgKey(ev)}`;
        if (state.answered[key]) continue;
        await emitNpcMessageWake(user, peer, kind, ev);
        break; // one wake per peer per flush
      }
    } catch (err) {
      log('flush peer failed', user, peer, err.message || err);
    }
  }
}

async function handleNpcEventsFile() {
  let list;
  try {
    list = await readNpcEvents();
  } catch (err) {
    log('readNpcEvents failed', err.message || err);
    return;
  }
  if (list.length < state.npcEventCount) {
    // file recreated
    state.npcEventCount = 0;
  }
  let fresh = list.slice(state.npcEventCount);
  state.npcEventCount = list.length;
  await saveState();
  for (let ev of fresh) {
    if (!ev || ev.type !== 'state_due') continue;
    let user = String(ev.user || '');
    if (!user || SKIP_USERS.has(user)) continue;
    let st = String(ev.state || '');
    let at = String(ev.at || '');
    let token = String(ev.token || '');
    let akey = `state_due|${user}|${token || st + '|' + at}`;
    if (state.answered[akey]) continue;
    state.answered[akey] = true;
    wake(`ACTION_REQUIRED: npc_state_due|${user}|${st}|${at}|${token}`);
    // If this wake is for a state with phone attention (or after agent transitions
    // into one), flush inbox on next tick — also flush here when already attentive.
    setTimeout(() => {
      flushDeferredInbox(user).catch((err) => log('flush', err.message || err));
    }, 50);
  }
  await saveState();
}

/** Startup / catch-up: wake for every NPC still in runtime.state === 'start'. */
async function scanStartStates() {
  let result;
  try {
    result = await rpc('eval', {
      body: `
        let { listUsers } = await import('../other/vfs-auth.js');
        let { loadProfile } = await import('../other/npc-life.js');
        let skip = new Set(['root','nobody','godshand','guest']);
        let out = [];
        for (let name of Object.keys(await listUsers()).sort()) {
          if (skip.has(name)) continue;
          let p = await loadProfile(name).catch(() => null);
          if (!p) continue;
          let st = p.runtime?.state || 'start';
          if (st !== 'start') continue;
          out.push({
            user: name,
            state: 'start',
            entered_at: p.runtime?.state_entered_at || '',
          });
        }
        return out;
      `,
    });
  } catch (err) {
    log('scanStartStates failed', err.message || err);
    return;
  }
  let list = result?.value ?? result ?? [];
  for (let row of list) {
    let user = String(row.user || '');
    if (!user || SKIP_USERS.has(user)) continue;
    let entered = String(row.entered_at || '');
    let token = 'start-' + user + '-' + entered.replace(/\W+/g, '').slice(0, 24);
    let akey = `state_due|${user}|${token}`;
    if (state.answered[akey]) continue;
    state.answered[akey] = true;
    let at = new Date().toISOString();
    wake(`ACTION_REQUIRED: npc_state_due|${user}|start|${at}|${token}`);
  }
  await saveState();
}

function onVfsEvent(ev) {
  let p = String(ev.path || '');
  let op = String(ev.op || '');
  if (op && op !== 'write' && op !== 'append') return;

  if (p === 'var/npc_events.yaml') {
    if (pendingNpcEvents) clearTimeout(pendingNpcEvents);
    pendingNpcEvents = setTimeout(() => {
      pendingNpcEvents = null;
      handleNpcEventsFile().catch((err) => log(err));
    }, DEBOUNCE_MS);
    return;
  }

  let hit = parseNpcMessagePath(p);
  if (!hit) return;
  let key = p;
  if (pendingMsg.has(key)) clearTimeout(pendingMsg.get(key));
  pendingMsg.set(
    key,
    setTimeout(() => {
      pendingMsg.delete(key);
      handleNpcMessage(hit.user, hit.peer, hit.kind).catch((err) => log(err));
    }, DEBOUNCE_MS),
  );
}

async function readNewEvents() {
  let fh;
  try {
    fh = await fsp.open(EVENTS, 'r');
  } catch {
    return;
  }
  try {
    let st = await fh.stat();
    if (st.size < state.offset) state.offset = 0; // truncated
    if (st.size === state.offset) return;
    let len = st.size - state.offset;
    let buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, state.offset);
    state.offset = st.size;
    await saveState();
    let text = buf.toString('utf8');
    for (let line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'vfs') onVfsEvent(ev);
    }
  } finally {
    await fh.close();
  }
}

async function main() {
  await fsp.mkdir(DBG, { recursive: true });
  if (!fs.existsSync(EVENTS)) await fsp.writeFile(EVENTS, '', 'utf8');
  await loadState();
  await saveState();
  log('watching', EVENTS, 'offset', state.offset);
  log(
    'wakes: npc_message (NPC↔NPC) + npc_state_due (incl. start fan-out)',
  );

  // poll — chokidar optional; simple interval is enough for ndjson append
  setInterval(() => {
    readNewEvents().catch((err) => log('tail', err.message || err));
  }, 250);

  // seed npcEventCount from current file once so we don't dump history
  if (state.npcEventCount === 0) {
    try {
      let list = await readNpcEvents();
      state.npcEventCount = list.length;
      await saveState();
      log('npc_events baseline', state.npcEventCount);
    } catch (err) {
      log('npc_events baseline skip', err.message || err);
    }
  }

  // Catch-up: anyone still in `start` needs an agent fan-out wake.
  await scanStartStates();

  // Ask in-page npc-events to re-sync (emits start state_due if not yet emitted).
  try {
    await rpc('eval', {
      body: `
        let { syncAll, startNpcEvents } = await import('../other/npc-events.js');
        await startNpcEvents();
        return await syncAll();
      `,
    });
    log('npc-events syncAll ok');
  } catch (err) {
    log('npc-events syncAll skip', err.message || err);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
