/**
 * This realm's network identity: the page is the player's own box, each box
 * Worker (other/box/kernel.js) is that box. Shell commands, node/WASI socket
 * syscalls and the resolver all use whatever stack the realm registered here,
 * so the same code is "the kernel" of whichever machine it runs on.
 */
import { createResolver } from './resolver.js';

let state = { stack: null, hostname: 'tehboxen', boxId: null, resolver: null };
let readyResolve;
let ready = new Promise((r) => (readyResolve = r));
let readText = null;

/** Called once by the realm's kernel (page: other/net/boot.js; box: other/box/kernel.js). */
export function setLocalNet({ stack, hostname, boxId, readFile }) {
  state.stack = stack;
  if (hostname) state.hostname = hostname;
  if (boxId !== undefined) state.boxId = boxId;
  readText = readFile;
  state.resolver = createResolver(() => state.stack, (p) => (readText ? readText(p) : Promise.resolve(null)));
  readyResolve(state.stack);
}

export function setHostname(name) {
  state.hostname = String(name || '').trim() || state.hostname;
  if (state.stack) state.stack.hostname = state.hostname;
}

export let hostname = () => state.hostname;
export let boxId = () => state.boxId;
/** The stack, or null while the network is still booting / absent (login page). */
export let currentStack = () => state.stack;

/** Wait for the network (rejects with ENETDOWN after `timeout` ms). */
export async function localStack(timeout = 15000) {
  if (state.stack) return state.stack;
  let timer;
  try {
    return await Promise.race([ready, new Promise((_, rej) => (timer = setTimeout(() => rej(Object.assign(new Error('Network is down'), { code: 'ENETDOWN' })), timeout)))]);
  } finally {
    clearTimeout(timer);
  }
}

export async function localResolver() {
  await localStack();
  return state.resolver;
}
