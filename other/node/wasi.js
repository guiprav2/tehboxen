/**
 * node:wasi — WASI preview1 (wasi_snapshot_preview1) for the node worker.
 *
 * Files are the real VFS through the blocking syscall channel, with the
 * process user's permissions; preopens map guest directories onto VFS paths
 * and paths can't escape them (ENOTCAPABLE). Open files are buffered in the
 * worker and written back on close / fd_sync / exit. Sockets are not
 * simulated yet.
 *
 * API mirrors Node: new WASI({ version, args, env, preopens, returnOnExit,
 * stdin, stdout, stderr }), wasi.wasiImport, wasi.getImportObject(),
 * wasi.start(instance), wasi.initialize(instance).
 *
 * Threads (wasi-threads, tehboxen extension): `await wasi.startThreads(module,
 * bytes)` runs a module that imports a shared memory and `wasi.thread-spawn`.
 * This worker becomes the process "kernel": it owns the fd table and serves
 * every thread's WASI calls, while the main thread and each pthread run in
 * their own Worker (wasi-thread.js) on the shared memory. Stateless calls
 * (clocks, random, args, sleeps) run in the calling thread.
 */

import { spawnModuleWorker } from './spawn-worker.js';

let E = {
  SUCCESS: 0, '2BIG': 1, ACCES: 2, AGAIN: 6, BADF: 8, EXIST: 20, FAULT: 21, FBIG: 22, INVAL: 28, IO: 29, ISDIR: 31,
  LOOP: 32, MFILE: 33, NAMETOOLONG: 37, NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, NOTTY: 59,
  NOTSOCK: 57, PERM: 63, SPIPE: 70, XDEV: 75, NOTCAPABLE: 76, BUSY: 10,
};
let FILETYPE = { unknown: 0, block: 1, chr: 2, dir: 3, file: 4, dgram: 5, stream: 6, symlink: 7 };
let O = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 };
let FDFLAG = { APPEND: 1, DSYNC: 2, NONBLOCK: 4, RSYNC: 8, SYNC: 16 };
let RIGHT = { FD_READ: 1n << 1n, FD_SEEK: 1n << 2n, FD_TELL: 1n << 5n, FD_WRITE: 1n << 6n, PATH_CREATE_FILE: 1n << 10n, PATH_OPEN: 1n << 13n, FD_READDIR: 1n << 14n, PATH_FILESTAT_SET_SIZE: 1n << 19n, FD_FILESTAT_SET_SIZE: 1n << 22n };
let ALL_RIGHTS = (1n << 30n) - 1n;
let FILE_RIGHTS = ALL_RIGHTS & ~(RIGHT.FD_READDIR | (1n << 9n) | (1n << 10n) | (1n << 13n));
let DIR_RIGHTS = ALL_RIGHTS & ~(RIGHT.FD_READ | RIGHT.FD_WRITE | RIGHT.FD_SEEK | RIGHT.FD_TELL);

let CODE_TO_ERRNO = {
  ENOENT: E.NOENT, EACCES: E.ACCES, EEXIST: E.EXIST, ENOTDIR: E.NOTDIR, EISDIR: E.ISDIR, ENOTEMPTY: E.NOTEMPTY,
  EINVAL: E.INVAL, ELOOP: E.LOOP, EPERM: E.PERM, EXDEV: E.XDEV, EBADF: E.BADF, ENOSYS: E.NOSYS, ERR_FS_EISDIR: E.ISDIR, EBUSY: E.BUSY,
};

class WASIError extends Error {
  constructor(errno) {
    super('wasi errno ' + errno);
    this.errno = errno;
  }
}
class WASIExit extends Error {
  constructor(code) {
    super('wasi exit ' + code);
    this.code = code;
  }
}

let enc = new TextEncoder();
let dec = new TextDecoder();

/**
 * @param {object} ctx { sys, path, stdio: { stdin(), stdout(bytes), stderr(bytes) }, cwd() }
 */
