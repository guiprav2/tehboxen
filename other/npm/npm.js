/**
 * `npm` / `npx` for the Tehboxen shell. Runs on the page (not in a worker) so
 * package extraction can bulk-write the VFS directly; every other file
 * operation goes through the permission-checked syscall host as the shell user.
 *
 * Global installs use prefix /usr/local (lib/node_modules, bin), so like on a
 * real box a normal user gets EACCES and `sudo npm i -g` works.
 */
import { createHost } from '../node/host.js';
import { packument, REGISTRY } from './registry.js';
import { buildIdealTree, reify, toLockfile, treeFromLock, walk, runScript, parseSpec, pickVersion, loadSemver, normalizeBins, NpmError, shq } from './arborist.js';

export let NPM_VERSION = '10.9.2';
let dec = new TextDecoder();

let ALIASES = {
  i: 'install', add: 'install', in: 'install', ins: 'install', inst: 'install', insta: 'install', instal: 'install', isnt: 'install', isntall: 'install',
  un: 'uninstall', unlink: 'uninstall', remove: 'uninstall', rm: 'uninstall', r: 'uninstall',
  up: 'update', upgrade: 'update', udpate: 'update',
  ls: 'ls', list: 'ls', la: 'ls', ll: 'ls',
  'run-script': 'run', rum: 'run', urn: 'run',
  t: 'test', tst: 'test',
  info: 'view', show: 'view', v: 'view',
  x: 'exec',
  'clean-install': 'ci', ic: 'ci', 'install-clean': 'ci', isntall_clean: 'ci',
  create: 'init', innit: 'init',
  c: 'config',
};
let SHORT = { D: 'save-dev', P: 'save-prod', O: 'save-optional', E: 'save-exact', g: 'global', S: 'save', y: 'yes', f: 'force', l: 'long', a: 'all', p: 'parseable', q: 'quiet', s: 'silent', w: 'workspace', B: 'save-bundle' };
let VALUED = new Set(['omit', 'include', 'depth', 'prefix', 'registry', 'tag', 'package', 'scope', 'save-prefix', 'otp', 'loglevel', 'workspace', 'call', 'c']);

/** npm-style (nopt) argument parsing: --flag, --no-flag, --k=v, --k v, -abc. */
export function parseArgs(argv) {
  let opts = { omit: [] };
  let rest = [];
  let afterDD = [];
  for (let i = 0; i < argv.length; i++) {
    let a = String(argv[i]);
    if (a === '--') {
      afterDD = argv.slice(i + 1).map(String);
      break;
    }
    if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s);
      if (k.startsWith('no-') && v === undefined) {
        opts[k.slice(3)] = false;
        continue;
      }
      if (v === undefined && VALUED.has(k) && i + 1 < argv.length) v = String(argv[++i]);
      if (k === 'omit') opts.omit.push(v);
      else opts[k] = v === undefined ? true : v === 'true' ? true : v === 'false' ? false : v;
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      for (let c of a.slice(1)) {
        let k = SHORT[c] || c;
        if (k === 'c' && i + 1 < argv.length) opts.call = String(argv[++i]);
        else opts[k] = true;
      }
      continue;
    }
    rest.push(a);
    // `npm exec <cmd> …` / `npx <cmd> …`: everything after the command belongs to it.
    if ((rest[0] === 'exec' || rest[0] === 'x') && rest.length === 2 && !opts.package && !opts.call) {
      afterDD = [...argv.slice(i + 1).map(String), ...afterDD];
      break;
    }
  }
  if (opts.production || opts.only === 'prod' || opts.only === 'production') opts.omit.push('dev');
  if (opts.dev === false) opts.omit.push('dev');
  return { opts, rest, afterDD };
}

/* ---------- helpers ---------- */

