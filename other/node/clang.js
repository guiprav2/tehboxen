/**
 * Clang/LLD (YoWASP build, LLVM 22) inside a node worker, on the Tehboxen VFS.
 *
 * YoWASP ships LLVM as a WASI Preview 2 component that jco split into core
 * modules plus a JS adapter (gen/bundle.js). We load that adapter straight
 * from jsDelivr, keep its CLI/clock/random/stdio pieces and replace its
 * in-memory filesystem with VFS-backed descriptors on the blocking syscall
 * channel (permissions and locks included). The 74 MB core module and the
 * 30 MB resource tarball (headers, wasi-libc, builtins) come from the CDN and
 * the browser's HTTP cache, never from npm or the VFS.
 *
 * Guest paths: "/usr" is the read-only resource tree; everything else is the
 * VFS, resolved against the shell's cwd when the first path segment exists
 * there (or doesn't exist anywhere), else against the VFS root. So
 * `clang hello.c -o hello` and absolute paths like /home/… both work, and
 * clang's temporaries land in the real /tmp.
 */
let VERSION = '22.0.0-git20695-13';
let CDN = `https://cdn.jsdelivr.net/npm/@yowasp/clang@${VERSION}/gen/`;

let ERRORS = {
  ENOENT: 'no-entry', EACCES: 'access', EEXIST: 'exist', ENOTDIR: 'not-directory', EISDIR: 'is-directory',
  ENOTEMPTY: 'not-empty', EBUSY: 'busy', EPERM: 'not-permitted', EINVAL: 'invalid', ELOOP: 'loop', EXDEV: 'cross-device',
};
let KIND = { file: 'regular-file', dir: 'directory', symlink: 'symbolic-link', chr: 'character-device' };

let libPromise = null;
/** The YoWASP adapter, patched to export its internals and to load assets from the CDN. */
function loadYowasp() {
  libPromise ??= (async () => {
    let res = await fetch(CDN + 'bundle.js');
    if (!res.ok) throw new Error(`fetching ${CDN}bundle.js: ${res.status}`);
    let src = (await res.text()).replaceAll('import.meta.url', JSON.stringify(CDN));
    src += '\nexport { Environment, instantiate, llvm_resources_exports as tehboxenResources, Exit as TehboxenExit };\n';
    return import(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
  })();
  libPromise.catch(() => (libPromise = null));
  return libPromise;
}

let assetsPromise = null;
/**
 * Compiled core modules + the resource filesystem tree. `cached` (from the
 * page: compiled WebAssembly.Modules and the tarball bytes from an earlier
 * run) skips the download and the 74 MB compile.
 */
function loadAssets(progress, cached, onCacheable) {
  assetsPromise ??= (async () => {
    let lib = await loadYowasp();
    let r = lib.tehboxenResources;
    if (cached?.modules && cached?.tar) {
      let filesystem = await r.filesystem(() => Promise.resolve(new Response(cached.tar.slice(0))));
      return { lib, modules: cached.modules, usr: filesystem.usr };
    }
    let done = 0;
    let fetchFn = (input, init) =>
      fetch(input, init).then((response) => {
        if (!progress || !response.body) return response;
        return new Response(
          response.body.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                controller.enqueue(chunk);
                done += chunk.length;
                progress(done, r.totalSize);
              },
            }),
          ),
          response,
        );
      });
    let tar = null;
    let fetchTar = (input, init) =>
      fetchFn(input, init)
        .then((res) => res.arrayBuffer())
        .then((buf) => {
          tar = buf.slice(0);
          return new Response(buf);
        });
    let [modules, filesystem] = await Promise.all([r.modules(fetchFn), r.filesystem(fetchTar)]);
    onCacheable?.({ modules, tar });
    return { lib, modules, usr: filesystem.usr };
  })();
  assetsPromise.catch(() => (assetsPromise = null));
  return assetsPromise;
}

/**
 * Extra sysroots, fetched on first use and mounted read-only under guest /opt
 * (YoWASP's own sysroot has neither C++ exceptions nor threads):
 * - eh: Holepunch's wasi-sdk-style wasm32-wasip1 sysroot (libc++ 23 with eh/
 *   libc++, libc++abi, libunwind), the npm tarball (one CORS request).
 * - threads: wasi-sdk 34's wasm32-wasip1-threads part (wasi-libc with pthreads,
 *   eh/ and noeh/ C++ runtimes) plus its threads compiler-rt builtins,
 *   repackaged into toolchain/ by us because GitHub release assets have no CORS.
 * Both tarballs keep everything under a leading "package/" directory.
 */
