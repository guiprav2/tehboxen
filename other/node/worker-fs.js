/**
 * Node `fs` inside a node Worker, backed by syscalls to the page (host.js).
 *
 * Sync APIs block on the SharedArrayBuffer channel; callback and promise APIs
 * use non-blocking messages. Nothing is cached across calls except open file
 * descriptors (whose contents are buffered until close / fsync / exit).
 */
import { toError } from './channel.js';

let enc = new TextEncoder();
let dec = new TextDecoder();

let S_IFMT = 0o170000;
let S_IFREG = 0o100000;
let S_IFDIR = 0o040000;
let S_IFLNK = 0o120000;
let S_IFCHR = 0o020000;
let TYPE = { file: S_IFREG, dir: S_IFDIR, symlink: S_IFLNK, chr: S_IFCHR };

export let constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024,
  S_IFMT, S_IFREG, S_IFDIR, S_IFLNK, S_IFCHR,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
  UV_FS_O_FILEMAP: 0,
};

export class Stats {
  constructor(s, ino) {
    let mtime = s.mtime;
    Object.assign(this, {
      dev: 2049, ino, mode: (TYPE[s.kind] || S_IFREG) | s.mode, nlink: s.nlink, uid: s.uid, gid: s.gid, rdev: 0,
      size: s.size, blksize: 4096, blocks: Math.ceil(s.size / 512),
      atimeMs: mtime, mtimeMs: mtime, ctimeMs: mtime, birthtimeMs: mtime,
    });
    for (let k of ['atime', 'mtime', 'ctime', 'birthtime']) this[k] = new Date(mtime);
  }
  isFile() { return (this.mode & S_IFMT) === S_IFREG; }
  isDirectory() { return (this.mode & S_IFMT) === S_IFDIR; }
  isSymbolicLink() { return (this.mode & S_IFMT) === S_IFLNK; }
  isCharacterDevice() { return (this.mode & S_IFMT) === S_IFCHR; }
  isBlockDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

export class Dirent {
  constructor(name, parentPath, kind) {
    this.name = name;
    this.parentPath = parentPath;
    this.path = parentPath;
    this._k = kind;
  }
  isFile() { return this._k === 'file'; }
  isDirectory() { return this._k === 'dir'; }
  isSymbolicLink() { return this._k === 'symlink'; }
  isCharacterDevice() { return this._k === 'chr'; }
  isBlockDevice() { return false; }
  isFIFO() { return false; }
  isSocket() { return false; }
}

/**
 * @param {object} o
 * @param {{ sync: Function, async: Function }} o.sys
 * @param {() => string} o.cwd
 * @param {any} o.Buffer  @param {any} o.path  @param {any} o.events  @param {any} o.stream
 * @param {{ stdin: () => Uint8Array, stdout: (b: Uint8Array) => void, stderr: (b: Uint8Array) => void }} o.stdio
 * @param {() => () => void} o.keepAlive  ref the event loop (returns release)
 * @param {(path: string, fn: Function) => () => void} o.watch
 */
export function createWorkerFs(o) {
  let { sys, Buffer, path: P, stdio } = o;
  let inoSeq = 1;
  let inoByPath = new Map();

  function abs(p) {
    if (p instanceof URL) p = decodeURIComponent(p.pathname);
    else if (ArrayBuffer.isView(p)) p = dec.decode(p);
    if (typeof p !== 'string') throw Object.assign(new TypeError(`The "path" argument must be of type string or an instance of Buffer or URL. Received ${p === null ? 'null' : typeof p}`), { code: 'ERR_INVALID_ARG_TYPE' });
    return P.resolve(o.cwd(), p);
  }
  let encodingOf = (options) => (typeof options === 'string' ? options : options?.encoding);
  function out(bytes, options) {
    let buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let e = encodingOf(options);
    return e && e !== 'buffer' ? buf.toString(e) : buf;
  }
  function toBytes(data, options) {
    if (typeof data === 'string') {
      let e = encodingOf(options) || 'utf8';
      return e === 'utf8' || e === 'utf-8' ? data : new Uint8Array(Buffer.from(data, e));
    }
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
    throw Object.assign(new TypeError(`The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView. Received ${typeof data}`), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  function stats(s, p) {
    let ino = s.ino ?? inoByPath.get(p) ?? 100000 + inoSeq++;
    inoByPath.set(p, ino);
    return new Stats(s, ino);
  }
  let modeOf = (options, dflt) => (options && typeof options === 'object' && options.mode != null ? options.mode : typeof options === 'number' ? options : dflt);
  let stdBytes = (data) => (typeof data === 'string' ? enc.encode(data) : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength));

  /* ---------- fd table ---------- */
  let fds = new Map();
  let nextFd = 3;
  function parseFlags(flags = 'r') {
    if (typeof flags === 'number') {
      let acc = flags & 3;
      return { read: acc !== 1, write: acc !== 0, create: !!(flags & 64), excl: !!(flags & 128), trunc: !!(flags & 512), append: !!(flags & 1024) };
    }
    let f = String(flags);
    return { read: f.includes('r') || f.includes('+'), write: !f.startsWith('r') || f.includes('+'), create: /^[wa]/.test(f), excl: f.includes('x'), trunc: f.startsWith('w'), append: f.startsWith('a') };
  }
  function fdEntry(fd, syscall) {
    let e = fds.get(fd);
    if (!e) throw Object.assign(new Error(`EBADF: bad file descriptor, ${syscall}`), { code: 'EBADF', errno: -9, syscall });
    if (!e.data) e.data = new Uint8Array(sys.sync('readFile', { path: e.path }));
    return e;
  }
  function flushFd(e) {
    if (!e.dirty) return;
    sys.sync('writeFile', { path: e.path, data: e.data });
    e.dirty = false;
  }

  /* ---------- sync API ---------- */
  let api = {
    existsSync(p) {
      try {
        sys.sync('stat', { path: abs(p) });
        return true;
      } catch {
        return false;
      }
    },
    accessSync: (p, mode = 0) => void sys.sync('access', { path: abs(p), mode }),
    statSync(p, opts = {}) {
      if (typeof p === 'number') return api.fstatSync(p);
      let a = abs(p);
      try {
        return stats(sys.sync('stat', { path: a }), a);
      } catch (err) {
        if (opts.throwIfNoEntry === false && err.code === 'ENOENT') return undefined;
        throw err;
      }
    },
    lstatSync(p, opts = {}) {
      let a = abs(p);
      try {
        return stats(sys.sync('stat', { path: a, follow: false }), a);
      } catch (err) {
        if (opts.throwIfNoEntry === false && err.code === 'ENOENT') return undefined;
        throw err;
      }
    },
    readFileSync(p, options) {
      if (p === 0 || p === '/dev/stdin') return out(stdio.stdin(), options);
      if (typeof p === 'number') {
        let e = fdEntry(p, 'read');
        return out(e.data.slice(e.pos), options);
      }
      let a = abs(p);
      if (a === '/dev/stdin') return out(stdio.stdin(), options);
      return out(new Uint8Array(sys.sync('readFile', { path: a })), options);
    },
    writeFileSync(p, data, options) {
      if (p === 1 || p === '/dev/stdout') return stdio.stdout(stdBytes(data));
      if (p === 2 || p === '/dev/stderr') return stdio.stderr(stdBytes(data));
      if (typeof p === 'number') {
        let e = fdEntry(p, 'write');
        e.data = typeof data === 'string' ? enc.encode(data) : new Uint8Array(toBytes(data, options));
        e.dirty = true;
        return flushFd(e);
      }
      let flag = (typeof options === 'object' && options?.flag) || 'w';
      sys.sync('writeFile', { path: abs(p), data: toBytes(data, options), mode: modeOf(options, 0o666), flag });
    },
    appendFileSync(p, data, options) {
      if (typeof p === 'number') return api.writeSync(p, typeof data === 'string' ? data : Buffer.from(data));
      sys.sync('writeFile', { path: abs(p), data: toBytes(data, options), mode: modeOf(options, 0o666), flag: 'a' });
    },
    readdirSync(p, options) {
      let a = abs(p);
      let withTypes = typeof options === 'object' && options?.withFileTypes;
      let recursive = typeof options === 'object' && options?.recursive;
      let res = [];
      let walk = (dir, rel) => {
        for (let { name, kind } of sys.sync('readdir', { path: dir })) {
          let relName = rel ? rel + '/' + name : name;
          res.push(withTypes ? new Dirent(name, dir, kind) : relName);
          if (recursive && kind === 'dir') {
            try {
              walk(dir === '/' ? '/' + name : dir + '/' + name, relName);
            } catch (err) {
              if (err.code !== 'EACCES') throw err;
            }
          }
        }
      };
      walk(a, '');
      if (encodingOf(options) === 'buffer' && !withTypes) return res.map((n) => Buffer.from(n));
      return res;
    },
    mkdirSync(p, options) {
      let recursive = typeof options === 'object' && options?.recursive;
      let r = sys.sync('mkdir', { path: abs(p), recursive: !!recursive, mode: modeOf(options, 0o777) });
      return recursive ? r ?? undefined : undefined;
    },
    mkdtempSync(prefix) {
      for (let i = 0; i < 10; i++) {
        let a = abs(prefix + Math.random().toString(36).slice(2, 8));
        try {
          sys.sync('mkdir', { path: a, mode: 0o700 });
          return a;
        } catch (err) {
          if (err.code !== 'EEXIST') throw err;
        }
      }
      throw Object.assign(new Error('EEXIST: could not create unique temp dir'), { code: 'EEXIST' });
    },
    unlinkSync: (p) => void sys.sync('rm', { path: abs(p), fileOnly: true, syscall: 'unlink' }),
    rmdirSync: (p, options) => void sys.sync('rm', { path: abs(p), dirOnly: true, recursive: !!options?.recursive, syscall: 'rmdir' }),
    rmSync(p, options = {}) {
      let a = abs(p);
      if (!options.recursive) {
        let st = api.lstatSync(a, { throwIfNoEntry: false });
        if (!st) {
          if (options.force) return;
          throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${a}'`), { code: 'ENOENT', errno: -2, syscall: 'stat', path: a });
        }
        if (st.isDirectory()) throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${a}`), { code: 'ERR_FS_EISDIR', errno: 21, syscall: 'rm', path: a });
      }
      sys.sync('rm', { path: a, recursive: !!options.recursive, force: !!options.force });
    },
    renameSync: (a, b) => void sys.sync('rename', { from: abs(a), to: abs(b) }),
    copyFileSync(a, b, mode = 0) {
      let src = abs(a);
      let dst = abs(b);
      let data = new Uint8Array(sys.sync('readFile', { path: src }));
      sys.sync('writeFile', { path: dst, data, flag: mode & 1 ? 'wx' : 'w' });
    },
    cpSync(a, b, options = {}) {
      let src = abs(a);
      let dst = abs(b);
      let st = api.statSync(src);
      if (st.isDirectory()) {
        if (!options.recursive) throw Object.assign(new Error(`Recursive option is required to copy a directory: ${src}`), { code: 'ERR_FS_EISDIR' });
        if (!api.existsSync(dst)) api.mkdirSync(dst, { recursive: true });
        for (let name of api.readdirSync(src)) api.cpSync(P.join(src, name), P.join(dst, name), options);
        return;
      }
      if (options.force === false && api.existsSync(dst)) {
        if (options.errorOnExist) throw Object.assign(new Error(`EEXIST: file already exists, cp '${src}' -> '${dst}'`), { code: 'EEXIST' });
        return;
      }
      api.copyFileSync(src, dst);
    },
    chmodSync: (p, mode) => void sys.sync('chmod', { path: abs(p), mode: typeof mode === 'string' ? parseInt(mode, 8) : Number(mode) }),
    chownSync: (p, uid, gid) => void sys.sync('chown', { path: abs(p), uid, gid }),
    utimesSync: (p, atime, mtime) => void sys.sync('utimes', { path: abs(p), mtime: mtime instanceof Date ? mtime.getTime() : Number(mtime) * 1000 }),
    truncateSync(p, len = 0) {
      let data = new Uint8Array(sys.sync('readFile', { path: abs(p) }));
      let next = new Uint8Array(len);
      next.set(data.subarray(0, Math.min(len, data.length)));
      sys.sync('writeFile', { path: abs(p), data: next });
    },
    realpathSync: (p) => sys.sync('realpath', { path: abs(p) }),
    readlinkSync: (p) => sys.sync('readlink', { path: abs(p) }),
    symlinkSync: (target, p) => void sys.sync('symlink', { target: String(target), path: abs(p) }),
    linkSync: (a, b) => void sys.sync('link', { existing: abs(a), path: abs(b) }),

    openSync(p, flags = 'r', mode = 0o666) {
      let a = abs(p);
      let f = parseFlags(flags);
      let st = api.statSync(a, { throwIfNoEntry: false });
      if (!st) {
        if (!f.create) sys.sync('stat', { path: a });
        sys.sync('writeFile', { path: a, data: '', mode, flag: f.excl ? 'wx' : 'w' });
      } else {
        if (f.excl && f.create) throw Object.assign(new Error(`EEXIST: file already exists, open '${a}'`), { code: 'EEXIST', errno: -17, syscall: 'open', path: a });
        if (st.isDirectory() && f.write) throw Object.assign(new Error(`EISDIR: illegal operation on a directory, open '${a}'`), { code: 'EISDIR', errno: -21, syscall: 'open', path: a });
        sys.sync('access', { path: a, mode: (f.read ? 4 : 0) | (f.write ? 2 : 0) });
        if (f.trunc && f.write) sys.sync('writeFile', { path: a, data: '' });
      }
      // Held until closeSync (or process exit): shared for read-only, exclusive for write.
      sys.sync('lock', { path: a, write: !!f.write });
      let fd = nextFd++;
      fds.set(fd, { path: a, flags: f, pos: 0, data: null, dirty: false });
      if (f.append) {
        let e = fdEntry(fd, 'open');
        e.pos = e.data.length;
      }
      return fd;
    },
    closeSync(fd) {
      if (fd <= 2) return;
      let e = fds.get(fd);
      if (!e) throw Object.assign(new Error('EBADF: bad file descriptor, close'), { code: 'EBADF', errno: -9, syscall: 'close' });
      flushFd(e);
      fds.delete(fd);
      sys.sync('unlock', { path: e.path });
    },
    fstatSync(fd) {
      if (fd <= 2) return stats({ kind: 'chr', mode: 0o620, uid: 0, gid: 0, mtime: Date.now(), nlink: 1, size: 0 }, '/dev/fd' + fd);
      let e = fdEntry(fd, 'fstat');
      let s = stats(sys.sync('stat', { path: e.path }), e.path);
      s.size = e.data.length;
      return s;
    },
    readSync(fd, buffer, offsetOrOpts, length, position) {
      let offset = 0;
      if (typeof offsetOrOpts === 'object' && offsetOrOpts) ({ offset = 0, length = buffer.byteLength - offset, position = null } = offsetOrOpts);
      else offset = offsetOrOpts ?? 0;
      length ??= buffer.byteLength - offset;
      let e = fd === 0 ? (fds.get(0) ?? (fds.set(0, { path: '/dev/stdin', flags: {}, pos: 0, data: stdio.stdin() }), fds.get(0))) : fdEntry(fd, 'read');
      let start = position != null && position >= 0 ? Number(position) : e.pos;
      let chunk = e.data.subarray(start, start + length);
      new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength).set(chunk, offset);
      if (position == null || position < 0) e.pos = start + chunk.length;
      return chunk.length;
    },
    writeSync(fd, data, a, b, c) {
      let bytes;
      let position = null;
      if (typeof data === 'string') {
        bytes = enc.encode(data);
        position = a ?? null;
      } else {
        let offset = a ?? 0;
        let length = b ?? data.byteLength - offset;
        position = c ?? null;
        bytes = new Uint8Array(data.buffer, data.byteOffset + offset, length);
      }
      if (fd === 1) return stdio.stdout(bytes), bytes.length;
      if (fd === 2) return stdio.stderr(bytes), bytes.length;
      let e = fdEntry(fd, 'write');
      let at = position != null ? Number(position) : e.flags.append ? e.data.length : e.pos;
      let grown = new Uint8Array(Math.max(e.data.length, at + bytes.length));
      grown.set(e.data);
      grown.set(bytes, at);
      e.data = grown;
      e.dirty = true;
      if (position == null) e.pos = at + bytes.length;
      return bytes.length;
    },
    fsyncSync: (fd) => fds.has(fd) && flushFd(fds.get(fd)),
    fdatasyncSync: (fd) => fds.has(fd) && flushFd(fds.get(fd)),
    ftruncateSync(fd, len = 0) {
      let e = fdEntry(fd, 'ftruncate');
      let next = new Uint8Array(len);
      next.set(e.data.subarray(0, Math.min(len, e.data.length)));
      e.data = next;
      e.dirty = true;
    },
    opendirSync(p) {
      let a = abs(p);
      let entries = api.readdirSync(a, { withFileTypes: true });
      let i = 0;
      return {
        path: a,
        readSync: () => entries[i++] || null,
        read: async () => entries[i++] || null,
        closeSync() {},
        close: async () => {},
        async *[Symbol.asyncIterator]() {
          for (let e of entries) yield e;
        },
      };
    },
  };
  api.realpathSync.native = api.realpathSync;
  api.lchownSync = api.chownSync;
  api.lutimesSync = api.utimesSync;

  /* ---------- promises: non-blocking syscalls ---------- */
  let A = (op, args) => sys.async(op, args);
  let promises = {
    access: async (p, mode = 0) => void (await A('access', { path: abs(p), mode })),
    stat: async (p, opts = {}) => {
      let a = abs(p);
      try {
        return stats(await A('stat', { path: a }), a);
      } catch (err) {
        if (opts.throwIfNoEntry === false && err.code === 'ENOENT') return undefined;
        throw err;
      }
    },
    lstat: async (p) => stats(await A('stat', { path: abs(p), follow: false }), abs(p)),
    readFile: async (p, options) => {
      if (typeof p === 'object' && p?.fd != null) return p.readFile(options);
      return out(new Uint8Array(await A('readFile', { path: abs(p) })), options);
    },
    writeFile: async (p, data, options) => {
      if (typeof p === 'object' && p?.fd != null) return p.writeFile(data, options);
      if (data && typeof data[Symbol.asyncIterator] === 'function' && typeof data !== 'string') {
        let chunks = [];
        for await (let c of data) chunks.push(typeof c === 'string' ? Buffer.from(c) : Buffer.from(c));
        data = Buffer.concat(chunks);
      }
      await A('writeFile', { path: abs(p), data: toBytes(data, options), mode: modeOf(options, 0o666), flag: (typeof options === 'object' && options?.flag) || 'w' });
    },
    appendFile: async (p, data, options) => void (await A('writeFile', { path: abs(p), data: toBytes(data, options), mode: modeOf(options, 0o666), flag: 'a' })),
    readdir: async (p, options) => {
      let a = abs(p);
      let withTypes = typeof options === 'object' && options?.withFileTypes;
      let recursive = typeof options === 'object' && options?.recursive;
      let res = [];
      let walk = async (dir, rel) => {
        for (let { name, kind } of await A('readdir', { path: dir })) {
          let relName = rel ? rel + '/' + name : name;
          res.push(withTypes ? new Dirent(name, dir, kind) : relName);
          if (recursive && kind === 'dir') await walk(dir === '/' ? '/' + name : dir + '/' + name, relName).catch((err) => { if (err.code !== 'EACCES') throw err; });
        }
      };
      await walk(a, '');
      return res;
    },
    mkdir: async (p, options) => {
      let recursive = typeof options === 'object' && options?.recursive;
      let r = await A('mkdir', { path: abs(p), recursive: !!recursive, mode: modeOf(options, 0o777) });
      return recursive ? r ?? undefined : undefined;
    },
    mkdtemp: async (prefix) => api.mkdtempSync(prefix),
    unlink: async (p) => void (await A('rm', { path: abs(p), fileOnly: true, syscall: 'unlink' })),
    rmdir: async (p, options) => void (await A('rm', { path: abs(p), dirOnly: true, recursive: !!options?.recursive, syscall: 'rmdir' })),
    rm: async (p, options = {}) => {
      if (!options.recursive) {
        let st = await promises.lstat(p).catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
        if (!st) {
          if (options.force) return;
          throw Object.assign(new Error(`ENOENT: no such file or directory, stat '${abs(p)}'`), { code: 'ENOENT', errno: -2, syscall: 'stat', path: abs(p) });
        }
        if (st.isDirectory()) throw Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${abs(p)}`), { code: 'ERR_FS_EISDIR', errno: 21, syscall: 'rm', path: abs(p) });
      }
      await A('rm', { path: abs(p), recursive: !!options.recursive, force: !!options.force });
    },
    rename: async (a, b) => void (await A('rename', { from: abs(a), to: abs(b) })),
    copyFile: async (a, b, mode = 0) => {
      let data = new Uint8Array(await A('readFile', { path: abs(a) }));
      await A('writeFile', { path: abs(b), data, flag: mode & 1 ? 'wx' : 'w' });
    },
    cp: async (a, b, options = {}) => api.cpSync(a, b, options),
    chmod: async (p, mode) => void (await A('chmod', { path: abs(p), mode: typeof mode === 'string' ? parseInt(mode, 8) : Number(mode) })),
    chown: async (p, uid, gid) => void (await A('chown', { path: abs(p), uid, gid })),
    utimes: async (p, at, mt) => void (await A('utimes', { path: abs(p), mtime: mt instanceof Date ? mt.getTime() : Number(mt) * 1000 })),
    truncate: async (p, len) => api.truncateSync(p, len),
    realpath: async (p) => A('realpath', { path: abs(p) }),
    readlink: async (p) => A('readlink', { path: abs(p) }),
    symlink: async (t, p) => void (await A('symlink', { target: String(t), path: abs(p) })),
    link: async (a, b) => void (await A('link', { existing: abs(a), path: abs(b) })),
    opendir: async (p) => api.opendirSync(p),
    constants,
  };
  promises.lchown = promises.chown;
  promises.lutimes = promises.utimes;
  promises.open = async (p, flags, mode) => {
    let fd = api.openSync(p, flags, mode);
    return {
      fd,
      readFile: async (opts) => api.readFileSync(fd, opts),
      writeFile: async (d, opts) => api.writeFileSync(fd, d, opts),
      appendFile: async (d) => void api.writeSync(fd, typeof d === 'string' ? d : Buffer.from(d)),
      read: async (buffer, offset, length, position) => {
        buffer ??= Buffer.alloc(16384);
        let bytesRead = api.readSync(fd, buffer, offset ?? 0, length ?? buffer.byteLength - (offset ?? 0), position ?? null);
        return { bytesRead, buffer };
      },
      write: async (data, ...rest) => ({ bytesWritten: api.writeSync(fd, data, ...rest), buffer: data }),
      stat: async () => api.fstatSync(fd),
      truncate: async (len) => api.ftruncateSync(fd, len),
      sync: async () => api.fsyncSync(fd),
      datasync: async () => api.fsyncSync(fd),
      close: async () => api.closeSync(fd),
      async *readLines() {
        let lines = String(api.readFileSync(fd, 'utf8')).split('\n');
        if (lines.at(-1) === '') lines.pop();
        for (let l of lines) yield l.replace(/\r$/, '');
      },
      [Symbol.asyncDispose]: async () => api.closeSync(fd),
    };
  };