let pretty = (v) => JSON.stringify(v, null, 2) + '\n';
let sortObj = (o) => Object.fromEntries(Object.entries(o || {}).sort(([a], [b]) => (a < b ? -1 : 1)));
function elapsed(t0) {
  let ms = performance.now() - t0;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
}
function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * @param {string[]} argv arguments after `npm` (or the npx form with ctx.npx)
 * @param {object} ctx { cwd, env, actor, exec, live?, npx? }
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export async function runNpm(argv, ctx) {
  let stdout = '';
  let stderr = '';
  let out = (s) => (ctx.live ? ctx.live.out(s) : (stdout += s));
  let err = (s) => (ctx.live ? ctx.live.err(s) : (stderr += s));
  let warn = (s) => err(`npm warn ${s}\n`);
  let host = createHost({ actor: ctx.actor, hostname: ctx.env?.HOSTNAME, exec: ctx.exec });
  let fs = {
    read: async (p) => dec.decode(await host.call('readFile', { path: p })),
    readJson: async (p) => JSON.parse(dec.decode(await host.call('readFile', { path: p }))),
    write: (p, text) => host.call('writeFile', { path: p, data: text }),
    exists: (p) => host.call('stat', { path: p }).then(() => true, () => false),
    stat: (p) => host.call('stat', { path: p }),
  };
  let finish = (code) => ({ code, stdout, stderr });
  let { opts, rest, afterDD } = parseArgs(ctx.npx ? ['exec', ...argv] : argv);

  if (opts.version || opts.v) {
    if (!rest.length) {
      out(NPM_VERSION + '\n');
      return finish(0);
    }
  }
  let cmd = rest.shift();
  if (!cmd || opts.help || opts.h || cmd === 'help') {
    out(usage());
    return finish(cmd || opts.help ? 0 : 1);
  }
  cmd = ALIASES[cmd] || cmd;

  // Local prefix: nearest dir with package.json (else cwd); global prefix /usr/local.
  let cwd = ctx.cwd || '/';
  let prefix = cwd;
  if (opts.global) prefix = '/usr/local/lib';
  else if (opts.prefix) prefix = String(opts.prefix).startsWith('/') ? String(opts.prefix) : `${cwd}/${opts.prefix}`;
  else {
    for (let d = cwd; ; d = d.slice(0, d.lastIndexOf('/')) || '/') {
      if (await fs.exists(`${d}/package.json`)) {
        prefix = d;
        break;
      }
      if (d === '/') break;
    }
  }
  let t0 = performance.now();

  let runScriptCtx = { host, exec: ctx.exec, env: ctx.env, actor: ctx.actor, out, errOut: err, log: (s) => err(s), initCwd: cwd };

  try {
    switch (cmd) {
      case 'init': {
        let file = `${cwd}/package.json`;
        if (await fs.exists(file)) {
          err(`npm error package.json already exists in ${cwd}\n`);
          return finish(1);
        }
        let name = (opts.scope ? `@${String(opts.scope).replace(/^@/, '')}/` : '') + cwd.split('/').pop().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
        let pkg = { name, version: '1.0.0', description: '', main: 'index.js', scripts: { test: 'echo "Error: no test specified" && exit 1' }, keywords: [], author: '', license: 'ISC' };
        await fs.write(file, pretty(pkg));
        out(`Wrote to ${file}:\n\n${pretty(pkg)}\n`);
        return finish(0);
      }

      case 'install':
      case 'ci':
      case 'uninstall':
      case 'update': {
        if (cmd === 'ci' && rest.length) {
          err('npm error `npm ci` does not take arguments; use `npm install <pkg>`\n');
          return finish(1);
        }
        if (opts.global && cmd === 'install' && !rest.length) {
          err('npm error `npm install -g` requires a package name\n');
          return finish(1);
        }
        let dir = opts.global ? '/usr/local/lib' : prefix;
        if (opts.global) await host.call('mkdir', { path: dir, recursive: true });
        let pkgFile = `${dir}/package.json`;
        let rootPkg = (await fs.exists(pkgFile)) ? await fs.readJson(pkgFile) : opts.global ? { name: 'global', dependencies: {} } : {};
        if (!opts.global && !(await fs.exists(pkgFile)) && cmd !== 'install') {
          err(`npm error code ENOENT\nnpm error path ${pkgFile}\nnpm error Could not read package.json\n`);
          return finish(254);
        }
        let lockFile = `${dir}/package-lock.json`;
        let lock = (await fs.exists(lockFile)) && opts['package-lock'] !== false ? await fs.readJson(lockFile).catch(() => null) : null;
        let actual = await fs.readJson(`${dir}/node_modules/.package-lock.json`).catch(() => null);
        let save = opts.save !== false && !opts.global ? true : opts.global;
        let update = new Set();

        if (cmd === 'ci') {
          if (!lock) {
            err('npm error code EUSAGE\nnpm error The `npm ci` command can only install with an existing package-lock.json or\nnpm error npm-shrinkwrap.json with lockfileVersion >= 1.\n');
            return finish(1);
          }
          await host.call('rm', { path: `${dir}/node_modules`, recursive: true, force: true });
          actual = null;
        }
        if (cmd === 'install' && rest.length) {
          let field = opts['save-dev'] ? 'devDependencies' : opts['save-optional'] ? 'optionalDependencies' : opts['save-peer'] ? 'peerDependencies' : 'dependencies';
          for (let raw of rest) {
            let { name, spec, realName } = parseSpec(raw);
            if (!name) continue;
            let doc = await packument(realName || name);
            let version = await pickVersion(doc, spec || 'latest');
            if (!version) throw new NpmError('ETARGET', `No matching version found for ${raw}.`);
            let range = spec && !doc['dist-tags']?.[spec] ? spec : (opts['save-exact'] ? '' : opts['save-prefix'] ?? '^') + version;
            if (realName) range = `npm:${realName}@${range}`;
            for (let f of ['dependencies', 'devDependencies', 'optionalDependencies']) if (f !== field && rootPkg[f]?.[name]) delete rootPkg[f][name];
            rootPkg[field] = sortObj({ ...(rootPkg[field] || {}), [name]: range });
            update.add(name);
          }
        }
        if (cmd === 'uninstall') {
          for (let raw of rest) {
            let { name } = parseSpec(raw);
            for (let f of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) if (rootPkg[f]?.[name]) delete rootPkg[f][name];
          }
        }
        if (cmd === 'update') for (let n of rest.length ? rest : Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies, ...rootPkg.optionalDependencies })) update.add(parseSpec(n).name);

        // Root lifecycle (bare install / ci): preinstall before the tree, the rest after.
        let rootScripts = !rest.length && (cmd === 'install' || cmd === 'ci') && !opts.global && !opts['ignore-scripts'] ? rootPkg.scripts || {} : {};
        if (rootScripts.preinstall) {
          let r = await runScript({ ...runScriptCtx, pkgDir: dir, pkg: rootPkg, event: 'preinstall', script: rootScripts.preinstall, command: cmd });
          if (r.code) return lifecycleFail(err, 'preinstall', rootScripts.preinstall, dir, r.code, finish);
        }

        let ideal = await buildIdealTree({ rootPkg, lock, update, warn, legacyPeerDeps: !!opts['legacy-peer-deps'], strictLock: cmd === 'ci' });
        for (let n of walk(ideal)) if (n.manifest.deprecated && !actual?.packages?.[n.location]) warn(`deprecated ${n.realName}@${n.version}: ${n.manifest.deprecated}`);
        let omit = new Set([...(opts.omit || []), ...(opts.global ? ['dev'] : [])]);
        if (cmd !== 'ci' && opts['package-lock-only']) {
          await fs.write(lockFile, pretty(toLockfile(ideal, rootPkg)));
          out(`\nup to date, audited ${plural([...walk(ideal)].length + 1, 'package')} in ${elapsed(t0)}\n`);
          return finish(0);
        }
        let summary;
        try {
          summary = await reify({ dir, host, actor: ctx.actor, ideal, actualLock: actual, omit, ignoreScripts: !!opts['ignore-scripts'], exec: ctx.exec, env: ctx.env, log: (s) => err(s), warn, dryRun: !!opts['dry-run'], out, errOut: err, initCwd: cwd });
        } catch (e) {
          if (e.code === 'ELIFECYCLE') return lifecycleFail(err, e.event, e.script, e.path, e.exitCode, finish);
          throw e;
        }
        if (!opts['dry-run']) {
          // package.json changes only when packages were named (global installs keep their own manifest).
          if (rest.length && (save || cmd === 'uninstall') && cmd !== 'update') await fs.write(pkgFile, pretty(rootPkg));
          if (opts['package-lock'] !== false && !opts.global) await fs.write(lockFile, pretty(toLockfile(ideal, rootPkg)));
          if (opts.global) await linkGlobalBins(host, ideal, warn);
        }
        for (let event of ['install', 'postinstall', 'prepare']) {
          if (!rootScripts[event] || opts['dry-run']) continue;
          let r = await runScript({ ...runScriptCtx, pkgDir: dir, pkg: rootPkg, event, script: rootScripts[event], command: cmd });
          if (r.code) return lifecycleFail(err, event, rootScripts[event], dir, r.code, finish);
        }
        let parts = [];
        if (summary.added) parts.push(`added ${plural(summary.added, 'package')}`);
        if (summary.removed) parts.push(`removed ${plural(summary.removed, 'package')}`);
        if (summary.changed) parts.push(`changed ${plural(summary.changed, 'package')}`);
        let line = parts.length ? parts.join(', ').replace(/, ([^,]*)$/, parts.length > 1 ? ', and $1' : ', $1') : 'up to date';
        out(`\n${line}, audited ${plural(summary.audited, 'package')} in ${elapsed(t0)}\n`);
        return finish(0);
      }

      case 'ls': {
        let lock = await fs.readJson(`${prefix}/node_modules/.package-lock.json`).catch(() => null);
        let rootPkg = await fs.readJson(`${prefix}/package.json`).catch(() => ({}));
        let tree = treeFromLock(lock || { packages: {} }, rootPkg);
        let depth = opts.all ? Infinity : opts.depth != null ? Number(opts.depth) : 0;
        if (opts.json) {
          let toJson = (n, d) => Object.fromEntries([...n.children.values()].map((c) => [c.name, { version: c.version, resolved: c.resolved, ...(d < depth && c.children.size ? { dependencies: toJson(c, d + 1) } : {}) }]));
          out(pretty({ name: rootPkg.name, version: rootPkg.version, dependencies: toJson(tree, 0) }));
          return finish(0);
        }
        let declared = { ...rootPkg.dependencies, ...rootPkg.devDependencies, ...rootPkg.optionalDependencies };
        let lines = [`${rootPkg.name || '(empty)'}${rootPkg.version ? '@' + rootPkg.version : ''} ${prefix}`];
        let missing = 0;
        let draw = (node, pad, d) => {
          let kids = d === 0 ? Object.keys(declared).sort().map((n) => node.children.get(n) || { name: n, missing: true }) : [...node.children.values()];
          kids.forEach((c, i) => {
            let last = i === kids.length - 1;
            if (c.missing) missing++;
            lines.push(`${pad}${last ? '└── ' : '├── '}${c.missing ? `UNMET DEPENDENCY ${c.name}@${declared[c.name]}` : `${c.name}@${c.version}${c.dev && d === 0 ? '' : ''}`}`);
            if (!c.missing && d + 1 <= depth) draw(c, pad + (last ? '    ' : '│   '), d + 1);
          });
        };
        draw(tree, '', 0);
        if (!Object.keys(declared).length) lines.push('└── (empty)');
        out(lines.join('\n') + '\n');
        return finish(missing ? 1 : 0);
      }

      case 'view': {
        let raw = rest.shift();
        if (!raw) {
          let pkg = await fs.readJson(`${prefix}/package.json`).catch(() => null);
          if (!pkg?.name) throw new NpmError('EUSAGE', 'Usage: npm view <pkg>[@<version>] [<field>[.subfield]...]');
          raw = pkg.name;
        }
        let { name, spec } = parseSpec(raw);
        let doc = await packument(name, { full: true });
        let version = await pickVersion(doc, spec || 'latest');
        let m = doc.versions[version] || {};
        if (rest.length) {
          let pick = (field) => field.split('.').reduce((o2, k) => (o2 == null ? o2 : o2[k]), field === 'versions' || field === 'time' || field === 'dist-tags' ? doc : m);
          for (let f of rest) {
            let v = pick(f);
            out(opts.json || typeof v === 'object' ? pretty(v) : `${v ?? ''}\n`);
          }
          return finish(0);
        }
        if (opts.json) {
          out(pretty({ ...m, 'dist-tags': doc['dist-tags'], versions: Object.keys(doc.versions), time: doc.time }));
          return finish(0);
        }
        let deps = Object.entries(m.dependencies || {});
        out(
          `\n${name}@${version} | ${m.license || 'Proprietary'} | deps: ${deps.length || 'none'} | versions: ${Object.keys(doc.versions).length}\n` +
            `${m.description || ''}\n${m.homepage || ''}\n` +
            (m.bin ? `\nbin: ${Object.keys(typeof m.bin === 'string' ? { [name]: 1 } : m.bin).join(', ')}\n` : '') +
            `\ndist\n.tarball: ${m.dist?.tarball}\n.shasum: ${m.dist?.shasum}\n.integrity: ${m.dist?.integrity}\n` +
            (deps.length ? `\ndependencies:\n${deps.map(([k, v]) => `${k}: ${v}`).join('\n')}\n` : '') +
            `\ndist-tags:\n${Object.entries(doc['dist-tags'] || {}).map(([k, v]) => `${k}: ${v}`).join('\n')}\n` +
            (doc.time?.[version] ? `\npublished ${doc.time[version]}\n` : ''),
        );
        return finish(0);
      }

      case 'outdated': {
        let semver = await loadSemver();
        let rootPkg = await fs.readJson(`${prefix}/package.json`);
        let lock = await fs.readJson(`${prefix}/node_modules/.package-lock.json`).catch(() => ({ packages: {} }));
        let rows = [];
        for (let [field, deps] of [['dependencies', rootPkg.dependencies], ['devDependencies', rootPkg.devDependencies]]) {
          for (let [name, range] of Object.entries(deps || {})) {
            let doc = await packument(name);
            let current = lock.packages[`node_modules/${name}`]?.version || 'MISSING';
            let wanted = semver.maxSatisfying(Object.keys(doc.versions), range) || current;
            let latest = doc['dist-tags']?.latest;
            if (current !== wanted || current !== latest) rows.push([name, current, wanted, latest, `node_modules/${name}`, field === 'devDependencies' ? 'dev' : '']);
          }
        }
        if (!rows.length) return finish(0);
        let head = ['Package', 'Current', 'Wanted', 'Latest', 'Location', 'Depended by'];
        let all = [head, ...rows.map((r) => [r[0], r[1], r[2], r[3], r[4], prefix.split('/').pop()])];
        let w = head.map((_, i) => Math.max(...all.map((r) => String(r[i]).length)));
        out(all.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd()).join('\n') + '\n');
        return finish(1);
      }

      case 'run':
      case 'test':
      case 'start':
      case 'stop':
      case 'restart': {
        let rootPkg = await fs.readJson(`${prefix}/package.json`).catch(() => null);
        if (!rootPkg) {
          err(`npm error code ENOENT\nnpm error path ${prefix}/package.json\nnpm error Could not read package.json\n`);
          return finish(254);
        }
        let scripts = rootPkg.scripts || {};
        let name = cmd === 'run' ? rest.shift() : cmd;
        if (!name) {
          let entries = Object.entries(scripts);
          let life = ['test', 'start', 'stop', 'restart'];
          let a = entries.filter(([k]) => life.includes(k));
          let b = entries.filter(([k]) => !life.includes(k));
          out(`Scripts available in ${rootPkg.name}@${rootPkg.version} via \`npm run-script\`:\n` + [...a, ...b].map(([k, v]) => `  ${k}\n    ${v}\n`).join(''));
          return finish(0);
        }
        let args = [...rest, ...afterDD];
        let script = scripts[name] ?? (name === 'start' ? 'node server.js' : null);
        if (script == null) {
          if (opts['if-present']) return finish(0);
          err(`npm error Missing script: "${name}"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n`);
          return finish(1);
        }
        let steps = [];
        if (!opts['ignore-scripts'] && scripts['pre' + name]) steps.push(['pre' + name, scripts['pre' + name], []]);
        steps.push([name, script, args]);
        if (!opts['ignore-scripts'] && scripts['post' + name]) steps.push(['post' + name, scripts['post' + name], []]);
        for (let [event, s, a] of steps) {
          let r = await runScript({ ...runScriptCtx, pkgDir: prefix, pkg: rootPkg, event, script: s, args: a, command: 'run-script', log: (x) => out(x) });
          if (r.code) return lifecycleFail(err, event, s, prefix, r.code, finish);
        }
        return finish(0);
      }

      case 'exec': {
        let packages = [].concat(opts.package || []);
        let args = [...rest, ...afterDD];
        if (opts.call) {
          let r = await ctx.exec(String(opts.call), { cwd, env: withBinPath(ctx.env, cwd) });
          out(r.stdout);
          err(r.stderr);
          return finish(r.code);
        }
        if (!args.length) {
          err('npm error npx: please provide a command to run\n');
          return finish(1);
        }
        let [first, ...cmdArgs] = args;
        let { name, spec } = parseSpec(packages[0] || first);
        let binName = packages.length ? first : name.replace(/^@[^/]+\//, '');
        // 1. local node_modules/.bin up the tree
        for (let d = cwd; ; d = d.slice(0, d.lastIndexOf('/')) || '/') {
          if (await fs.exists(`${d}/node_modules/.bin/${binName}`)) {
            let r = await ctx.exec([`${d}/node_modules/.bin/${binName}`, ...cmdArgs].map(shq).join(' '), { cwd, env: withBinPath(ctx.env, cwd) });
            return passthrough(r, out, err, finish);
          }
          if (d === '/') break;
        }
        // 2. install into the npx cache (~/.npm/_npx/<name>) and run its bin
        let home = '/' + String(ctx.actor.home || '').replace(/^\/+/, '');
        let cacheDir = `${home}/.npm/_npx/${(name + '@' + (spec || 'latest')).replace(/[^\w.@-]+/g, '_')}`;
        if (!(await fs.exists(`${cacheDir}/node_modules/.bin/${binName}`))) {
          let doc = await packument(name);
          let version = await pickVersion(doc, spec || 'latest');
          if (!version) throw new NpmError('ETARGET', `No matching version found for ${name}@${spec || 'latest'}.`);
          await host.call('mkdir', { path: cacheDir, recursive: true });
          let rootPkg = { name: 'npx-cache', dependencies: { [name]: version } };
          await fs.write(`${cacheDir}/package.json`, pretty(rootPkg));
          let ideal = await buildIdealTree({ rootPkg, warn });
          await reify({ dir: cacheDir, host, actor: ctx.actor, ideal, actualLock: null, omit: new Set(['dev']), ignoreScripts: !!opts['ignore-scripts'], exec: ctx.exec, env: ctx.env, log: (s) => err(s), warn, out, errOut: err });
          if (!(await fs.exists(`${cacheDir}/node_modules/.bin/${binName}`))) {
            let bins = normalizeBins(ideal.children.get(name) || { manifest: {} });
            if (bins.length === 1) binName = bins[0][0];
            else {
              err(`npm error could not determine executable to run for ${name}\n`);
              return finish(1);
            }
          }
        }
        let r = await ctx.exec([`${cacheDir}/node_modules/.bin/${binName}`, ...cmdArgs].map(shq).join(' '), { cwd, env: withBinPath(ctx.env, cwd) });
        return passthrough(r, out, err, finish);
      }

      case 'version': {
        let pkgFile = `${prefix}/package.json`;
        let rootPkg = await fs.readJson(pkgFile).catch(() => null);
        if (!rest.length) {
          out(pretty({ ...(rootPkg?.name ? { [rootPkg.name]: rootPkg.version } : {}), npm: NPM_VERSION, node: '22.12.0', tehboxen: '1' }));
          return finish(0);
        }
        let semver = await loadSemver();
        let next = semver.valid(rest[0]) || semver.inc(rootPkg.version, rest[0], opts.preid);
        if (!next) throw new NpmError('EUSAGE', `Invalid version: ${rest[0]}`);
        rootPkg.version = next;
        await fs.write(pkgFile, pretty(rootPkg));
        let lockFile = `${prefix}/package-lock.json`;
        let lock = await fs.readJson(lockFile).catch(() => null);
        if (lock) {
          lock.version = next;
          if (lock.packages?.['']) lock.packages[''].version = next;
          await fs.write(lockFile, pretty(lock));
        }
        out(`v${next}\n`);
        return finish(0);
      }

      case 'prefix':
        out((opts.global ? '/usr/local' : prefix) + '\n');
        return finish(0);
      case 'root':
        out((opts.global ? '/usr/local/lib/node_modules' : `${prefix}/node_modules`) + '\n');
        return finish(0);
      case 'bin':
        out((opts.global ? '/usr/local/bin' : `${prefix}/node_modules/.bin`) + '\n');
        return finish(0);
      case 'whoami':
        err('npm error code ENEEDAUTH\nnpm error need auth This command requires you to be logged in.\n');
        return finish(1);
      case 'ping': {
        let res = await fetch(`${REGISTRY}/-/ping`).catch(() => null);
        out(`npm notice PING ${REGISTRY}/\n`);
        if (!res?.ok) {
          err('npm error ping failed\n');
          return finish(1);
        }
        out(`npm notice PONG ${elapsed(t0)}\n`);
        return finish(0);
      }
      case 'cache':
        if (rest[0] === 'clean' || rest[0] === 'clear') {
          let home = '/' + String(ctx.actor.home || '').replace(/^\/+/, '');
          await host.call('rm', { path: `${home}/.npm`, recursive: true, force: true });
          return finish(0);
        }
        out('npm cache: registry metadata is cached in memory for 5 minutes; `npm cache clean --force` removes ~/.npm.\n');
        return finish(0);
      case 'audit':
        err('npm error audit is not available in Tehboxen: the advisory endpoint requires a CORS preflight the registry rejects.\n');
        return finish(1);
      case 'config':
      case 'get':
      case 'set':
        out(cmd === 'config' && rest[0] === 'get' && rest[1] === 'registry' ? `${REGISTRY}/\n` : 'npm config is read-only in Tehboxen (registry: https://registry.npmjs.org/).\n');
        return finish(0);
      default:
        err(`Unknown command: "${cmd}"\n\nTo see a list of supported npm commands, run:\n  npm help\n`);
        return finish(1);
    }
  } catch (e) {
    let code = e?.code || 'EUNKNOWN';
    err(`npm error code ${code}\n${String(e?.message || e).split('\n').map((l) => `npm error ${l}`).join('\n')}\n`);
    return finish(1);
  }
}

