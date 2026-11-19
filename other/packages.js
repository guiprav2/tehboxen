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

/** Applets in toolchain/busybox (ports/busybox/package.sh lists them in busybox.links). */
let BUSYBOX_APPLETS = ["[", "[[", "awk", "base32", "base64", "basename", "bc", "bunzip2", "busybox", "bzcat", "bzip2", "cal", "cat", "chmod", "cksum", "clear", "cmp", "comm", "cp", "crc32", "cryptpw", "cut", "dc", "dd", "diff", "dirname", "du", "dumpleases", "echo", "ed", "egrep", "env", "expand", "expr", "factor", "false", "fgrep", "find", "fold", "ftpget", "ftpput", "grep", "gunzip", "gzip", "hd", "head", "hexdump", "id", "ipcalc", "less", "ln", "ls", "md5sum", "mkdir", "mkpasswd", "mktemp", "more", "mv", "nc", "nl", "nohup", "nproc", "nslookup", "od", "paste", "patch", "ping", "printenv", "printf", "pwd", "readlink", "realpath", "reset", "rev", "rm", "rmdir", "sed", "seq", "sha1sum", "sha256sum", "sha3sum", "sha512sum", "shred", "shuf", "sleep", "sort", "split", "stat", "strings", "sum", "tac", "tail", "tar", "tee", "telnet", "test", "tftp", "touch", "tr", "traceroute", "true", "truncate", "tsort", "udhcpc", "udhcpd", "uname", "unexpand", "uniq", "unlink", "usleep", "uudecode", "uuencode", "watch", "wc", "which", "whoami", "whois", "xargs", "yes", "zcat"];

export let PACKAGES = {
  busybox: {
    version: '1.37.0-13',
    summary: 'BusyBox: coreutils, awk, sed, grep, find, tar/gzip/bzip2, less, diff, ping, traceroute, nc, nslookup, telnet, udhcpc… in one binary',
    url: new URL('../toolchain/busybox/busybox-1.37.0-wasm32-wasip1.tgz', import.meta.url).href,
    commands: BUSYBOX_APPLETS,
    // Part of the base system: installed at boot on every box, no `pkg install` needed.
    baked: true,
  },
  xz: {
    version: '5.8.4-3',
    summary: 'XZ Utils: xz/LZMA compression (xz, unxz, xzcat, lzma, unlzma, lzcat; tar cJf/xJf)',
    url: new URL('../toolchain/xz/xz-5.8.4-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['xz', 'unxz', 'xzcat', 'lzma', 'unlzma', 'lzcat'],
    baked: true,
  },
  openssl: {
    version: '3.5.9-2',
    summary: 'OpenSSL 3.5 LTS: TLS client/server, keys, CSRs, certificates, CAs (openssl), trust in /etc/ssl/certs',
    url: new URL('../toolchain/openssl/openssl-3.5.9-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['openssl'],
    baked: true,
  },
  wget: {
    version: '1.25.0-2',
    summary: 'GNU Wget with OpenSSL: HTTP/HTTPS/FTP downloads, recursive mirroring, verified TLS',
    url: new URL('../toolchain/wget/wget-1.25.0-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['wget'],
    baked: true,
  },
  curl: {
    version: '8.23.0-2',
    summary: 'curl with OpenSSL: transfer data over HTTP(S), FTP(S), SMTP(S), IMAP(S), WebSocket…',
    url: new URL('../toolchain/curl/curl-8.23.0-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['curl'],
    baked: true,
  },
  uacme: {
    version: '1.8.1-2',
    summary: 'uacme: ACME client — free TLS certificates from TrustRoot (or any ACME CA) via http-01',
    url: new URL('../toolchain/uacme/uacme-1.8.1-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['uacme'],
  },
  zip: {
    version: '3.0-16.1',
    summary: 'Info-ZIP Zip 3.0 (Debian-patched): create and update .zip archives (zip, zipcloak, zipnote, zipsplit)',
    url: new URL('../toolchain/zip/zip-3.0-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['zip', 'zipcloak', 'zipnote', 'zipsplit'],
    baked: true,
  },
  unzip: {
    version: '6.0-32.1',
    summary: 'Info-ZIP UnZip 6.0 (Debian-patched): list, test and extract .zip archives (unzip, zipinfo, funzip)',
    url: new URL('../toolchain/unzip/unzip-6.0-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['unzip', 'zipinfo', 'funzip'],
    baked: true,
  },
  nmap: {
    version: '7.993-3',
    summary: 'Nmap: network exploration and security auditing (SYN/connect/UDP scans, OS and service detection, NSE scripts)',
    url: new URL('../toolchain/nmap/nmap-7.993-wasm32-wasip1.tgz', import.meta.url).href,
    commands: ['nmap'],
  },
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

/** Paths that installed packages other than `name` list (a file moved between packages stays). */
async function filesOwnedByOthers(name) {
  let owned = new Set();
  for (let other of Object.keys(PACKAGES)) {
    if (other === name) continue;
    for (let f of (await installedInfo(other))?.files || []) owned.add(f);
  }
  return owned;
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
    let path = full.split('/').filter(Boolean).slice(1).join('/');
    if (type === '2') {
      if (path) out.push({ path, symlink: str(h, 157, 100) });
      continue;
    }
    if (type !== '0' && type !== '\0') continue;
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
  if (installing.has(name)) {
    let running = installing.get(name);
    if (onProgress) running.listeners.add(onProgress);
    return running.job;
  }
  let listeners = new Set(onProgress ? [onProgress] : []);
  let last = null;
  onProgress = (ev) => {
    last = ev;
    for (let fn of listeners) {
      try {
        fn(ev);
      } catch {}
    }
  };
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
    let others = prev ? await filesOwnedByOthers(name) : new Set();
    for (let f of prev?.files || []) if (!now.has(f) && !others.has(f)) await removeFile(f).catch(() => {});
    let list = [p.version, ...entries.map((e) => e.path)].join('\n') + '\n';
    await vfs.writeMany([{ path: `${STATE_DIR}/${name}`, data: list, mode: 0o644 }], { uid: 0, gid: 0, dirMode: 0o755 });
    return true;
  })();
  installing.set(name, { job, listeners, last: () => last });
  job.catch(() => {}).finally(() => installing.delete(name));
  return job;
}

/** A running install of `name`: { job, listeners, last() }, or undefined. */
export let installJob = (name) => installing.get(name);

/** Baked (base system) packages. */
export let BAKED = Object.keys(PACKAGES).filter((n) => PACKAGES[n].baked);

let bakedRun = null;
/**
 * Install or upgrade the base-system packages (busybox…) — at boot on every box, in the
 * background. Concurrent callers share the run.
 */
export function ensureBaked() {
  bakedRun ??= (async () => {
    for (let name of BAKED) {
      try {
        if (!(await isInstalled(name))) await installPackage(name, { force: true });
      } catch (err) {
        console.warn(`[pkg] ${name}:`, err?.message || err);
      }
    }
  })().finally(() => (bakedRun = null));
  return bakedRun;
}

/** Remove an installed package's files. onProgress({ phase: 'remove', done, total }). */
export async function removePackage(name, { onProgress } = {}) {
  let info = await installedInfo(name);
  if (!info) return false;
  let done = 0;
  let others = await filesOwnedByOthers(name);
  for (let f of info.files) {
    if (!others.has(f)) await removeFile(f).catch(() => {});
    if (++done % 50 === 0 || done === info.files.length) onProgress?.({ phase: 'remove', done, total: info.files.length });
  }
  await removeFile(`${STATE_DIR}/${name}`).catch(() => {});
  return true;
}