export function createWasiModule(ctx) {
  let { sys, path: P } = ctx;
  let call = (op, args) => {
    try {
      return sys.sync(op, args);
    } catch (err) {
      throw new WASIError(CODE_TO_ERRNO[err.code] ?? E.IO);
    }
  };
  let tryStat = (p, follow = true) => {
    try {
      return sys.sync('stat', { path: p, follow });
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw new WASIError(CODE_TO_ERRNO[err.code] ?? E.IO);
    }
  };
  let inoOf = (s, p) => BigInt(s?.ino ?? hashPath(p));

  class WASI {
    constructor(options = {}) {
      if (options.version !== undefined && options.version !== 'preview1' && options.version !== 'unstable') {
        throw Object.assign(new TypeError(`The "options.version" property must be one of: 'unstable', 'preview1'. Received ${JSON.stringify(options.version)}`), { code: 'ERR_INVALID_ARG_VALUE' });
      }
      this.args = (options.args || []).map(String);
      this.env = Object.entries(options.env || {}).map(([k, v]) => `${k}=${v}`);
      this.returnOnExit = options.returnOnExit ?? true;
      this.fds = new Map();
      this.fds.set(0, { kind: 'stdio', stdio: 0, rights: ALL_RIGHTS, flags: 0 });
      this.fds.set(1, { kind: 'stdio', stdio: 1, rights: ALL_RIGHTS, flags: FDFLAG.APPEND });
      this.fds.set(2, { kind: 'stdio', stdio: 2, rights: ALL_RIGHTS, flags: FDFLAG.APPEND });
      let next = 3;
      for (let [guest, host] of Object.entries(options.preopens || {})) {
        let hostPath = P.resolve(ctx.cwd(), String(host));
        this.fds.set(next++, { kind: 'dir', path: hostPath, root: hostPath, preopen: String(guest), rights: DIR_RIGHTS, inheriting: ALL_RIGHTS, flags: 0 });
      }
      this.stdinPos = 0;
      this.open = new Map(); // host path → { data, size, dirty, refs }: fds on one file share it
      this.times = new Map(); // host path (L: prefix = the link itself) → { atim, mtim } in ns
      this.memory = null;
      this.started = false;
      this.wasiImport = this._imports();
      this.tehboxenImport = this._tehboxenImports();
    }

    getImportObject() {
      return { wasi_snapshot_preview1: this.wasiImport, tehboxen: this.tehboxenImport };
    }

    _bind(instance) {
      if (!instance?.exports?.memory) throw Object.assign(new TypeError('"instance.exports.memory" property must be a WebAssembly.Memory object'), { code: 'ERR_INVALID_ARG_TYPE' });
      this.memory = instance.exports.memory;
    }

    start(instance) {
      if (this.started) throw Object.assign(new Error('WASI instance has already started'), { code: 'ERR_WASI_ALREADY_STARTED' });
      this.started = true;
      this._bind(instance);
      if (typeof instance.exports._start !== 'function') throw Object.assign(new TypeError('"instance.exports._start" property must be a function'), { code: 'ERR_INVALID_ARG_TYPE' });
      try {
        instance.exports._start();
        this._flushAll();
        return 0;
      } catch (err) {
        this._flushAll();
        if (err instanceof WASIExit) {
          if (this.returnOnExit) return err.code;
          ctx.exit(err.code);
        }
        // A C++ exception nobody caught: with Wasm EH it surfaces here instead of reaching
        // std::terminate, so report it the way libc++abi does and exit like abort() (SIGABRT).
        if (typeof WebAssembly.Exception === 'function' && err instanceof WebAssembly.Exception) {
          ctx.stdio.stderr(enc.encode('libc++abi: terminating due to uncaught exception\n'));
          if (this.returnOnExit) return 134;
          ctx.exit(134);
        }
        throw err;
      }
    }

    /**
     * Run a wasi-threads module (see the header). Resolves to the exit code;
     * rejects with the trap if a thread crashes.
     */
    startThreads(module, bytes) {
      if (this.started) throw Object.assign(new Error('WASI instance has already started'), { code: 'ERR_WASI_ALREADY_STARTED' });
      this.started = true;
      let lim = bytes ? memoryImportLimits(bytes) : null;
      if (!WebAssembly.Module.imports(module).some((i) => i.kind === 'memory')) throw new TypeError('wasi-threads: the module must import its memory (link with --import-memory)');
      if (lim && !lim.shared) throw new TypeError('wasi-threads: the imported memory must be shared');
      let memory = new WebAssembly.Memory({ initial: lim?.min ?? 17, maximum: lim?.max ?? 16384, shared: true });
      this.memory = memory;
      let imports = this.wasiImport;
      let release = ctx.ref?.();
      let threads = new Map();
      let nextTid = 1;
      let self = this;
      return new Promise((resolve, reject) => {
        let done = false;
        let end = () => {
          done = true;
          for (let w of threads.values()) w.terminate();
          threads.clear();
          try {
            self._flushAll();
          } catch {}
          release?.();
        };
        let finish = (code) => {
          if (done) return;
          end();
          resolve(code);
        };
        let fail = (err) => {
          if (done) return;
          end();
          reject(err);
        };
        let spawn = (main, arg) => {
          let tid = main ? 0 : nextTid++;
          if (tid > 0x1fffffff) return -1;
          let worker;
          try {
            worker = spawnModuleWorker(new URL('./wasi-thread.js', import.meta.url), { name: main ? 'wasi-main' : 'wasi-thread-' + tid });
          } catch {
            return -1;
          }
          let cell = new Int32Array(new SharedArrayBuffer(8));
          threads.set(tid, worker);
          worker.addEventListener('message', (ev) => {
            let m = ev.data || {};
            if (done) return;
            if (m.t === 'call') {
              let value = 0;
              try {
                value = m.fn === 'thread-spawn' ? spawn(false, m.args[0]) : m.fn.startsWith('tehboxen:') ? self.tehboxenImport[m.fn.slice(9)](...m.args) : imports[m.fn](...m.args);
              } catch (err) {
                if (err instanceof WASIExit) return finish(err.code);
                if (err?.name === 'ProcessExit') return finish(err.code ?? 0);
                return fail(err);
              }
              Atomics.store(cell, 1, value | 0);
              Atomics.store(cell, 0, 1);
              Atomics.notify(cell, 0);
            } else if (m.t === 'main-exit') finish(0);
            else if (m.t === 'thread-exit') {
              worker.terminate();
              threads.delete(tid);
            } else if (m.t === 'trap') {
              if (m.exception) {
                ctx.stdio.stderr(enc.encode('libc++abi: terminating due to uncaught exception\n'));
                return finish(134);
              }
              let err = new (globalThis[m.name] && /Error$/.test(m.name) ? globalThis[m.name] : Error)(m.message);
              if (m.wasm) err = new (WebAssembly[m.name] || Error)(m.message);
              err.stack = m.stack || `${m.name}: ${m.message}`;
              fail(err);
            }
          });
          worker.addEventListener('error', (ev) => {
            ev.preventDefault?.();
            fail(new Error(`wasi thread ${tid} failed to start: ${ev.message || 'unknown error'}`));
          });
          worker.postMessage({ t: 'start', main, tid, arg, module, memory, cell: cell.buffer, args: self.args, env: self.env });
          return tid;
        };
        spawn(true, 0);
      });
    }

    initialize(instance) {
      if (this.started) throw Object.assign(new Error('WASI instance has already started'), { code: 'ERR_WASI_ALREADY_STARTED' });
      this.started = true;
      this._bind(instance);
      if (typeof instance.exports._initialize === 'function') instance.exports._initialize();
    }

    _flushAll() {
      for (let file of this.open.values()) this._flushFile(file);
    }

    _flushFile(file) {
      if (!file?.dirty || file.unlinked) return;
      sys.sync('writeFile', { path: file.path, data: file.data.subarray(0, file.size) });
      file.dirty = false;
    }

    _flush(fd) {
      if (fd?.kind === 'file' && fd.file) this._flushFile(fd.file);
    }

    /** Flush buffered writes for a path before path-based operations look at it. */
    _flushPath(p) {
      this._flushFile(this.open.get(p));
    }

    _load(fd) {
      if (fd.file) return fd.file;
      let file = this.open.get(fd.path);
      if (!file) {
        let bytes = new Uint8Array(call('readFile', { path: fd.path }));
        file = { path: fd.path, data: bytes, size: bytes.length, dirty: false, refs: 0 };
        this.open.set(fd.path, file);
      }
      file.refs++;
      fd.file = file;
      return file;
    }

    _release(fd) {
      if (!fd?.file) return;
      this._flushFile(fd.file);
      if (--fd.file.refs <= 0) this.open.delete(fd.file.path);
      fd.file = null;
    }

    _ensure(file, need) {
      if (file.data.length >= need) return;
      let grown = new Uint8Array(Math.max(need, file.data.length * 2, 4096));
      grown.set(file.data.subarray(0, file.size));
      file.data = grown;
    }

    _resolve(dirfd, guestPath, follow) {
      let base = this.fds.get(dirfd);
      if (!base) throw new WASIError(E.BADF);
      if (base.kind !== 'dir') throw new WASIError(E.NOTDIR);
      let rel = String(guestPath);
      if (rel.startsWith('/')) throw new WASIError(E.NOTCAPABLE);
      let target = P.normalize(P.join(base.path, rel));
      let inside = (p) => p === base.root || p.startsWith(base.root.endsWith('/') ? base.root : base.root + '/');
      if (!inside(target)) throw new WASIError(E.NOTCAPABLE);
      // Symlinks must not lead out of the preopen either.
      if (follow) {
        let st = tryStat(target, false);
        if (st?.kind === 'symlink') {
          let real;
          try {
            real = sys.sync('realpath', { path: target });
          } catch {
            real = null;
          }
          if (real && !inside(real)) throw new WASIError(E.NOTCAPABLE);
        }
      } else if (rel.endsWith('/')) {
        // Trailing slash forces directory semantics (and following the last link).
        let st = tryStat(target, false);
        if (st?.kind === 'symlink') throw new WASIError(E.NOTDIR);
      }
      return target;
    }

    /**
     * Process calls WASI lacks (used by libtehboxen's system()/popen()):
     * tehboxen.system(cmd, len) runs cmd with the shell and returns its exit
     * status; the command's output goes to this process's stdout/stderr.
     */
    _tehboxenImports() {
      let self = this;
      return {
        /** Terminal modes from tcsetattr (libtehboxen): canonical/echo/signals/output processing. */
        tty_mode(icanon, echo, isig, opost) {
          if (!ctx.tty?.stdin && !ctx.tty?.stdout) return -1;
          try {
            sys.sync('ttyMode', { icanon: !!icanon, echo: !!echo, isig: !!isig, opost: !!opost });
            return 0;
          } catch {
            return -1;
          }
        },
        /** Permission bits of an absolute path (WASI's filestat has none), or -1. */
        mode(ptr, len) {
          if (!ctx.sys) return -1;
          let path = dec.decode(new Uint8Array(self.memory.buffer).slice(ptr, ptr + len));
          try {
            return sys.sync('stat', { path, follow: true }).mode & 0o7777;
          } catch {
            return -1;
          }
        },
        /** [mode, uid, gid] of an absolute path into out (3 × u32); 0, or -1 if missing. */
        owner(ptr, len, follow, out) {
          if (!ctx.sys) return -1;
          let path = dec.decode(new Uint8Array(self.memory.buffer).slice(ptr, ptr + len));
          try {
            let s = sys.sync('stat', { path, follow: !!follow });
            let v = new DataView(self.memory.buffer);
            v.setUint32(out, s.mode & 0o7777, true);
            v.setUint32(out + 4, s.uid >>> 0, true);
            v.setUint32(out + 8, s.gid >>> 0, true);
            return 0;
          } catch {
            return -1;
          }
        },
        /** Same for an open fd (files and directories this process opened). */
        fd_owner(fd, out) {
          let f = self.fds.get(fd);
          if (!f?.path || !ctx.sys) return -1;
          try {
            let s = sys.sync('stat', { path: f.path, follow: true });
            let v = new DataView(self.memory.buffer);
            v.setUint32(out, s.mode & 0o7777, true);
            v.setUint32(out + 4, s.uid >>> 0, true);
            v.setUint32(out + 8, s.gid >>> 0, true);
            return 0;
          } catch {
            return -1;
          }
        },
        /** (uid << 32) | gid of the process's user. */
        ids() {
          let [uid, gid] = ctx.ids?.() || [0, 0];
          return (BigInt(uid >>> 0) << 32n) | BigInt(gid >>> 0);
        },
        /** (rows << 16) | cols, or -1 when not on a terminal. */
        tty_size() {
          if (!ctx.tty?.stdin && !ctx.tty?.stdout) return -1;
          try {
            let { rows, cols } = sys.sync('ttySize', {});
            return ((rows & 0xffff) << 16) | (cols & 0xffff);
          } catch {
            return -1;
          }
        },
        getcwd(ptr, len) {
          let cwd = enc.encode(ctx.cwd());
          if (cwd.length > len) return -1;
          new Uint8Array(self.memory.buffer).set(cwd, ptr);
          return cwd.length;
        },
        system(ptr, len) {
          if (!ctx.sys) return -1;
          let cmd = dec.decode(new Uint8Array(self.memory.buffer).slice(ptr, ptr + len));
          // Let the command see what this process wrote so far.
          self._flushAll();
          let env = {};
          for (let kv of self.env) {
            let i = kv.indexOf('=');
            if (i > 0) env[kv.slice(0, i)] = kv.slice(i + 1);
          }
          let r;
          try {
            r = sys.sync('exec', { cmd, cwd: ctx.cwd(), env });
          } catch {
            return -1;
          }
          if (r.stdout) ctx.stdio.stdout(typeof r.stdout === 'string' ? enc.encode(r.stdout) : new Uint8Array(r.stdout));
          if (r.stderr) ctx.stdio.stderr(typeof r.stderr === 'string' ? enc.encode(r.stderr) : new Uint8Array(r.stderr));
          // Our buffered copies of files the command changed are stale now.
          for (let [p, file] of self.open) {
            if (file.dirty) continue;
            try {
              file.data = new Uint8Array(sys.sync('readFile', { path: p }));
              file.size = file.data.length;
            } catch {}
          }
          return r.code | 0;
        },
      };
    }

    _imports() {
      let self = this;
      let view = () => new DataView(self.memory.buffer);
      let bytes = () => new Uint8Array(self.memory.buffer);
      // slice, not subarray: TextDecoder refuses views of shared memory.
      let str = (ptr, len) => dec.decode(bytes().slice(ptr, ptr + len));
      let iovecs = (ptr, len) => {
        let v = view();
        let out = [];
        for (let i = 0; i < len; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)]);
        return out;
      };
      let fdOf = (fd) => {
        let f = self.fds.get(fd);
        if (!f) throw new WASIError(E.BADF);
        return f;
      };
      let writeFilestat = (ptr, s, p, timesKey = p) => {
        let v = view();
        v.setBigUint64(ptr, 2049n, true);
        v.setBigUint64(ptr + 8, inoOf(s, p), true);
        v.setUint8(ptr + 16, FILETYPE[s.kind] ?? FILETYPE.unknown);
        v.setBigUint64(ptr + 24, BigInt(s.nlink || 1), true);
        let open = self.open.get(p);
        v.setBigUint64(ptr + 32, BigInt(s.kind === 'file' && open ? open.size : s.size || 0), true);
        let t = BigInt(Math.floor(s.mtime || Date.now())) * 1000000n;
        // The VFS keeps milliseconds; times set in this process keep their nanoseconds while the file is unchanged.
        let o = self.times.get(timesKey);
        let mtim = o?.mtim != null && o.mtim / 1000000n === t / 1000000n ? o.mtim : t;
        v.setBigUint64(ptr + 40, o?.atim ?? t, true);
        v.setBigUint64(ptr + 48, mtim, true);
        v.setBigUint64(ptr + 56, mtim, true);
      };
      let setTimes = (key, p, atim, mtim, fstflags, follow) => {
        if (fstflags & ~0xf || (fstflags & 1 && fstflags & 2) || (fstflags & 4 && fstflags & 8)) throw new WASIError(E.INVAL);
        let now = BigInt(Date.now()) * 1000000n;
        let o = { ...(self.times.get(key) || {}) };
        if (fstflags & 2) o.atim = now;
        else if (fstflags & 1) o.atim = atim;
        let m = fstflags & 8 ? now : fstflags & 4 ? mtim : null;
        if (m != null && o.atim == null) {
          // atime is independent of mtime: pin its current value before mtime moves.
          let cur = tryStat(p, follow);
          o.atim = BigInt(Math.floor(cur?.mtime || Date.now())) * 1000000n;
        }
        if (m != null) {
          o.mtim = m;
          call('utimes', { path: p, mtime: Number(m / 1000000n), follow });
        }
        self.times.set(key, o);
      };
      // Every import returns an errno; WASIError → its errno, WASIExit propagates.
      let wrap = (fn) =>
        function (...a) {
          try {
            return fn(...a) ?? E.SUCCESS;
          } catch (err) {
            if (err instanceof WASIError) return err.errno;
            if (err instanceof WASIExit || err?.name === 'ProcessExit') throw err;
            if (err instanceof RangeError) return E.FAULT;
            throw err;
          }
        };
      let listArgs = (list, ptrsPtr, bufPtr) => {
        let v = view();
        let b = bytes();
        for (let s of list) {
          v.setUint32(ptrsPtr, bufPtr, true);
          ptrsPtr += 4;
          let e = enc.encode(s + '\0');
          b.set(e, bufPtr);
          bufPtr += e.length;
        }
      };
      let sizes = (list, countPtr, sizePtr) => {
        let v = view();
        v.setUint32(countPtr, list.length, true);
        v.setUint32(sizePtr, list.reduce((n, s) => n + enc.encode(s).length + 1, 0), true);
      };
      let readInto = (f, iovs, position) => {
        let total = 0;
        let b = bytes();
        if (f.kind === 'stdio') {
          if (f.stdio !== 0) throw new WASIError(E.BADF);
          if (ctx.tty?.stdin) {
            // A terminal: block until the user types (a line, or keys in raw mode); empty = EOF (Ctrl-D).
            let want = iovs.reduce((n, [, len]) => n + len, 0);
            let data = new Uint8Array(sys.sync('ttyRead', { max: want }));
            let o = 0;
            for (let [buf, len] of iovs) {
              let n = Math.min(len, data.length - o);
              b.set(data.subarray(o, o + n), buf);
              o += n;
              if (o >= data.length) break;
            }
            return data.length;
          }
          let input = ctx.stdio.stdin();
          for (let [buf, len] of iovs) {
            let chunk = input.subarray(self.stdinPos, self.stdinPos + len);
            b.set(chunk, buf);
            self.stdinPos += chunk.length;
            total += chunk.length;
            if (chunk.length < len) break;
          }
          return total;
        }
        if (f.kind === 'dir') throw new WASIError(E.ISDIR);
        if (!(f.rights & RIGHT.FD_READ)) throw new WASIError(E.BADF);
        let file = self._load(f);
        let pos = position ?? f.pos;
        for (let [buf, len] of iovs) {
          let n = Math.max(0, Math.min(len, file.size - pos));
          b.set(file.data.subarray(pos, pos + n), buf);
          pos += n;
          total += n;
          if (n < len) break;
        }
        if (position == null) f.pos = pos;
        return total;
      };
      let writeFrom = (f, iovs, position) => {
        let b = bytes();
        let chunks = iovs.map(([buf, len]) => b.slice(buf, buf + len));
        let total = chunks.reduce((n, c) => n + c.length, 0);
        if (f.kind === 'stdio') {
          if (f.stdio === 0) throw new WASIError(E.BADF);
          let all = new Uint8Array(total);
          let o = 0;
          for (let c of chunks) {
            all.set(c, o);
            o += c.length;
          }
          (f.stdio === 1 ? ctx.stdio.stdout : ctx.stdio.stderr)(all);
          return total;
        }
        if (f.kind === 'dir') throw new WASIError(E.ISDIR);
        if (!(f.rights & RIGHT.FD_WRITE)) throw new WASIError(E.BADF);
        let file = self._load(f);
        let pos = position ?? (f.flags & FDFLAG.APPEND ? file.size : f.pos);
        self._ensure(file, pos + total);
        if (pos > file.size) file.data.fill(0, file.size, pos);
        for (let c of chunks) {
          file.data.set(c, pos);
          pos += c.length;
        }
        file.size = Math.max(file.size, pos);
        file.dirty = true;
        self.times.delete(f.path);
        if (position == null) f.pos = pos;
        if (f.flags & (FDFLAG.SYNC | FDFLAG.DSYNC)) self._flush(f);
        return total;
      };
      let sleepCell = null;
      let sleep = (ms) => {
        sleepCell ??= new Int32Array(new SharedArrayBuffer(4));
        if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms);
      };

      return {
        args_get: wrap((argv, buf) => listArgs(self.args, argv, buf)),
        args_sizes_get: wrap((c, s) => sizes(self.args, c, s)),
        environ_get: wrap((envp, buf) => listArgs(self.env, envp, buf)),
        environ_sizes_get: wrap((c, s) => sizes(self.env, c, s)),
        clock_res_get: wrap((id, ptr) => {
          if (id > 3) return E.INVAL;
          view().setBigUint64(ptr, id === 0 ? 1000000n : 1000n, true);
        }),
        clock_time_get: wrap((id, _precision, ptr) => {
          if (id > 3) return E.INVAL;
          let ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.floor(performance.now() * 1e6));
          view().setBigUint64(ptr, ns, true);
        }),
        fd_advise: wrap((fd) => void fdOf(fd)),
        fd_allocate: wrap((fd, offset, len) => {
          let f = fdOf(fd);
          if (f.kind !== 'file') return E.BADF;
          let file = self._load(f);
          let end = Number(offset) + Number(len);
          if (end > file.size) {
            self._ensure(file, end);
            file.data.fill(0, file.size, end);
            file.size = end;
            file.dirty = true;
          }
        }),
        fd_close: wrap((fd) => {
          let f = fdOf(fd);
          self._release(f);
          if (f.kind === 'file') sys.sync('unlock', { path: f.path });
          self.fds.delete(fd);
        }),
        fd_datasync: wrap((fd) => self._flush(fdOf(fd))),
        fd_sync: wrap((fd) => self._flush(fdOf(fd))),
        fd_fdstat_get: wrap((fd, ptr) => {
          let f = fdOf(fd);
          let v = view();
          v.setUint8(ptr, f.kind === 'stdio' ? FILETYPE.chr : f.kind === 'dir' ? FILETYPE.dir : FILETYPE.file);
          v.setUint16(ptr + 2, f.flags || 0, true);
          // isatty(): a character device without seek/tell rights.
          let tty = f.kind === 'stdio' && (f.stdio === 0 ? ctx.tty?.stdin : ctx.tty?.stdout);
          v.setBigUint64(ptr + 8, tty ? ALL_RIGHTS & ~(RIGHT.FD_SEEK | RIGHT.FD_TELL) : (f.rights ?? ALL_RIGHTS), true);
          v.setBigUint64(ptr + 16, f.inheriting ?? ALL_RIGHTS, true);
        }),
        fd_fdstat_set_flags: wrap((fd, flags) => {
          fdOf(fd).flags = flags;
        }),
        fd_fdstat_set_rights: wrap((fd, base, inheriting) => {
          let f = fdOf(fd);
          if ((base & ~(f.rights ?? ALL_RIGHTS)) !== 0n) return E.NOTCAPABLE;
          f.rights = base;
          f.inheriting = inheriting;
        }),
        fd_filestat_get: wrap((fd, ptr) => {
          let f = fdOf(fd);
          if (f.kind === 'stdio') return writeFilestat(ptr, { kind: 'chr', size: 0, mtime: Date.now() }, '/dev/stdio' + fd);
          writeFilestat(ptr, call('stat', { path: f.path }), f.path);
        }),
        fd_filestat_set_size: wrap((fd, size) => {
          let f = fdOf(fd);
          if (f.kind !== 'file') return E.BADF;
          if (!(f.rights & RIGHT.FD_FILESTAT_SET_SIZE)) return E.NOTCAPABLE;
          let file = self._load(f);
          let n = Number(size);
          self._ensure(file, n);
          if (n > file.size) file.data.fill(0, file.size, n);
          file.size = n;
          file.dirty = true;
        }),
        fd_filestat_set_times: wrap((fd, _atim, mtim, fstflags) => {
          let f = fdOf(fd);
          if (f.kind === 'stdio') return;
          // Pin atime as last reported before flushing buffered writes (which move mtime).
          let o = self.times.get(f.path) || {};
          if (o.atim == null) {
            let cur = tryStat(f.path, true);
            self.times.set(f.path, { ...o, atim: BigInt(Math.floor(cur?.mtime || Date.now())) * 1000000n });
          }
          self._flush(f);
          setTimes(f.path, f.path, _atim, mtim, fstflags, true);
        }),
        fd_pread: wrap((fd, iovs, len, offset, nreadPtr) => {
          let f = fdOf(fd);
          if (f.kind === 'stdio') return E.SPIPE;
          view().setUint32(nreadPtr, readInto(f, iovecs(iovs, len), Number(offset)), true);
        }),
        fd_pwrite: wrap((fd, iovs, len, offset, nwrittenPtr) => {
          let f = fdOf(fd);
          if (f.kind === 'stdio') return E.SPIPE;
          view().setUint32(nwrittenPtr, writeFrom(f, iovecs(iovs, len), Number(offset)), true);
        }),
        fd_read: wrap((fd, iovs, len, nreadPtr) => {
          view().setUint32(nreadPtr, readInto(fdOf(fd), iovecs(iovs, len)), true);
        }),
        fd_write: wrap((fd, iovs, len, nwrittenPtr) => {
          view().setUint32(nwrittenPtr, writeFrom(fdOf(fd), iovecs(iovs, len)), true);
        }),
        fd_prestat_get: wrap((fd, ptr) => {
          let f = fdOf(fd);
          if (f.preopen == null) return E.BADF;
          let v = view();
          v.setUint8(ptr, 0);
          v.setUint32(ptr + 4, enc.encode(f.preopen).length, true);
        }),
        fd_prestat_dir_name: wrap((fd, ptr, len) => {
          let f = fdOf(fd);
          if (f.preopen == null) return E.BADF;
          let name = enc.encode(f.preopen);
          if (len < name.length) return E.NAMETOOLONG;
          bytes().set(name, ptr);
        }),
        fd_readdir: wrap((fd, buf, bufLen, cookie, usedPtr) => {
          let f = fdOf(fd);
          if (f.kind !== 'dir') return E.NOTDIR;
          let entries = [{ name: '.', kind: 'dir' }, { name: '..', kind: 'dir' }, ...call('readdir', { path: f.path })];
          let b = bytes();
          let v = view();
          let used = 0;
          for (let i = Number(cookie); i < entries.length; i++) {
            let e = entries[i];
            let name = enc.encode(e.name);
            let header = new Uint8Array(24);
            let hv = new DataView(header.buffer);
            hv.setBigUint64(0, BigInt(i + 1), true);
            hv.setBigUint64(8, BigInt(hashPath(P.normalize(P.join(f.path, e.name)))), true);
            hv.setUint32(16, name.length, true);
            hv.setUint8(20, FILETYPE[e.kind] ?? FILETYPE.unknown);
            let rec = new Uint8Array(24 + name.length);
            rec.set(header);
            rec.set(name, 24);
            let take = Math.min(rec.length, bufLen - used);
            b.set(rec.subarray(0, take), buf + used);
            used += take;
            if (used >= bufLen) break;
          }
          v.setUint32(usedPtr, used, true);
        }),
        fd_renumber: wrap((from, to) => {
          let f = fdOf(from);
          let old = fdOf(to);
          self._release(old);
          if (old.kind === 'file') sys.sync('unlock', { path: old.path });
          self.fds.set(to, f);
          self.fds.delete(from);
        }),
        fd_seek: wrap((fd, offset, whence, newPtr) => {
          let f = fdOf(fd);
          if (f.kind === 'stdio') return E.SPIPE;
          if (f.kind === 'dir') return E.BADF;
          let file = self._load(f);
          let base = whence === 0 ? 0 : whence === 1 ? f.pos : whence === 2 ? file.size : null;
          if (base == null) return E.INVAL;
          let next = base + Number(offset);
          if (next < 0) return E.INVAL;
          f.pos = next;
          view().setBigUint64(newPtr, BigInt(next), true);
        }),
        fd_tell: wrap((fd, ptr) => {
          let f = fdOf(fd);
          if (f.kind === 'stdio') return E.SPIPE;
          if (f.kind === 'dir') return E.BADF;
          view().setBigUint64(ptr, BigInt(f.pos || 0), true);
        }),
        path_create_directory: wrap((fd, pathPtr, len) => {
          let p = self._resolve(fd, str(pathPtr, len), false);
          call('mkdir', { path: p });
        }),
        path_filestat_get: wrap((fd, flags, pathPtr, len, ptr) => {
          let p = self._resolve(fd, str(pathPtr, len), !!(flags & 1));
          self._flushPath(p);
          let s = call('stat', { path: p, follow: !!(flags & 1) });
          writeFilestat(ptr, s, p, s.kind === 'symlink' ? 'L:' + p : p);
        }),
        path_filestat_set_times: wrap((fd, flags, pathPtr, len, _atim, mtim, fstflags) => {
          let follow = !!(flags & 1);
          let p = self._resolve(fd, str(pathPtr, len), follow);
          let s = tryStat(p, follow);
          if (!s) return E.NOENT;
          setTimes(s.kind === 'symlink' ? 'L:' + p : p, p, _atim, mtim, fstflags, follow);
        }),
        path_link: wrap((oldFd, _oldFlags, oldPtr, oldLen, newFd, newPtr, newLen) => {
          // Following symlinks for the source isn't supported by preview1 implementations (wasmtime: EINVAL).
          if (_oldFlags & 1) return E.INVAL;
          let oldRel = str(oldPtr, oldLen);
          let newRel = str(newPtr, newLen);
          let a = self._resolve(oldFd, oldRel, false);
          let b = self._resolve(newFd, newRel, false);
          let sa = tryStat(a, false);
          if (!sa) return E.NOENT;
          if (oldRel.endsWith('/')) return sa.kind === 'dir' ? E.PERM : E.NOTDIR;
          let sb = tryStat(b, false);
          if (sb) return E.EXIST;
          if (newRel.endsWith('/')) return E.NOENT;
          if (sa.kind === 'dir') return E.PERM;
          // linkat without AT_SYMLINK_FOLLOW links the symlink itself (even a dangling one).
          if (sa.kind === 'symlink') return void call('symlink', { target: call('readlink', { path: a }), path: b });
          self._flushPath(a);
          call('link', { existing: a, path: b });
        }),
        path_open: wrap((dirfd, dirflags, pathPtr, len, oflags, rightsBase, rightsInheriting, fdflags, fdPtr) => {
          let rel = str(pathPtr, len);
          let follow = !!(dirflags & 1);
          let base = fdOf(dirfd);
          if (base.kind === 'dir' && !(base.rights & RIGHT.PATH_OPEN)) return E.NOTCAPABLE;
          if (oflags & O.CREAT && !(base.rights & RIGHT.PATH_CREATE_FILE)) return E.NOTCAPABLE;
          if (oflags & O.TRUNC && !(base.rights & RIGHT.PATH_FILESTAT_SET_SIZE)) return E.NOTCAPABLE;
          let p = self._resolve(dirfd, rel, follow);
          let st = tryStat(p, follow);
          if (st?.kind === 'symlink') return oflags & O.DIRECTORY || rel.endsWith('/') ? E.NOTDIR : E.LOOP;
          if (st && oflags & O.CREAT && oflags & O.EXCL) return E.EXIST;
          if (!st) {
            if (!(oflags & O.CREAT)) return E.NOENT;
            if (oflags & O.DIRECTORY || rel.endsWith('/')) return E.INVAL;
            call('writeFile', { path: p, data: new Uint8Array(0), mode: 0o666, flag: 'wx' });
            st = { kind: 'file' };
          }
          if (oflags & O.DIRECTORY && st.kind !== 'dir') return E.NOTDIR;
          let wantsWrite = (rightsBase & RIGHT.FD_WRITE) !== 0n;
          let wantsRead = (rightsBase & RIGHT.FD_READ) !== 0n;
          if (st.kind === 'dir') {
            if (wantsWrite || oflags & O.TRUNC) return E.ISDIR;
            call('access', { path: p, mode: 4 });
          } else {
            if (rel.endsWith('/')) return E.NOTDIR;
            call('access', { path: p, mode: (wantsRead ? 4 : 0) | (wantsWrite || oflags & O.TRUNC ? 2 : 0) });
          }
          // Hold a lock while the fd is open: shared for read-only, exclusive for write.
          if (st.kind !== 'dir') call('lock', { path: p, write: wantsWrite || !!(oflags & O.TRUNC) });
          let allowed = base.inheriting ?? ALL_RIGHTS;
          // A directory fd is its own capability root: ".." can't climb above it.
          let f =
            st.kind === 'dir'
              ? { kind: 'dir', path: p, root: p, rights: rightsBase & DIR_RIGHTS & allowed, inheriting: rightsInheriting & allowed, flags: fdflags }
              : { kind: 'file', path: p, rights: rightsBase & FILE_RIGHTS & allowed, inheriting: rightsInheriting & allowed, flags: fdflags, pos: 0, file: null };
          if (f.kind === 'file' && oflags & O.TRUNC) {
            let file = self._load(f);
            file.size = 0;
            file.dirty = true;
            self._flushFile(file);
          }
          let fd = 3;
          while (self.fds.has(fd)) fd++;
          self.fds.set(fd, f);
          view().setUint32(fdPtr, fd, true);
        }),
        path_readlink: wrap((fd, pathPtr, len, buf, bufLen, usedPtr) => {
          let p = self._resolve(fd, str(pathPtr, len), false);
          let target = enc.encode(call('readlink', { path: p }));
          let n = Math.min(target.length, bufLen);
          bytes().set(target.subarray(0, n), buf);
          view().setUint32(usedPtr, n, true);
        }),
        path_remove_directory: wrap((fd, pathPtr, len) => {
          let p = self._resolve(fd, str(pathPtr, len), false);
          let st = tryStat(p, false);
          if (!st) return E.NOENT;
          if (st.kind !== 'dir') return E.NOTDIR;
          call('rm', { path: p, dirOnly: true, syscall: 'rmdir' });
        }),
        path_rename: wrap((fd, oldPtr, oldLen, newFd, newPtr, newLen) => {
          let a = self._resolve(fd, str(oldPtr, oldLen), false);
          let b = self._resolve(newFd, str(newPtr, newLen), false);
          self._flushPath(a);
          let sa = tryStat(a, false);
          let sb = tryStat(b, false);
          if (!sa) return E.NOENT;
          if (sb?.kind === 'dir' && sa.kind !== 'dir') return E.ISDIR;
          if (sb && sb.kind !== 'dir' && sa.kind === 'dir') return E.NOTDIR;
          if (sb?.kind === 'dir' && sa.kind === 'dir' && call('readdir', { path: b }).length) return E.NOTEMPTY;
          if (sb?.kind === 'dir') call('rm', { path: b, dirOnly: true, syscall: 'rmdir' });
          call('rename', { from: a, to: b });
          // Open fds follow the file to its new name.
          for (let [k, file] of [...self.open]) {
            if (k === a || k.startsWith(a + '/')) {
              self.open.delete(k);
              file.path = b + k.slice(a.length);
              self.open.set(file.path, file);
            }
          }
          for (let f of self.fds.values()) if (f.path && (f.path === a || f.path.startsWith(a + '/'))) f.path = b + f.path.slice(a.length);
        }),
        path_symlink: wrap((oldPtr, oldLen, fd, newPtr, newLen) => {
          let target = str(oldPtr, oldLen);
          if (target.startsWith('/')) return E.NOTCAPABLE;
          let newRel = str(newPtr, newLen);
          let p = self._resolve(fd, newRel.replace(/\/+$/, ''), false);
          let existing = tryStat(p, false);
          if (newRel.endsWith('/')) return !existing ? E.NOENT : existing.kind === 'dir' ? E.EXIST : E.NOTDIR;
          if (existing) return E.EXIST;
          call('symlink', { target, path: p });
        }),
        path_unlink_file: wrap((fd, pathPtr, len) => {
          let rel = str(pathPtr, len);
          let p = self._resolve(fd, rel, false);
          let st = tryStat(p, false);
          if (!st) return E.NOENT;
          if (st.kind === 'dir') return E.ISDIR;
          if (rel.endsWith('/')) return E.NOTDIR;
          // Still-open fds keep their data but must not recreate the file on flush.
          let open = self.open.get(p);
          if (open) {
            open.unlinked = true;
            self.open.delete(p);
          }
          call('rm', { path: p, fileOnly: true, syscall: 'unlink' });
        }),
        poll_oneoff: wrap((inPtr, outPtr, nsubs, neventsPtr) => {
          let v = view();
          let events = [];
          let wait = Infinity;
          let clocks = [];
          let ttyWaits = [];
          for (let i = 0; i < nsubs; i++) {
            let s = inPtr + i * 48;
            let userdata = v.getBigUint64(s, true);
            let tag = v.getUint8(s + 8);
            if (tag === 0) {
              let id = v.getUint32(s + 16, true);
              let timeout = v.getBigUint64(s + 24, true);
              let flags = v.getUint16(s + 40, true);
              let ms = Number(timeout) / 1e6;
              if (flags & 1) ms = id === 0 ? Number(timeout) / 1e6 - Date.now() : ms - performance.now();
              clocks.push({ userdata, ms: Math.max(0, ms) });
              wait = Math.min(wait, Math.max(0, ms));
            } else {
              let fd = v.getUint32(s + 16, true);
              let f = self.fds.get(fd);
              // Reading a terminal: ready only once there is input (checked below, with the timeout).
              if (tag === 1 && f?.kind === 'stdio' && f.stdio === 0 && ctx.tty?.stdin) ttyWaits.push({ userdata });
              else events.push({ userdata, error: f ? 0 : E.BADF, type: tag, nbytes: 1n });
            }
          }
          if (ttyWaits.length && !events.length) {
            let ready = sys.sync('ttyPoll', { timeout: wait === Infinity ? -1 : Math.max(0, Math.round(wait)) });
            if (ready) for (let t of ttyWaits) events.push({ userdata: t.userdata, error: 0, type: 1, nbytes: 1n });
            else for (let c of clocks) if (c.ms <= wait) events.push({ userdata: c.userdata, error: 0, type: 0, nbytes: 0n });
          } else if (ttyWaits.length) {
            if (sys.sync('ttyPoll', { timeout: 0 })) for (let t of ttyWaits) events.push({ userdata: t.userdata, error: 0, type: 1, nbytes: 1n });
          }
          if (!events.length && !ttyWaits.length && clocks.length) {
            sleep(wait);
            for (let c of clocks) if (c.ms <= wait) events.push({ userdata: c.userdata, error: 0, type: 0, nbytes: 0n });
          }
          events.forEach((e, i) => {
            let o = outPtr + i * 32;
            v.setBigUint64(o, e.userdata, true);
            v.setUint16(o + 8, e.error, true);
            v.setUint8(o + 10, e.type);
            v.setBigUint64(o + 16, e.nbytes, true);
            v.setUint16(o + 24, 0, true);
          });
          v.setUint32(neventsPtr, events.length, true);
        }),
        proc_exit: (code) => {
          throw new WASIExit(code >>> 0);
        },
        proc_raise: wrap(() => E.NOSYS),
        sched_yield: wrap(() => {}),
        random_get: wrap((buf, len) => {
          let b = bytes();
          // getRandomValues refuses shared memory: fill a private buffer and copy.
          for (let o = 0; o < len; o += 65536) b.set(crypto.getRandomValues(new Uint8Array(Math.min(65536, len - o))), buf + o);
        }),
        // No socket fds exist yet (fake network is planned): real fds aren't sockets.
        sock_accept: wrap((fd) => (self.fds.has(fd) ? E.NOTSOCK : E.BADF)),
        sock_recv: wrap((fd) => (self.fds.has(fd) ? E.NOTSOCK : E.BADF)),
        sock_send: wrap((fd) => (self.fds.has(fd) ? E.NOTSOCK : E.BADF)),
        sock_shutdown: wrap((fd) => (self.fds.has(fd) ? E.NOTSOCK : E.BADF)),
      };
    }
  }

  return { WASI };
}

/** Limits of a module's imported memory: { min, max, shared } in pages, or null. */
export function memoryImportLimits(bytes) {
  let b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let pos = 8;
  let leb = () => {
    let r = 0;
    let shift = 0;
    let x;
    do {
      x = b[pos++];
      r += (x & 0x7f) * 2 ** shift;
      shift += 7;
    } while (x & 0x80);
    return r;
  };
  let name = () => {
    let n = leb();
    pos += n;
  };
  let limits = () => {
    let flags = b[pos++];
    let min = leb();
    let max = flags & 1 ? leb() : null;
    return { min, max, shared: !!(flags & 2) };
  };
  while (pos < b.length) {
    let id = b[pos++];
    let size = leb();
    let end = pos + size;
    if (id !== 2) {
      pos = end;
      continue;
    }
    let count = leb();
    for (let i = 0; i < count; i++) {
      name();
      name();
      let kind = b[pos++];
      if (kind === 0) leb();
      else if (kind === 1) {
        pos++;
        limits();
      } else if (kind === 2) return limits();
      else if (kind === 3) pos += 2;
      else if (kind === 4) {
        pos++;
        leb();
      } else return null;
    }
    return null;
  }
  return null;
}

function hashPath(p) {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
