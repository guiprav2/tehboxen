/**
 * vfs-browserify — browserify's pipeline, adapted to run inside Tehboxen.
 *
 *   record → deps → json / unbom / unshebang / esm (babelify) → label → pack
 *
 * What changed from upstream browserify (module-deps + resolve + browser-pack):
 *  - Files come from a `host` (the VFS mirror, or a CDN package listing for
 *    host libraries such as commander) instead of Node's fs.
 *  - Resolution is Node's algorithm (package.json `exports` / `imports` with
 *    node conditions, `main`, index files), not the `browser` field: the
 *    bundle runs on the simulated node runtime, whose builtins are real
 *    VFS-backed modules rather than browser shims.
 *  - ES modules / TypeScript are converted to CommonJS with Babel (what
 *    babelify/esmify do), keeping `import.meta` and dynamic `import()`.
 *  - Missing modules are recorded, not fatal: Node only fails when the
 *    require actually runs, so the bundle throws MODULE_NOT_FOUND lazily.
 *  - browser-pack's prelude is async: entry modules (and any module with
 *    top-level await) are async functions evaluated in dependency order, and
 *    the whole bundle is a function body run as an AsyncFunction.
 */
import path from './path.js';

let EXTS = ['.js', '.mjs', '.cjs', '.json', '.ts', '.mts', '.cts', '.node'];
let BABEL_URL = 'https://cdn.jsdelivr.net/npm/@babel/standalone@7.28.4/+esm';
let babelPromise = null;

let babelReady = null;
export function loadBabel() {
  babelPromise ??= import(BABEL_URL).then((m) => (babelReady = m.default || m));
  return babelPromise;
}

export class ResolveError extends Error {
  constructor(spec, from, code = 'MODULE_NOT_FOUND', detail) {
    super(detail || `Cannot find module '${spec}'${from ? `\nRequire stack:\n- ${from}` : ''}`);
    this.code = code;
    this.requireStack = from ? [from] : [];
  }
}

/* ---------- resolution (Node's algorithm on a sync host) ---------- */