  /* ---------- callback API (on top of promises; sync-only ops wrap the sync call) ---------- */
  let cbApi = {};
  let syncNames = Object.keys(api).filter((k) => k.endsWith('Sync'));
  for (let name of syncNames) {
    let base = name.slice(0, -4);
    let p = promises[base];
    let fn = api[name];
    cbApi[base] = (...args) => {
      let cb = args.pop();
      if (typeof cb !== 'function') throw Object.assign(new TypeError('The "cb" argument must be of type function. Received ' + typeof cb), { code: 'ERR_INVALID_ARG_TYPE' });
      let release = o.keepAlive();
      let run = p && typeof args[0] !== 'number' ? p(...args) : Promise.resolve().then(() => fn(...args));
      run.then((v) => (release(), cb(null, v)), (err) => (release(), cb(err)));
    };
  }
  cbApi.exists = (p, cb) => {
    let release = o.keepAlive();
    promises.access(p).then(() => (release(), cb(true)), () => (release(), cb(false)));
  };
  cbApi.read = (fd, buffer, offset, length, position, cb) => {
    if (typeof offset === 'function') ((cb = offset), (offset = 0));
    queueMicrotask(() => {
      try {
        cb(null, api.readSync(fd, buffer, offset, length, position), buffer);
      } catch (err) {
        cb(err);
      }
    });
  };
  cbApi.write = (fd, data, ...rest) => {
    let cb = rest.pop();
    queueMicrotask(() => {
      try {
        cb(null, api.writeSync(fd, data, ...rest), data);
      } catch (err) {
        cb(err);
      }
    });
  };
  promises.exists = undefined;
  delete promises.exists;

