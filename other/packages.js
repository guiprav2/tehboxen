/**
 * System packages: prebuilt WASI programs (and their data) unpacked into the
 * VFS as root, installed on demand with `sudo pkg install <name>` (other/pkg.js).
 * Running a command a known package provides, while it isn't installed,
 * suggests the install command (shell.js), like Ubuntu's command-not-found.
 *
 * A package is either a .tgz whose entries sit under "package/" at their VFS
 * paths (package/usr/local/bin/vim → /usr/local/bin/vim), built on the host
 * from ports/<name>, and/or a few inline files. /var/lib/pkg/<name> records
 * the installed version and file list (for upgrades and `pkg remove`).
 */
import * as vfs from './vfs.js';

let script = (body) => `#!/bin/sh\n${body}\n`;

/** Commands served by the YoWASP Clang/LLD toolchain (same list as shell.js TOOLCHAIN). */
export let TOOLCHAIN = ['clang', 'clang++', 'cc', 'c++', 'gcc', 'g++', 'wasm-ld', 'ld.lld', 'ld', 'ar', 'llvm-ar', 'ranlib', 'llvm-ranlib', 'nm', 'llvm-nm', 'objdump', 'llvm-objdump', 'objcopy', 'llvm-objcopy', 'strip', 'llvm-strip', 'size', 'llvm-size', 'addr2line', 'llvm-addr2line', 'llvm-symbolizer', 'c++filt', 'llvm-cxxfilt', 'llvm-dwarfdump', 'llvm-readobj'];

export let PACKAGES = {
  vim: {
    version: '9.2.1364-6',
    summary: 'Vi IMproved, a programmer\'s text editor (with xxd)',
    url: new URL('../toolchain/vim/vim-9.2-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['vim', 'vi', 'view', 'ex', 'vimdiff', 'rvim', 'xxd'],
    // Our runner doesn't pass argv[0] through, so the aliases are scripts with the matching flags.
    files: {
      'usr/local/bin/vi': script('vim "$@"'),
      'usr/local/bin/view': script('vim -R "$@"'),
      'usr/local/bin/ex': script('vim -e "$@"'),
      'usr/local/bin/vimdiff': script('vim -d "$@"'),
      'usr/local/bin/rvim': script('vim -Z "$@"'),
    },
  },
  clang: {
    version: '22.1.6-1',
    summary: 'C/C++ compiler and LLVM tools for wasm32-wasip1 (YoWASP Clang/LLD 22, ~104 MB)',
    commands: TOOLCHAIN,
    // The compiler runs in node workers (other/node/clang.js); installing fetches and compiles it now.
    prefetch: async (onProgress) => {
      let { installToolchain } = await import('./node/node.js');
      await installToolchain((done, total) => onProgress?.({ phase: 'download', done, total }));
    },
    files: Object.fromEntries(TOOLCHAIN.map((c) => [`usr/local/bin/${c}`, script(`# ${c} is part of the clang package (other/node/clang.js).\ncommand ${c} "$@"`)])),
  },
  nodejs: {
    version: '22.12.0-1',
    summary: 'Node.js JavaScript runtime (node, nodejs) in Tehboxen workers',
    commands: ['node', 'nodejs'],
    // The runtime is built in (other/node); the package makes the commands available.
    files: {
      'usr/local/bin/node': script('# node is built into Tehboxen (other/node); installing nodejs enables it.\ncommand node "$@"'),
      'usr/local/bin/nodejs': script('command node "$@"'),
    },
  },
  npm: {
    version: '10.9.2-1',
    summary: 'package manager for Node.js (npm, npx)',
    commands: ['npm', 'npx'],
    depends: ['nodejs'],
    files: {
      'usr/local/bin/npm': script('# npm is built into Tehboxen (other/npm); installing npm enables it.\ncommand npm "$@"'),
      'usr/local/bin/npx': script('command npx "$@"'),
    },
  },
  kitty: {
    version: '1.0.0-1',
    summary: 'kitty, the AI agent CLI (Terminal; default model $KITTY_DEFAULT_MODEL or xai:grok-4.5)',
    commands: ['kitty'],
    // kitty takes over the Terminal (other/bash.js → other/kitty-cli.js); the package enables it.
    files: { 'usr/local/bin/kitty': script('echo "kitty: run it at a Terminal prompt" >&2\nexit 1') },
  },
  git: {
    version: '2.47.1-1',
    summary: 'distributed version control (isomorphic-git; http(s) remotes via a CORS proxy)',
    commands: ['git'],
    // git itself is built into the shell (other/git/git.js); the package makes it available.
    files: { 'usr/local/bin/git': script('# git is built into Tehboxen (other/git/git.js); installing this package enables it.\ncommand git "$@"') },
  },
};

let STATE_DIR = 'var/lib/pkg';
// The VFS wants an explicit lease for reads and removes.
let readText = (path) => vfs.withLock(path, (lease) => vfs.read(path, { lease }), { mode: 'r' });
let removeFile = (path) => vfs.withLock(path, (lease) => vfs.remove(path, { lease }), { mode: 'w' });
let installing = new Map();

/** Package that provides a command, or null. */
export function packageFor(command) {
  for (let [name, p] of Object.entries(PACKAGES)) if (p.commands.includes(command)) return name;
  return null;
}

/** { version, files } of an installed package, or null. */
export async function installedInfo(name) {
  try {
    await vfs.ensureReady();
    let text = await readText(`${STATE_DIR}/${name}`);
    if (!text) return null;
    let [version, ...files] = String(text).split('\n').filter(Boolean);
    return { version, files };
  } catch {
    return null;
  }
}

/** Installed at the current version? */
export async function isInstalled(name) {
  let info = await installedInfo(name);
  return !!info && info.version === PACKAGES[name]?.version;
}

/** Flat tar reader: [{ path, data, mode }] for regular files (ustar/GNU long names/pax paths). */
function untar(bytes) {
  let out = [];
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
    let mode = parseInt(str(h, 100, 8).trim() || '644', 8);
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
    if (type !== '0' && type !== '\0') continue;
    let path = full.split('/').filter(Boolean).slice(1).join('/');
    if (path) out.push({ path, data: data.slice(), mode: mode & 0o7777 });
  }
  return out;
}