function lifecycleFail(err, event, script, path, code, finish, output) {
  if (output) err(output.endsWith('\n') ? output : output + '\n');
  err(`npm error code ${code}\nnpm error path ${path}\nnpm error command failed\nnpm error command sh -c ${script}\n`);
  return finish(code);
}

function passthrough(r, out, err, finish) {
  if (r.stdout) out(r.stdout);
  if (r.stderr) err(r.stderr);
  return finish(r.code);
}

function withBinPath(env, cwd) {
  let dirs = [];
  for (let d = cwd; ; d = d.slice(0, d.lastIndexOf('/')) || '/') {
    dirs.push(`${d === '/' ? '' : d}/node_modules/.bin`);
    if (d === '/') break;
  }
  return { ...env, PATH: [...dirs, env?.PATH || '/usr/local/bin:/usr/bin:/bin'].join(':') };
}

async function linkGlobalBins(host, ideal, warn) {
  await host.call('mkdir', { path: '/usr/local/bin', recursive: true });
  for (let n of ideal.children.values()) {
    for (let [binName, binPath] of normalizeBins(n)) {
      let link = `/usr/local/bin/${binName}`;
      await host.call('rm', { path: link, force: true }).catch(() => {});
      await host.call('symlink', { target: `/usr/local/lib/node_modules/${n.name}/${binPath.replace(/^\.\//, '')}`, path: link }).catch((e) => warn(`could not link ${binName}: ${e.message}`));
    }
  }
}

function usage() {
  return `npm <command>

Usage:

npm install        install all the dependencies in your project
npm install <foo>  add the <foo> dependency to your project
npm test           run this project's tests
npm run <foo>      run the script named <foo>
npm <command> -h   quick help on <command>

All commands:

    ci, exec, init, install, ls, outdated, prefix, root, bin,
    run, start, stop, restart, test, uninstall, update, version,
    view, cache, ping, config, audit

npm@${NPM_VERSION} (Tehboxen: registry.npmjs.org over CORS; native addons are not supported)
`;
}