export function createResolver({ host, isBuiltin, conditions = [], preserveSymlinks = false }) {
  let pkgCache = new Map();
  function readPkg(dir) {
    let file = path.join(dir, 'package.json');
    if (pkgCache.has(file)) return pkgCache.get(file);
    let pkg = null;
    if (host.isFile(file)) {
      try {
        pkg = JSON.parse(host.readTextSync(file));
      } catch (err) {
        throw new ResolveError(file, null, 'ERR_INVALID_PACKAGE_CONFIG', `Invalid package config ${file}: ${err.message}`);
      }
    }
    pkgCache.set(file, pkg);
    return pkg;
  }
  function real(p) {
    if (preserveSymlinks || !host.realpath) return p;
    try {
      return host.realpath(p);
    } catch {
      return p;
    }
  }
  function loadAsFile(x) {
    if (host.isFile(x)) return x;
    for (let e of EXTS) if (host.isFile(x + e)) return x + e;
    return null;
  }
  function loadIndex(x) {
    for (let e of EXTS) if (host.isFile(path.join(x, 'index' + e))) return path.join(x, 'index' + e);
    return null;
  }
  function loadAsDirectory(x) {
    if (!host.isDir(x)) return null;
    let pkg = readPkg(x);
    if (pkg && typeof pkg.main === 'string' && pkg.main) {
      let m = path.join(x, pkg.main);
      let r = loadAsFile(m) || loadIndex(m);
      if (r) return r;
    }
    return loadIndex(x);
  }
  function conditionsFor(kind) {
    return new Set(['node', kind === 'import' ? 'import' : 'require', 'module-sync', ...conditions, 'default']);
  }
  function resolveTarget(pkgDir, target, star, conds) {
    if (target === null) return null;
    if (typeof target === 'string') {
      if (!target.startsWith('./')) return target.startsWith('#') ? null : { bare: target.replace(/\*/g, star ?? '') };
      return path.join(pkgDir, star != null ? target.replace(/\*/g, star) : target);
    }
    if (Array.isArray(target)) {
      for (let t of target) {
        let r = resolveTarget(pkgDir, t, star, conds);
        if (r) return r;
      }
      return null;
    }
    if (typeof target === 'object') {
      for (let [k, v] of Object.entries(target)) {
        if (!conds.has(k)) continue;
        let r = resolveTarget(pkgDir, v, star, conds);
        if (r !== undefined && r !== null) return r;
      }
      return undefined;
    }
    return null;
  }
  function matchMap(map, sub) {
    if (Object.prototype.hasOwnProperty.call(map, sub) && !sub.includes('*')) return { target: map[sub], star: null };
    let best = null;
    for (let key of Object.keys(map)) {
      let i = key.indexOf('*');
      if (i === -1) continue;
      let pre = key.slice(0, i);
      let post = key.slice(i + 1);
      if (sub.startsWith(pre) && sub !== pre && sub.endsWith(post) && sub.length >= key.length) {
        if (!best || pre.length > best.pre.length) best = { pre, key, star: sub.slice(pre.length, sub.length - post.length) };
      }
    }
    return best ? { target: map[best.key], star: best.star } : null;
  }
  function resolveExports(pkgDir, exportsField, sub, kind, spec, from) {
    let map = exportsField;
    let isSubpathMap = map && typeof map === 'object' && !Array.isArray(map) && Object.keys(map).some((k) => k.startsWith('.'));
    if (!isSubpathMap) map = { '.': exportsField };
    let m = matchMap(map, sub);
    if (!m) throw new ResolveError(spec, from, 'ERR_PACKAGE_PATH_NOT_EXPORTED', `Package subpath '${sub}' is not defined by "exports" in ${path.join(pkgDir, 'package.json')}`);
    let r = resolveTarget(pkgDir, m.target, m.star, conditionsFor(kind));
    if (!r) throw new ResolveError(spec, from, 'ERR_PACKAGE_PATH_NOT_EXPORTED', `No "exports" main defined in ${path.join(pkgDir, 'package.json')}`);
    if (typeof r === 'object') return r;
    let file = loadAsFile(r);
    if (!file) throw new ResolveError(spec, from);
    return file;
  }
  function nodeModulesPaths(start) {
    let parts = start.split('/').filter(Boolean);
    let out = [];
    for (let i = parts.length; i >= 0; i--) {
      if (parts[i - 1] === 'node_modules') continue;
      out.push('/' + [...parts.slice(0, i), 'node_modules'].join('/'));
    }
    return out;
  }
  function findPkgScope(dir) {
    let d = dir;
    for (;;) {
      let pkg = readPkg(d);
      if (pkg) return { dir: d, pkg };
      if (d === '/' || !d) return null;
      if (path.basename(d) === 'node_modules') return null;
      d = path.dirname(d);
    }
  }

  /**
   * @param {string} spec
   * @param {string} fromFile absolute path of the requiring file
   * @param {'require'|'import'} kind
   * @returns {{ builtin: string } | { file: string }}
   */
  function resolve(spec, fromFile, kind = 'require') {
    let b = isBuiltin(spec);
    if (b) return { builtin: b };
    if (spec.startsWith('node:')) throw new ResolveError(spec, fromFile, 'ERR_UNKNOWN_BUILTIN_MODULE', `No such built-in module: ${spec}`);
    let dir = path.dirname(fromFile);
    if (spec.startsWith('#')) {
      let scope = findPkgScope(dir);
      if (!scope?.pkg?.imports) throw new ResolveError(spec, fromFile, 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${spec}" is not defined`);
      let m = matchMap(scope.pkg.imports, spec);
      let r = m && resolveTarget(scope.dir, m.target, m.star, conditionsFor(kind));
      if (!r) throw new ResolveError(spec, fromFile, 'ERR_PACKAGE_IMPORT_NOT_DEFINED', `Package import specifier "${spec}" is not defined in ${scope.dir}/package.json`);
      if (typeof r === 'object') return resolve(r.bare, fromFile, kind);
      let file = loadAsFile(r);
      if (!file) throw new ResolveError(spec, fromFile);
      return { file: real(file) };
    }
    if (spec.startsWith('file://')) spec = decodeURIComponent(new URL(spec).pathname);
    if (spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
      let x = path.resolve(dir, spec);
      let file = loadAsFile(x) || loadAsDirectory(x);
      if (!file) throw new ResolveError(spec, fromFile);
      return { file: real(file) };
    }
    let segs = spec.split('/');
    let name = spec.startsWith('@') ? segs.slice(0, 2).join('/') : segs[0];
    let sub = spec.slice(name.length);
    // Self-reference by package name
    let scope = findPkgScope(dir);
    if (scope?.pkg?.name === name && scope.pkg.exports) return { file: real(resolveExports(scope.dir, scope.pkg.exports, '.' + sub, kind, spec, fromFile)) };
    for (let nm of nodeModulesPaths(dir)) {
      let pkgDir = path.join(nm, name);
      if (!host.isDir(pkgDir) && !host.isFile(pkgDir) && !loadAsFile(pkgDir)) continue;
      let pkg = host.isDir(pkgDir) ? readPkg(pkgDir) : null;
      if (pkg?.exports !== undefined && pkg.exports !== null) {
        let r = resolveExports(pkgDir, pkg.exports, '.' + sub, kind, spec, fromFile);
        if (typeof r === 'object') return resolve(r.bare, fromFile, kind);
        return { file: real(r) };
      }
      let x = path.join(nm, spec);
      let file = loadAsFile(x) || loadAsDirectory(x);
      if (file) return { file: real(file) };
    }
    throw new ResolveError(spec, fromFile);
  }

  return { resolve, readPkg, findPkgScope };
}

/* ---------- transforms ---------- */

let REQUIRE_RE = /(?:^|[^.\w$])require\s*\(\s*(['"`])([^'"`\n]+)\1\s*\)/g;
let ESM_HINT = /(^|[\s;{}()\]])(import\s*[\w{*'"(.$]|export\s|export\{)|\bimport\.meta\b/m;

function isTs(file) {
  return /\.(ts|mts|cts|tsx)$/.test(file);
}

function scanRequires(code) {
  let out = new Set();
  // Strip comments to avoid picking up commented-out requires.
  let stripped = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'`\\])\/\/[^\n]*/g, '$1');
  for (let m of stripped.matchAll(REQUIRE_RE)) out.add(m[2]);
  return [...out];
}

function moduleTypeFor(file, resolver, inputType) {
  if (/\.(mjs|mts)$/.test(file)) return 'module';
  if (/\.(cjs|cts)$/.test(file)) return 'commonjs';
  if (inputType) return inputType;
  let scope = resolver.findPkgScope(path.dirname(file));
  if (scope?.pkg?.type === 'module') return 'module';
  if (scope?.pkg?.type === 'commonjs') return 'commonjs';
  return null; // unknown: detect from syntax (Node 22 module detection)
}

function babelPlugins(flags) {
  let importMeta = ({ types: t }) => ({
    visitor: {
      MetaProperty(p) {
        if (p.node.meta.name === 'import' && p.node.property.name === 'meta') p.replaceWith(t.identifier('__importMeta'));
      },
    },
  });
  let tla = () => ({
    visitor: {
      AwaitExpression(p) {
        if (!p.getFunctionParent()) flags.tla = true;
      },
      ForOfStatement(p) {
        if (p.node.await && !p.getFunctionParent()) flags.tla = true;
      },
    },
  });
  let detect = () => ({
    visitor: {
      Program(p) {
        flags.esm = p.node.sourceType === 'module' && p.node.body.some((n) => /^(Import|Export)/.test(n.type));
      },
    },
  });
  return [detect, importMeta, tla, 'transform-dynamic-import', 'transform-modules-commonjs'];
}

/** Does this source need Babel (ESM syntax, TypeScript, import.meta)? */
export function needsTransform(file, source, type) {
  return isTs(file) || type === 'module' || /\.(mjs|mts)$/.test(file) || ESM_HINT.test(source);
}

/**
 * Synchronous transform for runtime require() of files outside the bundle.
 * Needs Babel already loaded (warm workers load it in the background).
 */
export function transformSync(file, source, type) {
  if (!babelReady) {
    throw Object.assign(new Error(`require() of ES module ${file} outside the bundle needs the transpiler, which is still loading; retry, or import it statically.`), { code: 'ERR_REQUIRE_ESM' });
  }
  let flags = { esm: false, tla: false };
  let out = babelReady.transform(source.replace(/^\uFEFF/, '').replace(/^#!/, '//'), {
    filename: file,
    sourceType: type === 'commonjs' ? 'script' : 'unambiguous',
    babelrc: false,
    configFile: false,
    retainLines: true,
    parserOpts: { allowReturnOutsideFunction: true },
    presets: isTs(file) ? [['typescript', { allExtensions: true }]] : [],
    plugins: babelPlugins(flags),
  });
  if (flags.tla) throw Object.assign(new Error(`require() cannot be used on an ES module with top-level await: ${file}`), { code: 'ERR_REQUIRE_ASYNC_MODULE' });
  return out.code;
}

/**
 * Turn one source file into a CommonJS function body.
 * @returns {{ code: string, esm: boolean, tla: boolean }}
 */
async function transformSource(file, source, { type, isEntry, forceBabel }) {
  let code = source.replace(/^﻿/, '');
  if (/\.json$/.test(file)) {
    try {
      JSON.parse(code);
    } catch (err) {
      throw Object.assign(new SyntaxError(`${file}: ${err.message}`), { code: 'ERR_INVALID_JSON' });
    }
    return { code: 'module.exports = ' + code + ';', esm: false, tla: false };
  }
  // unshebang
  if (code.startsWith('#!')) code = '//' + code.slice(2);
  let needBabel = forceBabel || isTs(file) || type === 'module' || ESM_HINT.test(code);
  if (!needBabel) return { code, esm: false, tla: false };
  let Babel = await loadBabel();
  let flags = { esm: false, tla: false };
  let opts = {
    filename: file,
    sourceType: type === 'module' ? 'module' : type === 'commonjs' ? 'script' : 'unambiguous',
    babelrc: false,
    configFile: false,
    compact: false,
    retainLines: true,
    comments: true,
    parserOpts: { allowAwaitOutsideFunction: !!isEntry, allowReturnOutsideFunction: type !== 'module', allowImportExportEverywhere: false },
    presets: isTs(file) ? [['typescript', { allExtensions: true, onlyRemoveTypeImports: false }]] : [],
    plugins: babelPlugins(flags),
  };
  try {
    let out = Babel.transform(code, opts);
    return { code: out.code, esm: flags.esm || type === 'module', tla: flags.tla };
  } catch (err) {
    let e = new SyntaxError(String(err.message || err).replace(/^\/?unknown: /, ''));
    e.code = 'ERR_SYNTAX';
    e.file = file;
    throw e;
  }
}

/* ---------- deps walk + pack ---------- */

/** Bump when transformSource's output changes, to invalidate cached transforms. */
let TRANSFORM_VERSION = 'v1';

function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36) + ':' + str.length;
}

/**
 * @param {object} o
 * @param {{ isFile, isDir, realpath?, readTextSync, readText }} o.host
 * @param {(id: string) => string|null} o.isBuiltin
 * @param {Array<{ file: string, source?: string, type?: 'module'|'commonjs', print?: boolean }>} o.entries main entry last
 * @param {string[]} [o.preload] -r specifiers (resolved from cwd)
 * @param {string[]} [o.imports] --import specifiers (resolved from cwd)
 * @param {string} o.cwd
 * @param {string[]} [o.conditions]
 * @param {string} [o.inputType] for virtual entries (-e / stdin)
 * @returns {Promise<{ body: string, files: string[], missing: Array<{spec, from, error}> }>}
 */
export async function bundle(o) {
  let resolver = createResolver({ host: o.host, isBuiltin: o.isBuiltin, conditions: o.conditions || [], preserveSymlinks: o.preserveSymlinks });
  let rows = new Map(); // file -> row
  let missing = [];
  let nextId = 1;
  let queue = [];

  function addRow(file, extra = {}) {
    if (rows.has(file)) return rows.get(file);
    let row = { id: nextId++, file, deps: {}, ...extra };
    rows.set(file, row);
    queue.push(row);
    return row;
  }

  let entryRows = [];
  let preloadRows = [];
  let importRows = [];
  let fake = path.join(o.cwd, '[preload]');
  for (let spec of o.preload || []) {
    let r = resolver.resolve(spec, fake, 'require');
    preloadRows.push(r.builtin ? { builtin: r.builtin } : addRow(r.file));
  }
  for (let spec of o.imports || []) {
    let r = resolver.resolve(spec, fake, 'import');
    importRows.push(r.builtin ? { builtin: r.builtin } : addRow(r.file, { entry: true }));
  }
  for (let e of o.entries) entryRows.push(addRow(e.file, { entry: true, virtualSource: e.source, virtualType: e.type }));

  while (queue.length) {
    let row = queue.shift();
    let type = row.virtualSource != null ? row.virtualType || null : moduleTypeFor(row.file, resolver, null);
    // Transform cache: file identity (size + mtime from the host) or a hash of virtual source.
    let id = row.virtualSource != null ? 'src:' + hash(row.virtualSource) : o.host.fileId?.(row.file);
    let key = id && o.transformCache ? `${TRANSFORM_VERSION}|${row.file}|${id}|${type}|${row.entry ? 1 : 0}` : null;
    let t = key ? await o.transformCache.get(key) : null;
    if (!t) {
      let source = row.virtualSource ?? (await o.host.readText(row.file));
      t = await transformSource(row.file, source, { type, isEntry: !!row.entry });
      if (key) o.transformCache.set(key, t);
    }
    row.code = t.code;
    row.async = !!row.entry || t.tla;
    row.esm = t.esm;
    let kind = t.esm ? 'import' : 'require';
    for (let spec of scanRequires(t.code)) {
      try {
        let r = resolver.resolve(spec, row.file, kind);
        if (r.builtin) row.deps[spec] = 'builtin:' + r.builtin;
        else row.deps[spec] = addRow(r.file).id;
      } catch (err) {
        if (!(err instanceof ResolveError)) throw err;
        // Lazy failure, like Node: only throws if this require actually runs.
        row.deps[spec] = { error: err.message, code: err.code };
        missing.push({ spec, from: row.file, error: err.message });
      }
    }
  }

  // Line map: bundle body line → (file, source line). Body line 1 is "return (…prelude…)({".
  let lineMap = [];
  let line = 1 + PRELUDE.split('\n').length; // first module starts on the line after "({"
  let modules = [...rows.values()]
    .map((r) => {
      let fn = `${r.async ? 'async ' : ''}function (require, module, exports, __filename, __dirname, __importMeta) {\n${r.code}\n}`;
      // The function header sits on `line`; source line 1 is the next line.
      lineMap.push({ start: line + 1, end: line + r.code.split('\n').length, file: r.file });
      line += fn.split('\n').length;
      return `${r.id}: [${fn}, ${JSON.stringify(r.deps)}, ${JSON.stringify(r.file)}, ${r.async ? 1 : 0}]`;
    })
    .join(',\n');
  let plan = {
    preload: preloadRows.map((r) => (r.builtin ? 'builtin:' + r.builtin : r.id)),
    imports: importRows.map((r) => (r.builtin ? 'builtin:' + r.builtin : r.id)),
    main: entryRows.map((r) => r.id),
  };
  let body = `return (${PRELUDE})({\n${modules}\n}, ${JSON.stringify(plan)}, __builtin, typeof __dynamic === 'object' && __dynamic ? __dynamic : null);`;
  return { body, files: [...rows.keys()], missing, lineMap };
}

/**
 * browser-pack's prelude, made async-aware. Runs inside the AsyncFunction.
 * Returns the main entry's { exports, result } so callers (-p, library loads)
 * can use them.
 */
let PRELUDE = String.raw`async function (modules, plan, builtin, dynamic) {
  let cache = Object.create(null);
  let byFile = Object.create(null);
  for (let id in modules) byFile[modules[id][2]] = id;
  let dirname = (f) => f.slice(0, f.lastIndexOf('/')) || '/';
  let notFound = (spec, from, msg, code) => {
    let e = new Error(msg || ("Cannot find module '" + spec + "'" + (from ? '\nRequire stack:\n- ' + from : '')));
    e.code = code || 'MODULE_NOT_FOUND';
    e.requireStack = from ? [from] : [];
    return e;
  };
  let asyncErr = (file) => {
    let e = new Error('require() cannot be used on an ESM graph with top-level await. Use import() instead. To see where the top-level await comes from, use --experimental-print-required-tla.\n  From ' + file);
    e.code = 'ERR_REQUIRE_ASYNC_MODULE';
    return e;
  };
  let requireCache = new Proxy(Object.create(null), {
    get: (t, k) => { let id = byFile[k]; return id && cache[id] ? cache[id] : undefined; },
    has: (t, k) => !!(byFile[k] && cache[byFile[k]]),
    deleteProperty: (t, k) => { let id = byFile[k]; if (id) delete cache[id]; return true; },
    ownKeys: () => Object.keys(cache).map((id) => modules[id][2]),
    getOwnPropertyDescriptor: (t, k) => byFile[k] && cache[byFile[k]] ? { value: cache[byFile[k]], enumerable: true, configurable: true } : undefined,
  });
  let mainModule = null;
  class Module {
    constructor(id, filename, parent) {
      this.id = id;
      this.filename = filename;
      this.path = dirname(filename);
      this.exports = {};
      this.loaded = false;
      this.children = [];
      this.parent = parent || null;
      this.paths = [];
      if (parent) parent.children.push(this);
    }
    require(spec) { return this._req(spec); }
  }
  function target(fromId, spec) {
    let deps = fromId != null && modules[fromId] ? modules[fromId][1] : {};
    if (Object.prototype.hasOwnProperty.call(deps, spec)) return deps[spec];
    let b = builtin(spec);
    if (b !== undefined) return 'builtin:' + spec;
    // Runtime-computed specifiers: match an already-bundled file.
    if (/^\.{0,2}\//.test(spec) && fromId != null) {
      let base = spec.startsWith('/') ? spec : (dirname(modules[fromId][2]) + '/' + spec);
      let parts = [];
      for (let p of base.split('/')) { if (p === '..') parts.pop(); else if (p && p !== '.') parts.push(p); }
      let abs = '/' + parts.join('/');
      for (let c of [abs, abs + '.js', abs + '.json', abs + '.mjs', abs + '.cjs', abs + '/index.js']) if (byFile[c]) return +byFile[c];
    }
    return { error: null };
  }
  function makeRequire(fromId, mod) {
    let from = fromId != null && modules[fromId] ? modules[fromId][2] : null;
    let req = function require(spec) {
      if (typeof spec !== 'string') { let e = new TypeError('The "id" argument must be of type string. Received ' + typeof spec); e.code = 'ERR_INVALID_ARG_TYPE'; throw e; }
      let t = target(fromId, spec);
      if (typeof t === 'string' && t.startsWith('builtin:')) {
        let m = builtin(t.slice(8));
        if (m === undefined) throw notFound(spec, from);
        return m;
      }
      if (typeof t === 'object') {
        // Not in the bundle (computed path, generated file, …): load it from disk at runtime.
        if (dynamic) return dynamic.require(spec, from || '/');
        throw notFound(spec, from, t.error, t.code);
      }
      return load(t, mod);
    };
    req.resolve = (spec) => {
      let t = target(fromId, spec);
      if (typeof t === 'string') return t.slice(8);
      if (typeof t === 'object') {
        if (dynamic) return dynamic.resolve(spec, from || '/');
        throw notFound(spec, from, t.error, t.code);
      }
      return modules[t][2];
    };
    req.resolve.paths = (spec) => (/^[./]/.test(spec) ? null : []);
    req.cache = requireCache;
    req.extensions = { '.js': null, '.json': null, '.node': null };
    Object.defineProperty(req, 'main', { get: () => mainModule });
    return req;
  }
  function meta(id) {
    let file = modules[id][2];
    let url = 'file://' + encodeURI(file);
    let req = makeRequire(id, null);
    return { url, filename: file, dirname: dirname(file), resolve: (s) => { let r = req.resolve(s); return r.startsWith('/') ? 'file://' + encodeURI(r) : 'node:' + r.replace(/^node:/, ''); }, main: plan.main.includes(+id) };
  }
  function instantiate(id, parent) {
    let file = modules[id][2];
    let isMain = plan.main.includes(+id);
    let m = new Module(isMain ? '.' : file, file, parent);
    if (isMain) mainModule = m;
    m._req = makeRequire(id, m);
    m.require = m._req;
    cache[id] = m;
    return m;
  }
  function load(id, parent) {
    let m = cache[id];
    if (m) {
      if (m.__pending) throw asyncErr(modules[id][2]);
      return m.exports;
    }
    let [fn, , file, isAsync] = modules[id];
    if (isAsync) throw asyncErr(file);
    m = instantiate(id, parent);
    try {
      fn.call(m.exports, m._req, m, m.exports, file, dirname(file), meta(id));
    } catch (e) {
      delete cache[id];
      throw e;
    }
    m.loaded = true;
    return m.exports;
  }
  async function evaluate(id, parent) {
    let m = cache[id];
    if (m) return m;
    let [fn, , file] = modules[id];
    m = instantiate(id, parent);
    m.__pending = true;
    let result;
    try {
      result = await fn.call(m.exports, m._req, m, m.exports, file, dirname(file), meta(id));
    } finally {
      m.__pending = false;
    }
    m.loaded = true;
    m.result = result;
    return m;
  }
  // ESM semantics: async (top-level await) dependencies settle before importers run.
  async function prepare(id, seen) {
    if (seen.has(id)) return;
    seen.add(id);
    for (let t of Object.values(modules[id][1])) if (typeof t === 'number') await prepare(t, seen);
    if (modules[id][3] && !plan.main.includes(+id) && !cache[id]) await evaluate(id, null);
  }
  let seen = new Set();
  for (let p of plan.preload) {
    if (typeof p === 'string') builtin(p.slice(8));
    else { await prepare(p, seen); if (modules[p][3]) await evaluate(p, null); else load(p, null); }
  }
  for (let p of plan.imports) {
    if (typeof p === 'string') builtin(p.slice(8));
    else { await prepare(p, seen); await evaluate(p, null); }
  }
  let last = null;
  for (let id of plan.main) {
    await prepare(id, seen);
    last = await evaluate(id, null);
  }
  return { exports: last && last.exports, result: last && last.result, module: last };
}`;
