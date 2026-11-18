/**
 * Syscall channel between a node Worker and the page.
 *
 * Blocking calls (readFileSync & co.): the worker posts a request and
 * `Atomics.wait`s on a SharedArrayBuffer; the page performs the async VFS
 * operation, writes the encoded reply into the buffer and `Atomics.notify`s.
 * Replies bigger than the buffer are sent in chunks (the worker asks for the
 * next one with another blocking 'more' call).
 *
 * Non-blocking calls (fs.promises, callbacks) are plain request/response
 * messages, so the worker's event loop keeps running meanwhile.
 *
 * SharedArrayBuffer needs a cross-origin-isolated page (COOP + COEP).
 *
 * Buffer layout: Int32 [state, requestId, totalLength, chunkLength] then data.
 * state: 0 idle, 1 waiting for the page, 2 reply ready. The page echoes the
 * request id so the worker never takes a stale or duplicated reply as its own.
 */
let HEADER = 16;
let enc = new TextEncoder();
let dec = new TextDecoder();

export let SAB_SIZE = 4 * 1024 * 1024;

/** Reply → bytes: 0 = JSON value, 1 = raw bytes value, 2 = JSON error. */
function encodeReply(ok, value) {
  if (ok && value instanceof Uint8Array) {
    let out = new Uint8Array(value.length + 1);
    out[0] = 1;
    out.set(value, 1);
    return out;
  }
  let body = enc.encode(JSON.stringify(ok ? { v: value === undefined ? null : value } : value));
  let out = new Uint8Array(body.length + 1);
  out[0] = ok ? 0 : 2;
  out.set(body, 1);
  return out;
}

function decodeReply(bytes) {
  if (bytes[0] === 1) return { ok: true, value: bytes.subarray(1) };
  let obj = JSON.parse(dec.decode(bytes.subarray(1)));
  return bytes[0] === 0 ? { ok: true, value: obj.v } : { ok: false, error: obj };
}

/* ---------- page side ---------- */

/**
 * Serve a worker's syscalls.
 * @param {Worker} worker
 * @param {SharedArrayBuffer} sab
 * @param {{ call: (op: string, args: object) => Promise<any> }} host
 * @param {(msg: any) => void} onOther other worker messages (output, exit, …)
 */
export function serveWorker(worker, sab, host, onOther) {
  let ctrl = new Int32Array(sab, 0, 4);
  let data = new Uint8Array(sab, HEADER);
  let pending = null; // remaining bytes of a chunked reply

  let pendingId = 0;
  function deliver(bytes, total, id) {
    let n = Math.min(bytes.length, data.length);
    data.set(bytes.subarray(0, n));
    pending = n < bytes.length ? bytes.subarray(n) : null;
    pendingId = id;
    Atomics.store(ctrl, 1, id);
    Atomics.store(ctrl, 2, total);
    Atomics.store(ctrl, 3, n);
    Atomics.store(ctrl, 0, 2);
    Atomics.notify(ctrl, 0);
  }

  worker.addEventListener('message', async (ev) => {
    let m = ev.data || {};
    if (m.t === 'sys') {
      let bytes;
      try {
        bytes = encodeReply(true, await host.call(m.op, m.args));
      } catch (err) {
        bytes = encodeReply(false, err?.__syserr ? err : { code: 'EIO', message: String(err?.message || err) });
      }
      deliver(bytes, bytes.length, m.id);
      return;
    }
    if (m.t === 'more') {
      if (pending && m.id === pendingId) deliver(pending, Atomics.load(ctrl, 2), m.id);
      return;
    }
    if (m.t === 'asys') {
      try {
        let value = await host.call(m.op, m.args);
        worker.postMessage({ t: 'ares', id: m.id, ok: true, value }, value instanceof Uint8Array ? [value.buffer] : []);
      } catch (err) {
        worker.postMessage({ t: 'ares', id: m.id, ok: false, error: err?.__syserr ? err : { code: 'EIO', message: String(err?.message || err) } });
      }
      return;
    }
    onOther(m);
  });
}

/* ---------- worker side ---------- */

/** Rebuild a Node-style Error from a sysError object. */
export function toError(e) {
  let err = new Error(e?.message || 'Unknown system error');
  for (let k of ['code', 'errno', 'syscall', 'path', 'dest']) if (e?.[k] != null) err[k] = e[k];
  return err;
}

export function createSyscalls(sab) {
  let ctrl = new Int32Array(sab, 0, 4);
  let data = new Uint8Array(sab, HEADER);
  let seq = 0;
  let syncSeq = 0;
  let waiting = new Map();

  self.addEventListener('message', (ev) => {
    let m = ev.data || {};
    if (m.t !== 'ares') return;
    let w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    m.ok ? w.resolve(m.value) : w.reject(toError(m.error));
  });

  /** Blocking syscall: returns the value or throws a Node-style error. */
  /** Wait until the page has put *our* reply (state 2 + matching id) in the buffer. */
  function awaitReply(id) {
    for (;;) {
      Atomics.wait(ctrl, 0, 1);
      if (Atomics.load(ctrl, 0) === 2 && Atomics.load(ctrl, 1) === id) return;
      // Stale or duplicate delivery: put the state back and keep waiting.
      Atomics.store(ctrl, 0, 1);
    }
  }

  function sync(op, args) {
    let id = (syncSeq = (syncSeq % 0x7fffffff) + 1);
    Atomics.store(ctrl, 0, 1);
    self.postMessage({ t: 'sys', id, op, args });
    let chunks = [];
    let got = 0;
    let total = 0;
    for (;;) {
      awaitReply(id);
      total = Atomics.load(ctrl, 2);
      let n = Atomics.load(ctrl, 3);
      chunks.push(data.slice(0, n));
      got += n;
      if (got >= total) break;
      Atomics.store(ctrl, 0, 1);
      self.postMessage({ t: 'more', id });
    }
    Atomics.store(ctrl, 0, 0);
    let bytes = chunks.length === 1 ? chunks[0] : new Uint8Array(total);
    if (chunks.length > 1) {
      let o = 0;
      for (let c of chunks) {
        bytes.set(c, o);
        o += c.length;
      }
    }
    let r = decodeReply(bytes);
    if (!r.ok) throw toError(r.error);
    return r.value;
  }

  /** Non-blocking syscall: a Promise for the value. */
  function async(op, args) {
    let id = ++seq;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      self.postMessage({ t: 'asys', id, op, args });
    });
  }

  return { sync, async };
}
