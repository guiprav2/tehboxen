#!/usr/bin/env node
/**
 * Host-side player outbound Relay monitor (lane 1).
 *
 * Tails `.tehboxen-dbg/events.ndjson` and prints one line per wake when a
 * player (users db `human: true`) sends in `home/<player>/.relay/<peer>/messages.yaml`:
 *
 *   ACTION_REQUIRED: relay|<name>|<folderId>|<text>|<msgKey>|<dm|group>|<player>
 *
 * The agent should reply in character as <folderId> (the contact).
 * NPC inbox wakes (messages between NPCs) stay on `bin/watch-npc.mjs`.
 *
 * Usage:
 *   node bin/watch-relay.mjs
 *   monitor(command="node bin/watch-relay.mjs", persistent=true)
 *
 * Env:
 *   TEHBOXEN_DBG — dbg dir (default: <cwd>/.tehboxen-dbg)
 *   WATCH_WA_STATE — state file (default: $TEHBOXEN_DBG/watch-relay-state.json)
 *   WATCH_WA_LOG — log file (default: $TEHBOXEN_DBG/watch-relay.log)
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
  process.env.WATCH_WA_STATE || path.join(DBG, 'watch-relay-state.json');
let LOG_PATH = process.env.WATCH_WA_LOG || path.join(DBG, 'watch-relay.log');
let RPC_DIR = path.join(DBG, 'rpc');

let DEBOUNCE_MS = 200;
let RPC_TIMEOUT_MS = 20000;

/** @type {{ offset: number, answered: Record<string, true> }} */
let state = { offset: 0, answered: {} };
let pending = new Map(); // path -> timer

function log(...args) {
  let line = '[watch-relay] ' + args.map(String).join(' ') + '\n';
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

function wake(line) {
  console.log(line);
}

async function loadState() {
  try {
    let raw = await fsp.readFile(STATE_PATH, 'utf8');
    let j = JSON.parse(raw);
    state.offset = Number(j.offset) || 0;
    state.answered = j.answered && typeof j.answered === 'object' ? j.answered : {};
  } catch {
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
    await fsp.writeFile(req, JSON.stringify({ id, op, user, args }), 'utf8');
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

/** home/<user>/.relay/<peer>/messages.yaml (user checked against humans() later) */
function parsePlayerRelayPath(p) {
  let m = /^home\/([^/]+)\/\.relay\/([^/]+)\/messages\.yaml$/.exec(p || '');
  if (!m) return null;
  let player = m[1];
  let peer = m[2];
  if (!peer || peer.startsWith('.')) return null;
  return { player, peer, kind: peer.startsWith('g-') ? 'group' : 'dm' };
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
  return ev && (ev.type === 'receipt' || ev.msg != null && ev.by != null && !ev.text);
}

async function readMessages(player, peer) {
  let p = `home/${player}/.relay/${peer}/messages.yaml`;
  let result = await rpc('eval', {
    body: `
      let { readYaml } = await import('../other/messaging.js');
      let path = ${JSON.stringify(p)};
      let data = await vfs.withLock(
        path,
        (lease) => readYaml(path, [], { lease }),
        { mode: 'r', actor: 'watch-relay' },
      );
      return Array.isArray(data) ? data : [];
    `,
  });
  return result?.value ?? result ?? [];
}

async function contactDisplayName(player, peer) {
  try {
    let result = await rpc('eval', {
      body: `
        let { readYaml } = await import('../other/messaging.js');
        let p = ${JSON.stringify('home/' + player + '/.relay/' + peer + '/profile.yaml')};
        let prof = await vfs.withLock(p, (lease) => readYaml(p, {}, { lease }), { mode: 'r' }).catch(() => ({}));
        return (prof && (prof.name || prof.title)) || ${JSON.stringify(peer)};
      `,
    });
    return String(result?.value ?? result ?? peer);
  } catch {
    return peer;
  }
}

async function handlePlayerOutbound(player, peer, kind) {
  if (!(await humans()).has(player)) return;
  let list;
  try {
    list = await readMessages(player, peer);
  } catch (err) {
    log('readMessages failed', peer, err.message || err);
    return;
  }
  // Newest message from the player (outbound)
  for (let i = list.length - 1; i >= 0; i--) {
    let ev = list[i];
    if (!ev || isReceipt(ev)) continue;
    let from = String(ev.from || '');
    if (from !== player) continue;
    let key = `wa|${player}|${peer}|${msgKey(ev)}`;
    if (state.answered[key]) return;
    state.answered[key] = true;
    let keys = Object.keys(state.answered);
    if (keys.length > 2000) {
      for (let k of keys.slice(0, keys.length - 1500)) delete state.answered[k];
    }
    await saveState();
    let name = await contactDisplayName(player, peer);
    let text = String(ev.text || '')
      .replace(/\|/g, '/')
      .replace(/\n/g, ' ')
      .slice(0, 200);
    wake(
      `ACTION_REQUIRED: relay|${name}|${peer}|${text}|${msgKey(ev)}|${kind}|${player}`,
    );
    return;
  }
}

function onVfsEvent(ev) {
  let p = String(ev?.path || '');
  let parsed = parsePlayerRelayPath(p);
  if (!parsed) return;
  let { player, peer, kind } = parsed;
  let prev = pending.get(p);
  if (prev) clearTimeout(prev);
  pending.set(
    p,
    setTimeout(() => {
      pending.delete(p);
      handlePlayerOutbound(player, peer, kind).catch((err) =>
        log('handle', peer, err.message || err),
      );
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
    if (st.size < state.offset) state.offset = 0;
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
  log('wakes: relay (player outbound → reply as contact)');
  setInterval(() => {
    readNewEvents().catch((err) => log('tail', err.message || err));
  }, 250);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