let SYSROOTS = {
  eh: { url: 'https://registry.npmjs.org/wasi-sysroot-wasm32-wasip1/-/wasi-sysroot-wasm32-wasip1-0.1.1.tgz', dir: 'wasi-sysroot', what: 'the exception-enabled C++ sysroot' },
  threads: { url: new URL('../../toolchain/wasi-threads-sysroot-34.tgz', import.meta.url).href, dir: 'wasi-threads', what: 'the threads sysroot' },
};
let sysrootPromises = {};

/**
 * libtehboxen (toolchain/libtehboxen): system()/popen()/pclose() over the
 * `tehboxen.system` import, plus the declarations and <sys/wait.h> wasi-libc
 * lacks. Mounted at guest /usr/tehboxen; every compile force-includes
 * compat.h and every link adds -ltehboxen (archive: only pulled in when used).
 */
let libTehboxenPromise = null;
function loadLibTehboxen() {
  libTehboxenPromise ??= (async () => {
    let base = new URL('../../toolchain/libtehboxen/', import.meta.url);
    let get = async (p) => {
      let res = await fetch(new URL(p, base));
      if (!res.ok) throw new Error(`${p}: ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    };
    let [compat, wait, termios, pwd, grp, lib, libThreads] = await Promise.all(['compat.h', 'include/sys/wait.h', 'include/termios.h', 'include/pwd.h', 'include/grp.h', 'lib/wasm32-wasip1/libtehboxen.a', 'lib/wasm32-wasip1-threads/libtehboxen.a'].map(get));
    return {
      'compat.h': compat,
      include: { sys: { 'wait.h': wait }, 'termios.h': termios, 'pwd.h': pwd, 'grp.h': grp },
      lib: { 'wasm32-wasip1': { 'libtehboxen.a': lib }, 'wasm32-wasip1-threads': { 'libtehboxen.a': libThreads } },
    };
  })();
  // Without it the toolchain still works, just without system()/popen().
  return libTehboxenPromise.catch(() => null);
}
function untarTree(bytes) {
  let root = {};
  let dec = new TextDecoder();
  let str = (b, off, len) => {
    let end = off;
    while (end < off + len && b[end] !== 0) end++;
    return dec.decode(b.subarray(off, end));
  };
  let off = 0;
  let longName = null;
  let paxPath = null;
  while (off + 512 <= bytes.length) {
    let h = bytes.subarray(off, off + 512);
    if (h.every((x) => x === 0)) break;
    let name = str(h, 0, 100);
    let size = parseInt(str(h, 124, 12).trim() || '0', 8);
    let type = String.fromCharCode(h[156] || 48);
    if (str(h, 257, 6).startsWith('ustar')) {
      let prefix = str(h, 345, 155);
      if (prefix) name = prefix + '/' + name;
    }
    let data = bytes.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = str(data, 0, data.length);
      continue;
    }
    if (type === 'x') {
      let m = /\d+ path=([^\n]*)\n/.exec(dec.decode(data));
      paxPath = m ? m[1] : null;
      continue;
    }
    let full = paxPath || longName || name;
    paxPath = longName = null;
    if (type !== '0' && type !== '\0' && type !== '5') continue;
    let parts = full.split('/').filter(Boolean).slice(1); // drop "package/"
    if (!parts.length) continue;
    let dir = root;
    for (let p of parts.slice(0, type === '5' ? parts.length : -1)) dir = dir[p] ??= {};
    if (type !== '5') dir[parts[parts.length - 1]] = data.slice();
  }
  return root;
}
function loadSysroot(key, cachedTgz, onCacheable) {
  let def = SYSROOTS[key];
  sysrootPromises[key] ??= (async () => {
    let tgz = cachedTgz;
    if (!tgz) {
      let res = await fetch(def.url);
      if (!res.ok) throw new Error(`fetching ${def.what}: ${res.status}`);
      tgz = await res.arrayBuffer();
      onCacheable?.(key, tgz.slice(0));
    }
    let tar = new Uint8Array(await new Response(new Blob([tgz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return untarTree(tar);
  })();
  sysrootPromises[key].catch(() => delete sysrootPromises[key]);
  return sysrootPromises[key];
}

function hashPath(p) {
  let h = 0x811c9dc5;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Build the wasi:filesystem implementation for one tool run.
 * @param {{ sys, path, cwd: string, usr: object, io: { InputStream, OutputStream } }} o
 */
function createFs(o) {
  let { sys, path: P, io } = o;
  let files = new Map(); // VFS path → { data, size, dirty, refs }
  let live = new Set(); // open descriptors (flushed and unlocked when the run ends)
  let fail = (err) => {
    throw ERRORS[err?.code] || 'io';
  };
  let call = (op, args) => {
    try {
      return sys.sync(op, args);
    } catch (err) {
      fail(err);
    }
  };
  let tryStat = (p, follow = true) => {
    try {
      return sys.sync('stat', { path: p, follow });
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      fail(err);
    }
  };
  let flush = (f) => {
    if (!f?.dirty) return;
    call('writeFile', { path: f.path, data: f.data.subarray(0, f.size) });
    f.dirty = false;
  };
  let flushPath = (p) => flush(files.get(p));
  let openFile = (p) => {
    let f = files.get(p);
    if (!f) {
      let data = new Uint8Array(call('readFile', { path: p }));
      f = { path: p, data, size: data.length, dirty: false, refs: 0, locked: 0 };
      files.set(p, f);
    }
    return f;
  };
  let ensure = (f, need) => {
    if (f.data.length >= need) return;
    let grown = new Uint8Array(Math.max(need, f.data.length * 2, 65536));
    grown.set(f.data.subarray(0, f.size));
    f.data = grown;
  };
  let writeAt = (f, bytes, at) => {
    ensure(f, at + bytes.length);
    if (at > f.size) f.data.fill(0, f.size, at);
    f.data.set(bytes, at);
    f.size = Math.max(f.size, at + bytes.length);
    f.dirty = true;
  };

  /* read-only resource trees: /usr (YoWASP) and the extra sysroot in use under /opt */
  let mounts = [{ at: ['usr'], tree: o.usr }];
  if (o.sysroot) mounts.push({ at: ['opt', o.sysroot.dir], tree: o.sysroot.tree });
  let resLookup = (segs, tree = o.usr) => {
    let node = tree;
    for (let s of segs) {
      if (node instanceof Uint8Array || node == null || !Object.hasOwn(node, s)) return undefined;
      node = node[s];
    }
    return node;
  };

  /** Normalize a guest path relative to a base (array of segments), refusing to climb above the base. */
  let segments = (path) => {
    let out = [];
    for (let s of String(path).split('/')) {
      if (s === '' || s === '.') continue;
      if (s === '..') {
        if (!out.length) throw 'not-permitted';
        out.pop();
      } else out.push(s);
    }
    return out;
  };

  /** Resolve a path under the guest root view to a node. */
  let resolveRoot = (path) => {
    let segs = segments(path);
    for (let m of mounts) {
      if (m.at.every((x, i) => segs[i] === x)) {
        let rest = segs.slice(m.at.length);
        return { t: 'res', tree: m.tree, base: m.at, segs: rest, node: resLookup(rest, m.tree) };
      }
    }
    if (segs.length === 1 && segs[0] === 'opt' && o.sysroot) {
      let tree = { [o.sysroot.dir]: o.sysroot.tree };
      return { t: 'res', tree, base: ['opt'], segs: [], node: tree };
    }
    if (!segs.length) return { t: 'root' };
    let fromCwd = P.join(o.cwd, ...segs);
    let fromRoot = '/' + segs.join('/');
    if (tryStat(P.join(o.cwd, segs[0]), false) || !tryStat('/' + segs[0], false)) return { t: 'vfs', abs: fromCwd };
    return { t: 'vfs', abs: fromRoot };
  };

  let resolveAt = (node, path) => {
    if (node.t === 'root') return resolveRoot(path);
    if (node.t === 'res') {
      let segs = [...node.segs, ...segments(path)];
      return { ...node, segs, node: resLookup(segs, node.tree) };
    }
    if (String(path).startsWith('/')) throw 'not-permitted';
    let abs = P.normalize(P.join(node.abs, path));
    if (abs !== node.abs && !abs.startsWith(node.abs.endsWith('/') ? node.abs : node.abs + '/')) throw 'not-permitted';
    return { t: 'vfs', abs };
  };

  let statNode = (n, follow = true) => {
    if (n.t === 'root') return { type: 'directory', linkCount: 1n, size: 4096n, dataAccessTimestamp: null, dataModificationTimestamp: null, statusChangeTimestamp: null };
    if (n.t === 'res') {
      if (n.node === undefined) throw 'no-entry';
      let isFile = n.node instanceof Uint8Array;
      return { type: isFile ? 'regular-file' : 'directory', linkCount: 1n, size: BigInt(isFile ? n.node.length : 4096), dataAccessTimestamp: null, dataModificationTimestamp: null, statusChangeTimestamp: null };
    }
    let s = tryStat(n.abs, follow);
    if (!s) throw 'no-entry';
    let open = files.get(n.abs);
    let ms = Number(s.mtime) || Date.now();
    let ts = { seconds: BigInt(Math.floor(ms / 1000)), nanoseconds: (ms % 1000) * 1e6 };
    return { type: KIND[s.kind] || 'unknown', linkCount: BigInt(s.nlink || 1), size: BigInt(s.kind === 'file' && open ? open.size : s.size || 0), dataAccessTimestamp: ts, dataModificationTimestamp: ts, statusChangeTimestamp: ts };
  };

  class ReadStream extends io.InputStream {
    constructor(desc, offset) {
      super();
      this.desc = desc;
      this.offset = Number(offset);
    }
    read(len) {
      let { data, size } = this.desc.content();
      if (this.offset >= size) throw { tag: 'closed' };
      let chunk = data.slice(this.offset, Math.min(size, this.offset + Number(len)));
      this.offset += chunk.length;
      return chunk;
    }
    blockingRead(len) {
      return this.read(len);
    }
  }

  class WriteStream extends io.OutputStream {
    constructor(desc, offset, append = false) {
      super();
      this.desc = desc;
      this.offset = Number(offset);
      this.append = append;
    }
    checkWrite() {
      return 1n << 20n;
    }
    write(contents) {
      let f = this.desc.file();
      let at = this.append ? f.size : this.offset;
      writeAt(f, contents, at);
      this.offset = at + contents.length;
    }
    blockingWriteAndFlush(contents) {
      this.write(contents);
    }
    flush() {}
    blockingFlush() {}
  }

  class DirectoryEntryStream {
    constructor(entries) {
      this.entries = entries;
      this.i = 0;
    }
    readDirectoryEntry() {
      if (this.i >= this.entries.length) return null;
      return this.entries[this.i++];
    }
  }

  class Descriptor {
    constructor(node, flags = {}) {
      this.node = node;
      this.flags = flags;
      this.f = null;
      live.add(this);
    }
    /** Shared open-file buffer for VFS files. */
    file() {
      if (this.node.t !== 'vfs') throw 'read-only';
      if (!this.f) {
        this.f = openFile(this.node.abs);
        this.f.refs++;
      }
      return this.f;
    }
    content() {
      if (this.node.t === 'res') return { data: this.node.node, size: this.node.node.length };
      let f = this.file();
      return { data: f.data, size: f.size };
    }
    getType() {
      return statNode(this.node).type;
    }
    getFlags() {
      return this.flags;
    }
    metadataHash() {
      let key = this.node.t === 'vfs' ? this.node.abs : this.node.t === 'res' ? '/' + [...this.node.base, ...this.node.segs].join('/') : '/';
      return { upper: 0n, lower: BigInt(hashPath(key)) };
    }
    metadataHashAt(_pathFlags, path) {
      let n = resolveAt(this.node, path);
      statNode(n);
      return new Descriptor(n).metadataHash();
    }
    stat() {
      return statNode(this.node);
    }
    statAt(pathFlags, path) {
      return statNode(resolveAt(this.node, path), !!pathFlags?.symlinkFollow);
    }
    openAt(pathFlags, path, openFlags, descFlags) {
      let n = resolveAt(this.node, path);
      if (n.t === 'root') return new Descriptor(n, descFlags);
      if (n.t === 'res') {
        if (n.node === undefined) throw openFlags.create ? 'read-only' : 'no-entry';
        if (descFlags.write || openFlags.truncate) throw 'read-only';
        let isDir = !(n.node instanceof Uint8Array);
        if (openFlags.directory && !isDir) throw 'not-directory';
        return new Descriptor(n, descFlags);
      }
      let s = tryStat(n.abs, pathFlags?.symlinkFollow !== false);
      if (s && openFlags.create && openFlags.exclusive) throw 'exist';
      if (!s) {
        if (!openFlags.create) throw 'no-entry';
        call('writeFile', { path: n.abs, data: new Uint8Array(0), mode: 0o666, flag: 'wx' });
        s = { kind: 'file' };
      }
      if (openFlags.directory && s.kind !== 'dir') throw 'not-directory';
      if (s.kind === 'dir') {
        if (descFlags.write) throw 'is-directory';
        call('access', { path: n.abs, mode: 4 });
        return new Descriptor(n, descFlags);
      }
      let write = !!(descFlags.write || openFlags.truncate);
      call('access', { path: n.abs, mode: (descFlags.read ? 4 : 0) | (write ? 2 : 0) });
      // Same lock discipline as WASI preview1 fds: shared for reading, exclusive for writing.
      call('lock', { path: n.abs, write });
      let d = new Descriptor(n, descFlags);
      d.locked = true;
      if (openFlags.truncate) {
        let f = d.file();
        f.size = 0;
        f.dirty = true;
      }
      return d;
    }
    read(length, offset) {
      let { data, size } = this.content();
      let start = Number(offset);
      let end = Math.min(size, start + Number(length));
      return [data.slice(start, Math.max(start, end)), end >= size];
    }
    readViaStream(offset) {
      return new ReadStream(this, offset);
    }
    write(buffer, offset) {
      writeAt(this.file(), buffer, Number(offset));
      return BigInt(buffer.length);
    }
    writeViaStream(offset) {
      return new WriteStream(this, offset);
    }
    appendViaStream() {
      return new WriteStream(this, 0, true);
    }
    setSize(size) {
      let f = this.file();
      let n = Number(size);
      ensure(f, n);
      if (n > f.size) f.data.fill(0, f.size, n);
      f.size = n;
      f.dirty = true;
    }
    setTimes() {}
    syncData() {
      if (this.f) flush(this.f);
    }
    sync() {
      this.syncData();
    }
    readDirectory() {
      let n = this.node;
      if (n.t === 'res') {
        if (!n.node || n.node instanceof Uint8Array) throw 'not-directory';
        return new DirectoryEntryStream(Object.entries(n.node).map(([name, v]) => ({ name, type: v instanceof Uint8Array ? 'regular-file' : 'directory' })));
      }
      let abs = n.t === 'root' ? '/' : n.abs;
      let entries = call('readdir', { path: abs }).map((e) => ({ name: e.name, type: KIND[e.kind] || 'unknown' }));
      if (n.t === 'root' && !entries.some((e) => e.name === 'usr')) entries.push({ name: 'usr', type: 'directory' });
      return new DirectoryEntryStream(entries);
    }
    createDirectoryAt(path) {
      let n = resolveAt(this.node, path);
      if (n.t !== 'vfs') throw n.t === 'res' ? 'read-only' : 'exist';
      call('mkdir', { path: n.abs });
    }
    unlinkFileAt(path) {
      let n = resolveAt(this.node, path);
      if (n.t !== 'vfs') throw 'read-only';
      let f = files.get(n.abs);
      if (f) {
        f.dirty = false;
        files.delete(n.abs);
      }
      call('rm', { path: n.abs, fileOnly: true, syscall: 'unlink' });
    }
    removeDirectoryAt(path) {
      let n = resolveAt(this.node, path);
      if (n.t !== 'vfs') throw 'read-only';
      call('rm', { path: n.abs, dirOnly: true, syscall: 'rmdir' });
    }
    renameAt(oldPath, newDesc, newPath) {
      let a = resolveAt(this.node, oldPath);
      let b = resolveAt(newDesc.node, newPath);
      if (a.t !== 'vfs' || b.t !== 'vfs') throw 'read-only';
      flushPath(a.abs);
      call('rename', { from: a.abs, to: b.abs });
      let f = files.get(a.abs);
      if (f) {
        files.delete(a.abs);
        f.path = b.abs;
        files.set(b.abs, f);
      }
      // Descriptors keep following the file.
      for (let d of live) if (d.node.t === 'vfs' && d.node.abs === a.abs) d.node = { t: 'vfs', abs: b.abs };
    }
    linkAt(_flags, oldPath, newDesc, newPath) {
      let a = resolveAt(this.node, oldPath);
      let b = resolveAt(newDesc.node, newPath);
      if (a.t !== 'vfs' || b.t !== 'vfs') throw 'read-only';
      flushPath(a.abs);
      call('link', { existing: a.abs, path: b.abs });
    }
    symlinkAt(oldPath, newPath) {
      let b = resolveAt(this.node, newPath);
      if (b.t !== 'vfs') throw 'read-only';
      call('symlink', { target: oldPath, path: b.abs });
    }
    readlinkAt(path) {
      let n = resolveAt(this.node, path);
      if (n.t !== 'vfs') throw 'invalid';
      return call('readlink', { path: n.abs });
    }
    [Symbol.dispose]() {
      if (this.f) {
        flush(this.f);
        if (--this.f.refs <= 0) files.delete(this.f.path);
        this.f = null;
      }
      if (this.locked) {
        this.locked = false;
        try {
          sys.sync('unlock', { path: this.node.abs });
        } catch {}
      }
      live.delete(this);
    }
  }

  return {
    Descriptor,
    DirectoryEntryStream,
    root: () => new Descriptor({ t: 'root' }),
    /** End of a tool run: write back everything still buffered and drop every lock. */
    finish() {
      for (let f of files.values()) flush(f);
      files.clear();
      for (let d of [...live]) d[Symbol.dispose]?.();
    },
  };
}

let LLVM_TOOLS = {
  'wasm-ld': 'wasm-ld', 'ld.lld': 'wasm-ld', ld: 'wasm-ld',
  ar: 'ar', 'llvm-ar': 'ar', ranlib: 'ranlib', 'llvm-ranlib': 'ranlib',
  nm: 'nm', 'llvm-nm': 'nm', objdump: 'objdump', 'llvm-objdump': 'objdump', objcopy: 'objcopy', 'llvm-objcopy': 'objcopy',
  strip: 'strip', 'llvm-strip': 'strip', size: 'size', 'llvm-size': 'size', addr2line: 'symbolizer', 'llvm-addr2line': 'symbolizer',
  'llvm-symbolizer': 'symbolizer', 'c++filt': 'c++filt', 'llvm-cxxfilt': 'c++filt', 'llvm-dwarfdump': 'dwarfdump', 'llvm-readobj': 'readobj',
};
let CLANG = { clang: 'clang', 'clang++': 'clang++', cc: 'clang', 'c++': 'clang++', gcc: 'clang', 'g++': 'clang++' };

/** Shell commands this runner provides. */
/**
 * Download (into the browser's HTTP cache) and compile the toolchain ahead of
 * time (`pkg install clang`). progress(done, total) in bytes; onCacheable gets
 * the compiled modules and resource tarball for the page's tool cache.
 */
export async function prefetchToolchain(progress, onCacheable) {
  await Promise.all([loadAssets(progress, null, onCacheable), loadLibTehboxen()]);
}

export let TOOL_NAMES = [...Object.keys(CLANG), ...Object.keys(LLVM_TOOLS)];

/**
 * Run a toolchain command.
 * @param {object} o { name, args, cwd, sys, path, stdout(bytes), stderr(bytes), stdin(): Uint8Array, progress(done,total) }
 * @returns {Promise<number>} exit code
 */
export async function runTool(o) {
  let [{ lib, modules, usr }, libTehboxen] = await Promise.all([loadAssets(o.progress, o.cached, o.onCacheable), loadLibTehboxen()]);
  if (libTehboxen) usr.tehboxen ??= libTehboxen;
  let { Environment, instantiate, TehboxenExit } = lib;
  let enc = new TextEncoder();

  let sysroot = null; // { dir, tree } mounted at /opt/<dir>
  let runOnce = async (args, { capture } = {}) => {
    let env = new Environment();
    env.args = ['yowasp-llvm', ...args];
    let out = capture || ((b) => b && o.stdout(b));
    let err = capture || ((b) => b && o.stderr(b));
    env.stdout = (b) => out(b && new Uint8Array(b));
    env.stderr = (b) => err(b && new Uint8Array(b));
    let stdinBytes = o.stdin?.() || new Uint8Array(0);
    let stdinPos = 0;
    env.stdin = (len) => {
      if (stdinPos >= stdinBytes.length) return null;
      let chunk = stdinBytes.subarray(stdinPos, stdinPos + len);
      stdinPos += chunk.length;
      return chunk;
    };
    let vfs = createFs({ sys: o.sys, path: o.path, cwd: o.cwd, usr, sysroot, io: env.exports.io });
    env.exports.fs = {
      Descriptor: vfs.Descriptor,
      DirectoryEntryStream: vfs.DirectoryEntryStream,
      filesystemErrorCode() {},
      getDirectories: () => [[vfs.root(), '/']],
    };
    let code = 0;
    try {
      let command = await instantiate((name) => modules[name], { runtime: env.exports });
      command.run.run();
    } catch (e) {
      if (!(e instanceof TehboxenExit)) throw e;
      code = e.code;
    } finally {
      vfs.finish();
    }
    return code;
  };

  // Guest path → VFS path, same rule as the filesystem view (cwd first, else root).
  let exists = (p) => {
    try {
      o.sys.sync('stat', { path: p, follow: false });
      return true;
    } catch {
      return false;
    }
  };
  let guestToVfs = (p) => {
    let segs = String(p).split('/').filter((x) => x && x !== '.');
    if (!segs.length || segs[0] === 'usr') return null;
    return exists(o.path.join(o.cwd, segs[0])) || !exists('/' + segs[0]) ? o.path.join(o.cwd, ...segs) : '/' + segs.join('/');
  };
  // WASI has no chmod, so the linker can't mark its output executable; do what a real ld does.
  let markExecutable = (linkArgs) => {
    let i = linkArgs.indexOf('-o');
    let out = i !== -1 ? linkArgs[i + 1] : linkArgs.find((a) => a.startsWith('-o') && a.length > 2)?.slice(2) || 'a.out';
    let abs = guestToVfs(out);
    if (!abs) return;
    try {
      o.sys.sync('chmod', { path: abs, mode: 0o755 });
    } catch {}
  };

  if (LLVM_TOOLS[o.name]) {
    let code = await runOnce([LLVM_TOOLS[o.name], ...o.args]);
    if (!code && LLVM_TOOLS[o.name] === 'wasm-ld') markExecutable(o.args);
    return code;
  }

  // Clang driver: like YoWASP's runClang, ask `clang -###` for the job list and run each job.
  let tool = CLANG[o.name] || 'clang';
  let args = [...o.args];
  // C++ exceptions: on by default for clang++ (opt out with -fno-exceptions), on for clang with
  // -fexceptions. They need WebAssembly exception handling and an exception-enabled C++ runtime,
  // which YoWASP's sysroot lacks, so those builds use the mounted eh sysroot instead.
  let wantsEh = !args.includes('-fno-exceptions') && (tool === 'clang++' || args.some((a) => a === '-fexceptions' || a === '-fwasm-exceptions'));
  // Threads: -pthread (or the wasm32-wasip1-threads target) builds a shared-memory wasi-threads module.
  let targetIdx = args.findIndex((a) => a === '-target' || a === '--target');
  let target = targetIdx !== -1 ? args[targetIdx + 1] : args.find((a) => a.startsWith('--target='))?.slice(9);
  let wantsThreads = args.some((a) => a === '-pthread' || a === '-pthreads') || /wasip1-threads|wasi-threads/.test(target || '');
  let ownSysroot = args.some((a) => a === '--sysroot' || a.startsWith('--sysroot=') || a === '-nostdlib');
  let compileOnly = args.some((a) => a === '-c' || a === '-S' || a === '-E' || a === '-fsyntax-only' || a === '-M' || a === '-MM');
  if ((wantsEh || wantsThreads) && !ownSysroot) {
    let key = wantsThreads ? 'threads' : 'eh';
    let dir = SYSROOTS[key].dir;
    let triple = wantsThreads ? 'wasm32-wasip1-threads' : 'wasm32-wasip1';
    let tree = await loadSysroot(key, o.cachedSysroots?.[key], o.onCacheableSysroot);
    sysroot = { dir, tree };
    let flavor = wantsEh ? 'eh' : 'noeh';
    args = args.filter((a) => a !== '-fexceptions' && a !== '-pthreads');
    if (wantsThreads) {
      // Drop any explicit target, then build for the threads target with the threads builtins.
      if (targetIdx !== -1) args.splice(targetIdx, 2);
      args = args.filter((a) => !a.startsWith('--target='));
      args.unshift('--target=wasm32-wasip1-threads');
      if (!args.includes('-pthread')) args.unshift('-pthread');
      let rt = tree['clang-rt']?.['libclang_rt.builtins.a'];
      if (rt) (usr.lib ??= {})['wasm32-unknown-wasip1-threads'] ??= { 'libclang_rt.builtins.a': rt };
    }
    // clang 22 doesn't pick the eh/noeh multilib by itself: name its libc++ headers and libraries explicitly.
    args.unshift(`--sysroot=/opt/${dir}`, '-nostdinc++', '-isystem', `/opt/${dir}/include/${triple}/${wantsThreads ? flavor + '/' : flavor === 'eh' ? 'eh/' : ''}c++/v1`);
    // The eh runtimes use the standard (exnref) encoding of Wasm exception handling; emit the same.
    if (wantsEh) args.unshift('-fwasm-exceptions', '-mllvm', '-wasm-use-legacy-eh=false');
    if (!compileOnly) {
      if (wantsThreads || wantsEh) args.push(`-L/opt/${dir}/lib/${triple}/${flavor}`);
      if (wantsEh) args.push('-lunwind');
      // Shared memory needs a maximum; leave room for big programs (1 GiB) unless the user picked one.
      if (wantsThreads && !args.some((a) => /--max-memory/.test(a))) args.push('-Wl,--max-memory=1073741824');
      // wasi-threads: every thread instantiates the module on one memory, so it must be imported.
      if (wantsThreads && !args.some((a) => /--import-memory/.test(a))) args.push('-Wl,--import-memory,--export-memory');
    }
  }
  // libtehboxen: declarations on every compile, the library on every link (see loadLibTehboxen).
  if (usr.tehboxen && !args.some((a) => a === '-nostdinc' || a === '-ffreestanding')) args.unshift('-include', '/usr/tehboxen/compat.h', '-idirafter', '/usr/tehboxen/include');
  if (usr.tehboxen && !compileOnly && !args.some((a) => a === '-nostdlib' || a === '-nodefaultlibs')) {
    args.push(`-L/usr/tehboxen/lib/${wantsThreads ? 'wasm32-wasip1-threads' : 'wasm32-wasip1'}`, '-Wl,--export=__tehboxen_init', '-Wl,--wrap=stat,--wrap=lstat,--wrap=fstat,--wrap=fstatat', '-ltehboxen');
  }
  // Informational invocations and -### itself run in one step, no jobs.
  if (!args.length || args.some((a) => /^(-###|--version|--help|-help|--help-hidden|-dumpversion|-dumpmachine|-print-[\w-]+(=.*)?)$/.test(a))) {
    return runOnce([tool, ...args]);
  }
  let captured = [];
  let hashCode = await runOnce([tool, '-###', ...args], { capture: (b) => b && captured.push(b) });
  let text = new TextDecoder().decode(concat(captured));
  // Driver errors: print them like clang would, without the version banner and job list.
  let driverErrors = () => enc.encode(text.split('\n').filter((l) => l && !l.startsWith(' "') && l !== ' (in-process)' && !/^(clang version|Target|Thread model|InstalledDir|Build config)\b/.test(l)).join('\n') + '\n');
  if (hashCode) {
    o.stderr(driverErrors());
    return hashCode;
  }
  let jobs = [];
  let state = 0;
  for (let line of text.split('\n')) {
    if (state === 0 && !(line.startsWith('clang') || /^(Target|Thread model|InstalledDir|Build config):/.test(line))) state = 1;
    if (state === 1) {
      if (line === ' (in-process)') continue;
      if (line.startsWith(' "')) jobs.push(unquote(line));
      else {
        state = line === '' ? 2 : 3;
      }
      continue;
    }
    if (state >= 2) break;
  }
  if (state === 3) {
    o.stderr(driverErrors());
    return 1;
  }
  if (args.includes('-v')) o.stderr(enc.encode(text));
  let temps = new Set();
  let code = 0;
  for (let job of jobs) {
    if (job[0] === '') job.shift();
    for (let a of job) if (/^\/tmp\/[^/]+-[0-9a-f]+\.\w+$/.test(a)) temps.add(a);
    code = await runOnce(job);
    if (code) break;
    if (/(^|\/)wasm-ld$/.test(job[0]) || job[0] === 'wasm-ld') markExecutable(job);
  }
  // The driver normally deletes its temporaries; we ran the jobs ourselves.
  for (let t of temps) {
    try {
      o.sys.sync('rm', { path: t, force: true });
    } catch {}
  }
  return code;
}

function unquote(line) {
  return Array.from(line.matchAll(/ (?:([^ "]+)|"((?:[^"\\$]|\\["\\$])+)")/g), (m) => (m[1] !== undefined ? m[1] : m[2].replaceAll(/\\["$\\]/g, (x) => x[1])));
}

function concat(chunks) {
  let out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (let c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}