/** Download with progress: onProgress({ phase: 'download', done, total }). */
async function download(url, onProgress) {
  let res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status} ${res.statusText})`);
  let total = Number(res.headers.get('content-length')) || 0;
  let reader = res.body.getReader();
  let chunks = [];
  let done = 0;
  for (;;) {
    let { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.length;
    onProgress?.({ phase: 'download', done, total });
  }
  let gz = new Blob(chunks);
  return new Uint8Array(await new Response(gz.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

/**
 * Install (or upgrade) a package as root. Concurrent calls share one install.
 * onProgress({ phase: 'download' | 'unpack', done, total }).
 * @returns {Promise<boolean>} false when the same version was already installed
 */
export function installPackage(name, { onProgress, force = false } = {}) {
  let p = PACKAGES[name];
  if (!p) return Promise.reject(new Error(`unable to locate package ${name}`));
  if (installing.has(name)) return installing.get(name);
  let job = (async () => {
    await vfs.ensureReady();
    let prev = await installedInfo(name);
    if (!force && prev?.version === p.version) return false;
    let entries = p.url ? untar(await download(p.url, onProgress)) : [];
    if (p.prefetch) await p.prefetch(onProgress);
    for (let [path, text] of Object.entries(p.files || {})) entries.push({ path, data: text, mode: 0o755 });
    // Write in batches: progress, and IndexedDB writes in parallel within a batch.
    let BATCH = 250;
    for (let i = 0; i < entries.length; i += BATCH) {
      await vfs.writeMany(entries.slice(i, i + BATCH), { uid: 0, gid: 0, dirMode: 0o755 });
      onProgress?.({ phase: 'unpack', done: Math.min(entries.length, i + BATCH), total: entries.length });
    }
    // Files the old version had and this one doesn't.
    let now = new Set(entries.map((e) => e.path));
    for (let f of prev?.files || []) if (!now.has(f)) await removeFile(f).catch(() => {});
    let list = [p.version, ...entries.map((e) => e.path)].join('\n') + '\n';
    await vfs.writeMany([{ path: `${STATE_DIR}/${name}`, data: list, mode: 0o644 }], { uid: 0, gid: 0, dirMode: 0o755 });
    return true;
  })();
  installing.set(name, job);
  job.catch(() => {}).finally(() => installing.delete(name));
  return job;
}

/** Remove an installed package's files. onProgress({ phase: 'remove', done, total }). */
export async function removePackage(name, { onProgress } = {}) {
  let info = await installedInfo(name);
  if (!info) return false;
  let done = 0;
  for (let f of info.files) {
    await removeFile(f).catch(() => {});
    if (++done % 50 === 0 || done === info.files.length) onProgress?.({ phase: 'remove', done, total: info.files.length });
  }
  await removeFile(`${STATE_DIR}/${name}`).catch(() => {});
  return true;
}
