/** Minimal EventEmitter / Writable / Readable for browser kitty + xterm. */

export class EventEmitter {
  constructor() {
    this._events = new Map();
  }

  on(event, fn) {
    if (!this._events.has(event)) this._events.set(event, []);
    this._events.get(event).push(fn);
    return this;
  }

  addListener(event, fn) {
    return this.on(event, fn);
  }

  once(event, fn) {
    let wrap = (...args) => {
      this.off(event, wrap);
      fn(...args);
    };
    return this.on(event, wrap);
  }

  off(event, fn) {
    let list = this._events.get(event);
    if (!list) return this;
    let i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }

  removeListener(event, fn) {
    return this.off(event, fn);
  }

  removeAllListeners(event) {
    if (event == null) this._events.clear();
    else this._events.delete(event);
    return this;
  }

  emit(event, ...args) {
    let list = this._events.get(event);
    if (!list || !list.length) return false;
    for (let fn of [...list]) {
      try {
        fn(...args);
      } catch (err) {
        queueMicrotask(() => {
          throw err;
        });
      }
    }
    return true;
  }

  listenerCount(event) {
    return this._events.get(event)?.length || 0;
  }
}

export class Writable extends EventEmitter {
  constructor(options = {}) {
    super();
    this._writeImpl = options.write || ((_chunk, _enc, cb) => cb());
    this._finalImpl = options.final || (cb => cb());
    this.writable = true;
    this.destroyed = false;
    this._ended = false;
  }

  write(chunk, encoding, callback) {
    if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }
    if (this._ended || this.destroyed) {
      let err = new Error('write after end');
      if (callback) callback(err);
      else this.emit('error', err);
      return false;
    }
    let done = false;
    let cb = err => {
      if (done) return;
      done = true;
      if (err) this.emit('error', err);
      if (callback) callback(err);
      else if (!err) this.emit('drain');
    };
    try {
      this._writeImpl(chunk, encoding || 'utf8', cb);
    } catch (err) {
      cb(err);
    }
    return true;
  }

  end(chunk, encoding, callback) {
    if (typeof chunk === 'function') {
      callback = chunk;
      chunk = null;
    } else if (typeof encoding === 'function') {
      callback = encoding;
      encoding = 'utf8';
    }
    if (chunk != null) this.write(chunk, encoding);
    this._ended = true;
    this._finalImpl(err => {
      if (err) this.emit('error', err);
      this.emit('finish');
      if (callback) callback(err);
    });
    return this;
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    this.writable = false;
    if (err) this.emit('error', err);
    this.emit('close');
    return this;
  }
}

export class Readable extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.isRaw = false;
    this.readable = true;
    this._paused = false;
    this._buffer = [];
  }

  push(chunk) {
    if (this._paused) this._buffer.push(chunk);
    else this.emit('data', chunk);
    return true;
  }

  pause() {
    this._paused = true;
    return this;
  }

  resume() {
    this._paused = false;
    while (this._buffer.length) this.emit('data', this._buffer.shift());
    return this;
  }

  setRawMode(mode) {
    this.isRaw = !!mode;
    return this;
  }

  setEncoding() {
    return this;
  }
}

export function isBuffer(chunk) {
  return (
    typeof Buffer !== 'undefined' &&
    typeof Buffer.isBuffer === 'function' &&
    Buffer.isBuffer(chunk)
  );
}

export function chunkToString(chunk, encoding = 'utf8') {
  if (chunk == null) return '';
  if (typeof chunk === 'string') return chunk;
  if (isBuffer(chunk)) return chunk.toString(encoding);
  if (chunk instanceof Uint8Array) {
    return new TextDecoder(encoding || 'utf8').decode(chunk);
  }
  return String(chunk);
}
