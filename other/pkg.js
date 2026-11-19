/**
 * `pkg`: the Tehboxen package manager (system packages in other/packages.js).
 *
 *   pkg install <name>…   (root) download and unpack, dependencies first, with progress bars
 *   pkg remove <name>…    (root) delete a package's files (and installed packages that depend on it)
 *   pkg reinstall <name>…
 *   pkg list              available packages, installed ones marked
 *   pkg info <name>       details
 *   pkg search <text>
 *
 * Commands take any unambiguous prefix (pkg l, pkg se) plus the usual aliases
 * (i/add → install, rm/uninstall → remove, ls → list, show → info).
 */
import { PACKAGES, installPackage, removePackage, installedInfo } from './packages.js';

let mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

/**
 * One progress line that fits the terminal (a line that wraps can't be
 * redrawn in place: \r only rewinds its last row). The bar shrinks first,
 * then the detail is dropped on very narrow screens.
 */
function bar(label, done, total, columns = 80, detail = '') {
  let frac = total ? Math.min(1, done / total) : 0;
  let pct = String(Math.round(frac * 100)).padStart(3) + '%';
  let fixed = label.length + 1 + 2 + 1 + pct.length; // "label [" "] " "pct"
  let room = Math.max(1, columns - 1); // never touch the last column (auto-wrap)
  let width = Math.min(30, room - fixed - (detail ? detail.length + 2 : 0));
  if (width < 8) {
    detail = '';
    width = Math.min(30, room - fixed);
  }
  if (width < 4) return `${label} ${pct}`.slice(0, room);
  let fill = Math.round(frac * width);
  return `${label} [\x1b[32m${'█'.repeat(fill)}\x1b[2m${'░'.repeat(width - fill)}\x1b[0m] ${pct}${detail ? '  ' + detail : ''}`;
}

/**
 * @param {string[]} args
 * @param {{ actor: { uid: number }, live?: { out: (s: string) => void, err: (s: string) => void } }} ctx
 */