  /* ---------- watch ---------- */
  cbApi.watch = (p, options, listener) => {
    if (typeof options === 'function') ((listener = options), (options = {}));
    let em = new o.events.EventEmitter();
    if (listener) em.on('change', listener);
    let release = o.keepAlive();
    let off = o.watch(abs(p), (eventType, filename) => em.emit('change', eventType, filename));
    em.close = () => {
      off();
      release();
      em.emit('close');
    };
    em.ref = () => em;
    em.unref = () => (release(), em);
    return em;
  };
  promises.watch = async function* (p, options = {}) {
    let buf = [];
    let wake;
    let w = cbApi.watch(p, options, (eventType, filename) => {
      buf.push({ eventType, filename });
      wake?.();
    });
    options.signal?.addEventListener('abort', () => (w.close(), wake?.()));
    try {
      while (!options.signal?.aborted) {
        if (!buf.length) await new Promise((r) => (wake = r));
        while (buf.length) yield buf.shift();
      }
    } finally {
      w.close();
    }
  };
  cbApi.watchFile = () => {
    throw Object.assign(new Error('ENOSYS: fs.watchFile is not simulated (use fs.watch)'), { code: 'ENOSYS' });
  };
  cbApi.unwatchFile = () => {};

  /* ---------- streams ---------- */
  cbApi.createReadStream = (p, options = {}) => {
    if (typeof options === 'string') options = { encoding: options };
    let started = false;
    let release = null;
    let stream = new o.stream.Readable({
      highWaterMark: options.highWaterMark ?? 65536,
      encoding: options.encoding,
      read() {
        if (started) return;
        started = true;
        release = o.keepAlive();
        let load = options.fd != null ? Promise.resolve(api.readFileSync(options.fd)) : promises.readFile(p);
        load.then(
          (data) => {
            let start = options.start ?? 0;
            let end = options.end != null ? options.end + 1 : data.length;
            let slice = data.subarray(start, end);
            let hw = this.readableHighWaterMark;
            for (let i = 0; i < slice.length; i += hw) this.push(slice.subarray(i, i + hw));
            this.push(null);
            release();
          },
          (err) => {
            release();
            this.destroy(err);
          },
        );
      },
    });
    stream.path = typeof p === 'string' ? p : undefined;
    queueMicrotask(() => stream.emit('open', -1));
    return stream;
  };
  cbApi.createWriteStream = (p, options = {}) => {
    if (typeof options === 'string') options = { encoding: options };
    let flags = options.flags || 'w';
    let first = true;
    let stream = new o.stream.Writable({
      decodeStrings: false,
      write(chunk, encoding, cb) {
        let data = typeof chunk === 'string' ? Buffer.from(chunk, encoding) : chunk;
        let op = first && !flags.startsWith('a') ? promises.writeFile(p, data) : promises.appendFile(p, data);
        first = false;
        op.then(() => {
          stream.bytesWritten += data.length;
          cb();
        }, cb);
      },
      final(cb) {
        if (first && !flags.startsWith('a')) return promises.writeFile(p, '').then(() => cb(), cb);
        cb();
      },
    });
    stream.bytesWritten = 0;
    stream.path = p;
    queueMicrotask(() => stream.emit('open', -1));
    return stream;
  };

