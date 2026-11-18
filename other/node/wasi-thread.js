/**
 * One thread of a wasi-threads process (see WASI#startThreads in wasi.js).
 *
 * Runs the module on the process's shared memory: the main thread calls
 * `_start`, spawned threads call `wasi_thread_start(tid, arg)`. Stateful WASI
 * calls (files, stdio, exit) and `wasi.thread-spawn` are forwarded to the
 * kernel (the process worker), blocking on this thread's cell until it
 * answers. Stateless ones (clocks, random, args/env, sleeps) run here, so a
 * sleeping thread doesn't hold up the others.
 */
import { createWasiModule } from './wasi.js';

let LOCAL = new Set(['args_get', 'args_sizes_get', 'environ_get', 'environ_sizes_get', 'clock_res_get', 'clock_time_get', 'random_get', 'sched_yield']);
let ENOSYS = 52;

self.addEventListener('message', async (ev) => {
  let m = ev.data || {};
  if (m.t !== 'start') return;
  let cell = new Int32Array(m.cell);
  let forward = (fn) =>
    function (...args) {
      Atomics.store(cell, 0, 0);
      self.postMessage({ t: 'call', fn, args });
      Atomics.wait(cell, 0, 0);
      return Atomics.load(cell, 1);
    };

  let { WASI } = createWasiModule({ sys: null, path: null, stdio: null, cwd: () => '/' });
  let local = new WASI({ version: 'preview1', args: m.args });
  local.env = m.env;
  local.memory = m.memory;
  let L = local.wasiImport;

  // poll_oneoff on clocks only is a sleep: do it here. Anything with fds goes to the kernel.
  let pollRemote = forward('poll_oneoff');
  let poll = (inPtr, outPtr, nsubs, neventsPtr) => {
    let v = new DataView(m.memory.buffer);
    for (let i = 0; i < nsubs; i++) if (v.getUint8(inPtr + i * 48 + 8) !== 0) return pollRemote(inPtr, outPtr, nsubs, neventsPtr);
    return L.poll_oneoff(inPtr, outPtr, nsubs, neventsPtr);
  };

  let importObject = {};
  for (let imp of WebAssembly.Module.imports(m.module)) {
    let ns = (importObject[imp.module] ??= {});
    if (imp.kind === 'memory') ns[imp.name] = m.memory;
    else if (imp.module === 'wasi' && imp.name === 'thread-spawn') ns[imp.name] = forward('thread-spawn');
    else if (imp.module === 'tehboxen') ns[imp.name] = forward('tehboxen:' + imp.name);
    else if (imp.module === 'wasi_snapshot_preview1' || imp.module === 'wasi_unstable') {
      ns[imp.name] = imp.name === 'poll_oneoff' ? poll : LOCAL.has(imp.name) ? L[imp.name] : L[imp.name] ? forward(imp.name) : () => ENOSYS;
    }
  }

  try {
    let instance = await WebAssembly.instantiate(m.module, importObject);
    if (m.main) instance.exports._start();
    else instance.exports.wasi_thread_start(m.tid, m.arg);
    self.postMessage({ t: m.main ? 'main-exit' : 'thread-exit' });
  } catch (err) {
    let wasm = err instanceof WebAssembly.RuntimeError || err instanceof WebAssembly.CompileError || err instanceof WebAssembly.LinkError;
    self.postMessage({
      t: 'trap',
      exception: typeof WebAssembly.Exception === 'function' && err instanceof WebAssembly.Exception,
      wasm,
      name: err?.name || 'Error',
      message: String(err?.message ?? err),
      stack: err?.stack ? (err.stack.startsWith(err.name) ? err.stack : `${err.name}: ${err.message}\n${err.stack}`) : '',
    });
  }
});
