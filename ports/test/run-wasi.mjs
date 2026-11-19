#!/usr/bin/env node
// Run a port's WASI binary on the host (Node's WASI) for smoke tests:
//   node --experimental-wasm-exnref run-wasi.mjs <file.wasm> <argv0> [args…]
// The tehboxen.* imports libtehboxen needs get host-side stand-ins: cwd, ids,
// modes/owners from the real filesystem, system() via /bin/sh, terminal-less.
// Sockets and the rest report ENOSYS: networking is tested in the browser. (Node's WASI
// mishandles absolute paths under a bare "/" preopen, so /tmp and the cwd get their own.)
import { WASI } from 'node:wasi';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

let [file, argv0, ...args] = process.argv.slice(2);
let wasi = new WASI({ version: 'preview1', args: [argv0, ...args], env: { PATH: '/usr/bin:/bin', HOME: '/tmp', TERM: 'dumb' }, preopens: { '/': '/', '/tmp': '/tmp', [process.cwd()]: process.cwd(), '.': process.cwd() }, returnOnExit: true });
let mod = await WebAssembly.compile(fs.readFileSync(file));
let inst;
let mem = () => new Uint8Array(inst.exports.memory.buffer);
let view = () => new DataView(inst.exports.memory.buffer);
let str = (p, n) => new TextDecoder().decode(mem().slice(p, p + n));
let ENOSYS = 52;
let impl = {
  getcwd(buf, len) {
    let b = new TextEncoder().encode(process.cwd());
    if (b.length >= len) return -1;
    mem().set(b, buf);
    return b.length;
  },
  ids: () => (BigInt(process.getuid()) << 32n) | BigInt(process.getgid()),
  tty_size: () => -1,
  tty_mode: () => -1,
  mode(p, n) {
    try {
      return fs.statSync(str(p, n)).mode & 0o7777;
    } catch {
      return -1;
    }
  },
  owner(p, n, follow, out) {
    try {
      let st = (follow ? fs.statSync : fs.lstatSync)(str(p, n));
      [st.mode & 0o7777, st.uid, st.gid].forEach((v, i) => view().setUint32(out + i * 4, v, true));
      return 0;
    } catch {
      return 44;
    }
  },
  chmod(p, n, mode) {
    try {
      fs.chmodSync(str(p, n), mode);
      return 0;
    } catch {
      return 44;
    }
  },
  system(p, n) {
    let r = spawnSync('/bin/sh', ['-c', str(p, n)], { stdio: 'inherit' });
    return r.status ?? 128 + 9;
  },
};
let tb = {};
for (let i of WebAssembly.Module.imports(mod)) if (i.module === 'tehboxen') tb[i.name] = impl[i.name] || (() => ENOSYS);
inst = await WebAssembly.instantiate(mod, { ...wasi.getImportObject(), tehboxen: tb });
process.exitCode = wasi.start(inst);