  let fs = Object.assign(cbApi, api, {
    constants,
    Stats,
    Dirent,
    F_OK: 0,
    R_OK: 4,
    W_OK: 2,
    X_OK: 1,
    promises,
  });
  return {
    fs,
    promises,
    /** Flush open fds (process exit). */
    flushAll() {
      for (let e of fds.values()) {
        try {
          flushFd(e);
        } catch {}
      }
    },
    /** Bundler host: probes against the same syscalls, with a per-bundle cache. */
    bundlerHost({ cache = true } = {}) {
      let statsCache = new Map();
      let stat = (p) => {
        if (cache && statsCache.has(p)) return statsCache.get(p);
        let st = null;
        try {
          st = sys.sync('stat', { path: p });
        } catch {}
        statsCache.set(p, st);
        return st;
      };
      let kind = (p) => stat(p)?.kind ?? null;
      return {
        fileId: (p) => {
          let st = stat(p);
          return st ? `${st.size}:${st.mtime}` : null;
        },
        isFile: (p) => kind(p) === 'file',
        isDir: (p) => kind(p) === 'dir',
        realpath: (p) => sys.sync('realpath', { path: p }),
        readTextSync: (p) => dec.decode(new Uint8Array(sys.sync('readFile', { path: p }))),
        readText: async (p) => dec.decode(new Uint8Array(await A('readFile', { path: p }))),
      };
    },
  };
}