export async function runPkg(args, ctx) {
  let stdout = '';
  let stderr = '';
  let out = (s) => (ctx.live ? ctx.live.out(s) : (stdout += s));
  let err = (s) => (ctx.live ? ctx.live.err(s) : (stderr += s));
  let done = (code) => ({ code, stdout, stderr });
  let [given, ...rest] = args;
  let cmd = resolveCommand(given);
  if (cmd?.error) {
    err(`pkg: ${cmd.error}\n`);
    return done(1);
  }
  let names = rest.filter((a) => !a.startsWith('-'));
  let flags = new Set(rest.filter((a) => a.startsWith('-')));

  if (!cmd || cmd === 'help') {
    out('usage: pkg <command> [package…]\n\n  install <name>…   download and install, with dependencies (as root: sudo pkg install vim)\n  remove <name>…    uninstall (and what depends on it)\n  reinstall <name>… install again\n  list              available packages\n  info <name>       package details\n  search <text>     find packages\n\nAny unambiguous prefix works (pkg l, pkg se), plus i, add, rm, uninstall, ls, show.\n');
    return done(cmd ? 0 : 1);
  }

  if (cmd === 'list') {
    for (let [name, p] of Object.entries(PACKAGES)) {
      let info = await installedInfo(name);
      let mark = !info ? '' : info.version === p.version ? ' \x1b[32m[installed]\x1b[0m' : ` \x1b[33m[installed ${info.version}, upgradable]\x1b[0m`;
      out(`\x1b[1m${name}\x1b[0m/${p.version}${mark}\n  ${p.summary}\n`);
    }
    return done(0);
  }

  if (cmd === 'search') {
    let q = names.join(' ').toLowerCase();
    for (let [name, p] of Object.entries(PACKAGES)) if (!q || name.includes(q) || p.summary.toLowerCase().includes(q) || p.commands.some((c) => c.includes(q))) out(`${name}/${p.version}  ${p.summary}\n`);
    return done(0);
  }

  if (cmd === 'info') {
    for (let name of names) {
      let p = PACKAGES[name];
      if (!p) {
        err(`pkg: unable to locate package ${name}\n`);
        return done(100);
      }
      let info = await installedInfo(name);
      out(`Package: ${name}\nVersion: ${p.version}\nInstalled: ${info ? info.version : 'no'}\nCommands: ${p.commands.join(', ')}\n${p.depends?.length ? `Depends: ${p.depends.join(', ')}\n` : ''}Description: ${p.summary}\n${info ? `Files: ${info.files.length}\n` : ''}`);
    }
    return done(0);
  }

  if (cmd === 'install' || cmd === 'remove' || cmd === 'reinstall') {
    if (!names.length) {
      err(`pkg: ${cmd}: no packages given\n`);
      return done(1);
    }
    let unknown = names.filter((n) => !PACKAGES[n]);
    if (unknown.length) {
      err(unknown.map((n) => `pkg: unable to locate package ${n}\n`).join(''));
      return done(100);
    }
    if (Number(ctx.actor?.uid) !== 0) {
      err(`pkg: permission denied: installing and removing packages needs root\nTry: sudo pkg ${cmd} ${names.join(' ')}\n`);
      return done(100);
    }
    let removing = cmd === 'remove';
    // install: dependencies first; remove: installed dependents too (they'd break).
    let order = [];
    if (removing) {
      let add = (n) => {
        if (order.includes(n)) return;
        for (let [other, q] of Object.entries(PACKAGES)) if (q.depends?.includes(n)) add(other);
        order.push(n);
      };
      for (let n of names) add(n);
      let extra = order.filter((n) => !names.includes(n));
      let installedExtra = [];
      for (let n of extra) if (await installedInfo(n)) installedExtra.push(n);
      order = order.filter((n) => names.includes(n) || installedExtra.includes(n));
      if (installedExtra.length) out(`Also removing, because they depend on it: ${installedExtra.join(', ')}\n`);
    } else {
      let add = (n) => {
        if (order.includes(n)) return;
        for (let d of PACKAGES[n].depends || []) add(d);
        order.push(n);
      };
      for (let n of names) add(n);
    }
    for (let name of order) {
      let explicit = names.includes(name);
      let p = PACKAGES[name];
      let last = '';
      // Progress redraws one line in place: CR + erase line (ESC[2K), cursor hidden meanwhile.
      let columns = Number(ctx.live?.columns) || 80;
      let drawn = false;
      let lastAt = 0;
      let show = ({ phase, done: d, total }) => {
        if (!ctx.live) return;
        let now = performance.now();
        let final = total && d >= total;
        if (!final && now - lastAt < 50) return;
        lastAt = now;
        let label = phase === 'download' ? 'Fetching' : phase === 'unpack' ? 'Unpacking' : 'Removing';
        let detail = phase === 'download' ? (total ? `${mb(d)}/${mb(total)}` : mb(d)) : `${d}/${total} files`;
        let line = bar(label, d, total, columns, detail);
        if (line === last) return;
        ctx.live.out(`${drawn ? '' : '\x1b[?25l'}\r\x1b[2K${line}`);
        drawn = true;
        last = line;
      };
      let endProgress = () => {
        if (!drawn || !ctx.live) return;
        ctx.live.out('\r\x1b[2K\x1b[?25h');
        drawn = false;
        last = '';
      };
      try {
        if (removing) {
          if (!(await installedInfo(name))) {
            out(`Package '${name}' is not installed, so not removed\n`);
            continue;
          }
          out(`Removing ${name}…\n`);
          await removePackage(name, { onProgress: show });
          endProgress();
          out(`Removed ${name}.\n`);
          continue;
        }
        let prev = await installedInfo(name);
        if (prev?.version === p.version && (cmd !== 'reinstall' || !explicit) && !flags.has('--force')) {
          if (explicit) out(`${name} is already the newest version (${p.version}).\n`);
          continue;
        }
        out(`${prev ? 'Upgrading' : 'Installing'} ${name} ${prev ? `${prev.version} → ` : ''}${p.version}…\n`);
        let t0 = performance.now();
        await installPackage(name, { onProgress: show, force: true });
        endProgress();
        out(`\x1b[32m✔\x1b[0m ${name} ${p.version} installed in ${((performance.now() - t0) / 1000).toFixed(1)}s: ${p.commands.join(', ')}\n`);
      } catch (e) {
        endProgress();
        err(`pkg: ${name}: ${e?.message || e}\n`);
        return done(100);
      }
    }
    return done(0);
  }

  err(`pkg: unknown command '${cmd}' (see pkg help)\n`);
  return done(1);
}

let COMMANDS = ['install', 'remove', 'reinstall', 'list', 'info', 'search', 'help'];
let ALIASES = { i: 'install', add: 'install', rm: 'remove', uninstall: 'remove', un: 'remove', del: 'remove', ls: 'list', show: 'info', '-h': 'help', '--help': 'help' };

/** Canonical command for an alias or an unambiguous prefix; { error } otherwise. */
function resolveCommand(given) {
  if (!given) return null;
  if (ALIASES[given]) return ALIASES[given];
  if (COMMANDS.includes(given)) return given;
  let hits = COMMANDS.filter((c) => c.startsWith(given));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) return { error: `'${given}' is ambiguous: ${hits.join(', ')}` };
  return { error: `unknown command '${given}' (see pkg help)` };
}
