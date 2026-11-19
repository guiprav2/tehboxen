#!/usr/bin/env node
/**
 * Tehboxen debug bridge: Express + WebSocket for the browser client,
 * host-filesystem RPC + NDJSON event log for the agent harness.
 *
 * Layout (default: <project>/.tehboxen-dbg/):
 *   meta.json          port, pid, token, clientConnected, startedAt
 *   events.ndjson      append-only event stream
 *   rpc/req-<id>.json  agent → server → browser
 *   rpc/res-<id>.json  browser → server → agent
 *
 * Usage:
 *   node bin/dbgserver.js
 *   node bin/dbgserver.js --port 8766 --dir .tehboxen-dbg
 */
import express from 'express';
import multer from 'multer';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import http from 'node:http';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

let __dirname = path.dirname(fileURLToPath(import.meta.url));
let PROJECT_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  let out = { port: 8766, dir: path.join(PROJECT_ROOT, '.tehboxen-dbg'), host: '127.0.0.1' };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || out.port;
    else if (a === '--dir' || a === '-d') out.dir = path.resolve(argv[++i]);
    else if (a === '--host') out.host = argv[++i] || out.host;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Tehboxen dbgserver

  node bin/dbgserver.js [--port 8766] [--dir .tehboxen-dbg] [--host 127.0.0.1]

Agent RPC: write rpc/req-<id>.json, wait for rpc/res-<id>.json.
Events:   append-only events.ndjson
Browser:  ws://<host>:<port>/tehboxen
  Auth is bind-to-loopback + Origin allowlist (*.localhost / localhost).
  meta.json still has a token for optional agent HTTP calls; it is not a secret
  from other local processes — anything on this machine can reach 127.0.0.1.
`);
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function writeJsonAtomic(file, obj) {
  let tmp = file + '.tmp.' + process.pid;
  let body = JSON.stringify(obj, null, 2) + '\n';
  await fs.writeFile(tmp, body, 'utf8');
  await fs.rename(tmp, file);
}

async function appendNdjson(file, obj) {
  let line = JSON.stringify(obj) + '\n';
  await fs.appendFile(file, line, 'utf8');
}

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

function newId() {
  return crypto.randomUUID();
}

async function main() {
  let opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    process.exit(0);
  }

  let dbgDir = opts.dir;
  let rpcDir = path.join(dbgDir, 'rpc');
  let xferDir = path.join(dbgDir, 'xfer');
  let metaPath = path.join(dbgDir, 'meta.json');
  let eventsPath = path.join(dbgDir, 'events.ndjson');

  await ensureDir(rpcDir);
  await ensureDir(xferDir);

  // Clear stale in-flight RPC files from a previous run.
  for (let name of await fs.readdir(rpcDir)) {
    if (/^req-.*\.json$/.test(name) || /^res-.*\.json$/.test(name)) {
      await fs.unlink(path.join(rpcDir, name)).catch(() => {});
    }
  }

  let token = randomToken();
  let meta = {
    port: opts.port,
    host: opts.host,
    pid: process.pid,
    token,
    clientConnected: false,
    startedAt: new Date().toISOString(),
    wsPath: '/tehboxen',
    dbgDir,
  };
  await writeJsonAtomic(metaPath, meta);
  if (!fssync.existsSync(eventsPath)) {
    await fs.writeFile(eventsPath, '', 'utf8');
  }

  async function emit(type, fields = {}) {
    let ev = { ts: Date.now(), type, ...fields };
    await appendNdjson(eventsPath, ev);
    return ev;
  }

  await emit('server', { op: 'start', port: opts.port, pid: process.pid });

  /** @type {Set<import('ws').WebSocket>} */
  let clients = new Set();
  /** Most recently connected open socket — RPC target. */
  /** @type {import('ws').WebSocket | null} */
  let primary = null;
  /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  let pending = new Map();

  function refreshClientMeta() {
    for (let c of [...clients]) {
      if (c.readyState !== 1) clients.delete(c);
    }
    if (primary && primary.readyState !== 1) primary = null;
    if (!primary) {
      for (let c of clients) {
        if (c.readyState === 1) {
          primary = c;
          break;
        }
      }
    }
    meta.clientConnected = clients.size > 0;
    meta.clientCount = clients.size;
    writeJsonAtomic(metaPath, meta).catch(() => {});
  }

  function addClient(ws) {
    clients.add(ws);
    primary = ws;
    refreshClientMeta();
  }

  function removeClient(ws) {
    clients.delete(ws);
    if (primary === ws) primary = null;
    refreshClientMeta();
  }

  function isLoopbackAddress(addr) {
    return (
      addr === '127.0.0.1' ||
      addr === '::1' ||
      addr === '::ffff:127.0.0.1'
    );
  }

  function checkToken(reqToken) {
    return typeof reqToken === 'string' && reqToken.length > 0 && reqToken === token;
  }

  /** Agent HTTP: loopback TCP is enough; token optional. */
  function allowAgentHttp(req) {
    if (isLoopbackAddress(req.socket?.remoteAddress || '')) return true;
    return checkToken(tokenFromReq(req));
  }

  /**
   * Browser WS: peer must be loopback, and Origin (if present) must look like
   * the local Webfoundry IDE (localhost / *.localhost / 127.0.0.1).
   */
  function allowBrowserWs(req) {
    if (!isLoopbackAddress(req.socket?.remoteAddress || '')) return false;
    let origin = req.headers.origin;
    if (!origin) return true; // non-browser (agent probe, etc.)
    try {
      let u = new URL(origin);
      let host = u.hostname;
      if (host === 'localhost' || host === '127.0.0.1') return true;
      if (host.endsWith('.localhost')) return true;
      return false;
    } catch {
      return false;
    }
  }

  async function sendToClient(msg) {
    refreshClientMeta();
    if (!primary || primary.readyState !== 1) {
      let err = new Error('no_client');
      err.code = 'no_client';
      throw err;
    }
    primary.send(JSON.stringify(msg));
  }

  /** Direct in-process RPC to the browser client (used by /vfs/upload|download). */
  function callClientRpc({ op, user = null, args = {}, timeoutMs = 60000 }) {
    let id = newId();
    let ms = Math.min(Math.max(Number(timeoutMs) || 60000, 1000), 600000);
    return new Promise((resolve, reject) => {
      let timer = setTimeout(() => {
        pending.delete(id);
        let err = new Error('timeout');
        err.code = 'timeout';
        reject(err);
      }, ms);
      pending.set(id, { resolve, reject, timer });
      sendToClient({
        type: 'rpc',
        id,
        op,
        user,
        args,
        timeoutMs: ms,
      }).catch((err) => {
        clearTimeout(timer);
        pending.delete(id);
        reject(err);
      });
    });
  }

  function safeXferPath(xferId, rel = '') {
    let id = String(xferId || '');
    if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
      throw Object.assign(new Error('invalid xfer id'), { code: 'EINVAL' });
    }
    let base = path.resolve(xferDir, id);
    let cleaned = String(rel || '')
      .replace(/^\/+/, '')
      .split('/')
      .filter((p) => p && p !== '.' && p !== '..')
      .join('/');
    let full = cleaned ? path.resolve(base, cleaned) : base;
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw Object.assign(new Error('xfer path escape'), { code: 'EINVAL' });
    }
    return { base, full, rel: cleaned };
  }

  async function rmXfer(xferId) {
    try {
      await fs.rm(path.join(xferDir, String(xferId)), { recursive: true, force: true });
    } catch {}
  }

  async function handleRpcRequest(filePath) {
    let base = path.basename(filePath);
    let m = /^req-(.+)\.json$/.exec(base);
    if (!m) return;
    let id = m[1];
    let resPath = path.join(rpcDir, `res-${id}.json`);

    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }

    let req;
    try {
      req = JSON.parse(raw);
    } catch (err) {
      await writeJsonAtomic(resPath, {
        id,
        ok: false,
        result: null,
        error: 'invalid_json: ' + err.message,
        ts: Date.now(),
      });
      await emit('rpc', { op: 'done', id, ok: false, error: 'invalid_json' });
      return;
    }

    if (!req.id) req.id = id;
    let timeoutMs = Math.min(Math.max(Number(req.timeoutMs) || 15000, 1000), 120000);

    await emit('rpc', { op: 'request', id, method: req.op || req.method });

    refreshClientMeta();
    if (!primary || primary.readyState !== 1) {
      await writeJsonAtomic(resPath, {
        id,
        ok: false,
        result: null,
        error: 'no_client',
        ts: Date.now(),
      });
      await emit('rpc', { op: 'done', id, ok: false, error: 'no_client' });
      return;
    }

    try {
      let result = await new Promise((resolve, reject) => {
        let timer = setTimeout(() => {
          pending.delete(id);
          let err = new Error('timeout');
          err.code = 'timeout';
          reject(err);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        sendToClient({
          type: 'rpc',
          id,
          op: req.op || req.method,
          user: req.user ?? req.args?.user ?? null,
          box: req.box ?? req.args?.box ?? null,
          args: req.args || {},
          timeoutMs,
        }).catch((err) => {
          clearTimeout(timer);
          pending.delete(id);
          reject(err);
        });
      });
      await writeJsonAtomic(resPath, {
        id,
        ok: true,
        result,
        error: null,
        ts: Date.now(),
      });
      await emit('rpc', { op: 'done', id, ok: true });
    } catch (err) {
      await writeJsonAtomic(resPath, {
        id,
        ok: false,
        result: null,
        error: err.code || err.message || String(err),
        ts: Date.now(),
      });
      await emit('rpc', { op: 'done', id, ok: false, error: err.code || err.message });
    }
  }

  let app = express();
  app.use(express.json({ limit: '2mb' }));

  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Tehboxen-Token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    // Chrome Private Network Access: page on localhost → 127.0.0.1
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  function tokenFromReq(req) {
    let h = req.get('x-tehboxen-token') || req.get('authorization') || '';
    if (h.toLowerCase().startsWith('bearer ')) h = h.slice(7);
    return req.query.token || h || req.body?.token || '';
  }

  app.get('/health', (req, res) => {
    refreshClientMeta();
    // No token here — loopback bind is the boundary; exposing a "secret" over
    // /health to every local caller would be security theater.
    res.json({
      ok: true,
      clientConnected: clients.size > 0,
      clientCount: clients.size,
      port: opts.port,
      pid: process.pid,
      wsUrl: `ws://${opts.host}:${opts.port}/tehboxen`,
    });
  });

  // Fire-and-forget boot ping from dbgclient (proves the browser module ran).
  app.all('/beacon', async (req, res) => {
    let stage = req.query.stage || req.body?.stage || 'boot';
    await emit('beacon', {
      stage: String(stage),
      remote: req.socket?.remoteAddress || '',
      origin: req.get('origin') || '',
    });
    res.json({ ok: true });
  });

  app.get('/meta', (req, res) => {
    if (!allowAgentHttp(req)) return res.status(401).json({ error: 'unauthorized' });
    refreshClientMeta();
    res.json({
      ...meta,
      clientConnected: clients.size > 0,
      clientCount: clients.size,
    });
  });

  app.get('/events', async (req, res) => {
    if (!allowAgentHttp(req)) return res.status(401).json({ error: 'unauthorized' });
    let since = Number(req.query.since) || 0;
    try {
      let text = await fs.readFile(eventsPath, 'utf8');
      let lines = text.split('\n').filter(Boolean);
      let out = [];
      for (let line of lines) {
        try {
          let ev = JSON.parse(line);
          if (!since || (ev.ts && ev.ts >= since)) out.push(ev);
        } catch {}
      }
      res.json({ events: out });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  app.post('/rpc', async (req, res) => {
    if (!allowAgentHttp(req)) return res.status(401).json({ error: 'unauthorized' });
    let id = req.body?.id || newId();
    let payload = {
      id,
      op: req.body?.op || req.body?.method || 'ping',
      user: req.body?.user ?? null,
      // Which machine: omitted/'local' = the player's box, 'root' = the root computer, or any /world/boxes id.
      box: req.body?.box ?? null,
      args: req.body?.args || {},
      timeoutMs: req.body?.timeoutMs || 15000,
      ts: Date.now(),
    };
    let reqPath = path.join(rpcDir, `req-${id}.json`);
    let resPath = path.join(rpcDir, `res-${id}.json`);
    await writeJsonAtomic(reqPath, payload);

    let deadline = Date.now() + (payload.timeoutMs + 2000);
    while (Date.now() < deadline) {
      try {
        let raw = await fs.readFile(resPath, 'utf8');
        let parsed = JSON.parse(raw);
        return res.json(parsed);
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    res.status(504).json({ id, ok: false, error: 'timeout', result: null, ts: Date.now() });
  });

  // ---- scp-like VFS transfer (host ↔ browser VFS via staging + client RPC) ----

  let upload = multer({
    storage: multer.diskStorage({
      destination: async (req, file, cb) => {
        try {
          if (!req._xferId) {
            req._xferId = newId();
            await ensureDir(path.join(xferDir, req._xferId));
          }
          cb(null, path.join(xferDir, req._xferId));
        } catch (err) {
          cb(err);
        }
      },
      filename: (req, file, cb) => {
        // Preserve relative paths from CLI (foo/bar.txt); flatten unsafe bits.
        let rel = String(file.originalname || 'file')
          .replace(/^\/+/, '')
          .split('/')
          .filter((p) => p && p !== '.' && p !== '..')
          .join('/');
        if (!rel) rel = 'file';
        // multer writes flat names; we recreate dirs in a fixup pass via file path
        req._xferRels = req._xferRels || [];
        let safeFlat = rel.replace(/\//g, '__');
        req._xferRels.push({ flat: safeFlat, rel });
        cb(null, safeFlat);
      },
    }),
    limits: { fileSize: 256 * 1024 * 1024, files: 5000 },
  });

  /**
   * GET/PUT /xfer/:id/... — browser pulls staged uploads / pushes download bytes.
   * Special name __file__ = single-file transfer (empty rel).
   */
  function parseXferUrl(reqPath) {
    let m = /^\/xfer\/([^/]+)\/(.*)$/.exec(reqPath);
    if (!m) return null;
    return { id: decodeURIComponent(m[1]), rel: decodeURIComponent(m[2] || '') };
  }

  app.get(/^\/xfer\/[^/]+\/.*/, async (req, res) => {
    // Browser may call from preview origin; allow loopback like WS.
    if (!isLoopbackAddress(req.socket?.remoteAddress || '') && !allowAgentHttp(req)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      let parsed = parseXferUrl(req.path);
      if (!parsed) return res.status(404).json({ error: 'not found' });
      let rel = parsed.rel === '__file__' ? '' : parsed.rel;
      let { base, full } = safeXferPath(parsed.id, rel);
      let candidate = full;
      if (rel && !(await fs.stat(candidate).catch(() => null))) {
        candidate = path.join(base, rel.replace(/\//g, '__'));
      }
      if (!rel) {
        candidate = path.join(base, '__file__');
        if (!(await fs.stat(candidate).catch(() => null))) {
          let names = await fs.readdir(base);
          let only = names.filter((n) => n !== '.' && n !== '..');
          if (only.length === 1) candidate = path.join(base, only[0]);
        }
      }
      let st = await fs.stat(candidate);
      if (!st.isFile()) throw new Error('not a file');
      let data = await fs.readFile(candidate);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(data.length));
      res.end(data);
    } catch (err) {
      res.status(404).json({ error: String(err.message || err), path: req.path });
    }
  });

  app.put(/^\/xfer\/[^/]+\/.*/, express.raw({ type: '*/*', limit: '256mb' }), async (req, res) => {
    if (!isLoopbackAddress(req.socket?.remoteAddress || '') && !allowAgentHttp(req)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      let parsed = parseXferUrl(req.path);
      if (!parsed) return res.status(404).json({ error: 'not found' });
      let rel = parsed.rel === '__file__' ? '__file__' : parsed.rel;
      let { base, full } = safeXferPath(parsed.id, rel);
      await ensureDir(base);
      await ensureDir(path.dirname(full));
      let body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || []);
      await fs.writeFile(full, body);
      res.json({ ok: true, bytes: body.length, path: rel });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  /**
   * POST /vfs/upload  multipart: path, user?, recursive?
   *   files: one or many (field "file" or "files")
   * Stages on host, asks browser vfs.put, returns written paths.
   */
  app.post('/vfs/upload', (req, res) => {
    if (!allowAgentHttp(req)) return res.status(401).json({ error: 'unauthorized' });
    upload.any()(req, res, async (err) => {
      if (err) return res.status(400).json({ error: String(err.message || err) });
      let xferId = req._xferId;
      let dest = String(req.body?.path || req.body?.dest || '').replace(/^\/+/, '');
      let user = req.body?.user || 'root';
      let recursive = String(req.body?.recursive || '') === '1' || req.body?.recursive === true;
      if (!dest) {
        if (xferId) await rmXfer(xferId);
        return res.status(400).json({ error: 'path required' });
      }
      if (!req.files?.length) {
        if (xferId) await rmXfer(xferId);
        return res.status(400).json({ error: 'no files' });
      }
      try {
        // Prefer explicit rels[] from CLI (multipart filenames often drop directories).
        let bodyRels = req.body?.rels;
        let relList = Array.isArray(bodyRels)
          ? bodyRels
          : bodyRels != null && bodyRels !== ''
            ? [bodyRels]
            : [];
        let relMap = new Map((req._xferRels || []).map((x) => [x.flat, x.rel]));
        let base = path.join(xferDir, xferId);
        let entries = [];
        for (let i = 0; i < req.files.length; i++) {
          let f = req.files[i];
          let rel =
            (relList[i] != null && String(relList[i])) ||
            relMap.get(f.filename) ||
            f.originalname ||
            f.filename;
          rel = String(rel)
            .replace(/^\/+/, '')
            .split('/')
            .filter((p) => p && p !== '.' && p !== '..')
            .join('/');
          let nested = path.join(base, rel);
          if (path.resolve(nested) !== path.resolve(f.path)) {
            await ensureDir(path.dirname(nested));
            await fs.rename(f.path, nested).catch(async () => {
              await fs.copyFile(f.path, nested);
              await fs.unlink(f.path).catch(() => {});
            });
          }
          entries.push({
            rel: recursive || req.files.length > 1 ? rel : '',
            contentType: f.mimetype || 'application/octet-stream',
            size: f.size,
          });
        }
        // Single-file non-recursive: expose as __file__ for client
        if (entries.length === 1 && !entries[0].rel) {
          let only = path.join(base, relList[0] || (req._xferRels || [])[0]?.rel || req.files[0].filename);
          // also copy/link to __file__
          let asFile = path.join(base, '__file__');
          if (path.resolve(only) !== path.resolve(asFile)) {
            await fs.copyFile(only, asFile).catch(async () => {
              // maybe already nested empty rel
              let names = await fs.readdir(base);
              let first = names.find((n) => n !== '__file__');
              if (first) await fs.copyFile(path.join(base, first), asFile);
            });
          }
          entries = [{ rel: '', contentType: entries[0].contentType, size: entries[0].size }];
        }

        let baseUrl = `http://${opts.host}:${opts.port}`;
        let result = await callClientRpc({
          op: 'vfs.put',
          user,
          timeoutMs: Number(req.body?.timeoutMs) || 120000,
          args: { dest, xferId, baseUrl, entries, recursive },
        });
        await emit('xfer', { op: 'upload', xferId, dest, user, count: entries.length });
        res.json({ ok: true, xferId, dest, user, result });
      } catch (e) {
        res.status(e.code === 'no_client' ? 503 : 500).json({
          ok: false,
          error: e.message || e.code || String(e),
          code: e.code,
        });
      } finally {
        // Keep staging briefly for debugging; prune
        setTimeout(() => rmXfer(xferId), 60_000).unref?.();
      }
    });
  });

  /**
   * GET /vfs/download?path=&user=&recursive=0|1
   * Asks browser vfs.get (base64 over WS — avoids browser→loopback PUT / PNA).
   * Server writes staging under xfer/, then streams a single file or returns a
   * manifest + /xfer/ URLs for recursive downloads.
   */
  app.get('/vfs/download', async (req, res) => {
    if (!allowAgentHttp(req)) return res.status(401).json({ error: 'unauthorized' });
    let vfsPath = String(req.query.path || '').replace(/^\/+/, '');
    let user = String(req.query.user || 'root');
    let recursive =
      String(req.query.recursive || '') === '1' || String(req.query.recursive || '') === 'true';
    if (!vfsPath) return res.status(400).json({ error: 'path required' });
    let xferId = newId();
    let xferBase = path.join(xferDir, xferId);
    await ensureDir(xferBase);
    try {
      let baseUrl = `http://${opts.host}:${opts.port}`;
      let result = await callClientRpc({
        op: 'vfs.get',
        user,
        timeoutMs: Number(req.query.timeoutMs) || 120000,
        args: { path: vfsPath, recursive },
      });

      // Materialize base64 payloads onto host staging (CLI fetches /xfer/…).
      let staged = [];
      for (let f of result?.files || []) {
        if (typeof f.data !== 'string') {
          throw Object.assign(new Error('vfs.get missing base64 data for ' + (f.rel || f.path)), {
            code: 'EIO',
          });
        }
        let buf = Buffer.from(f.data, 'base64');
        let diskRel = f.single ? '__file__' : String(f.rel || 'file')
          .replace(/^\/+/, '')
          .split('/')
          .filter((p) => p && p !== '.' && p !== '..')
          .join('/');
        if (!diskRel) diskRel = '__file__';
        let { full } = safeXferPath(xferId, diskRel);
        await ensureDir(path.dirname(full));
        await fs.writeFile(full, buf);
        staged.push({
          rel: f.rel,
          size: buf.length,
          type: f.type || 'application/octet-stream',
          single: !!f.single,
          diskRel,
        });
      }

      await emit('xfer', {
        op: 'download',
        xferId,
        path: vfsPath,
        user,
        count: staged.length,
      });

      if (!recursive && staged.length === 1 && staged[0].single) {
        let filePath = path.join(xferBase, '__file__');
        let st = await fs.stat(filePath);
        res.setHeader('Content-Type', staged[0].type || 'application/octet-stream');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="${path.basename(vfsPath).replace(/"/g, '')}"`,
        );
        res.setHeader('Content-Length', String(st.size));
        res.setHeader('X-Tehboxen-Xfer-Id', xferId);
        fssync.createReadStream(filePath).pipe(res).on('close', () => {
          setTimeout(() => rmXfer(xferId), 30_000).unref?.();
        });
        return;
      }

      res.json({
        ok: true,
        xferId,
        path: vfsPath,
        user,
        recursive,
        baseUrl,
        files: staged.map((f) => ({
          rel: f.rel,
          size: f.size,
          type: f.type,
          url: `${baseUrl}/xfer/${xferId}/${f.single ? '__file__' : f.diskRel.split('/').map(encodeURIComponent).join('/')}`,
        })),
        count: staged.length,
      });
      setTimeout(() => rmXfer(xferId), 5 * 60_000).unref?.();
    } catch (e) {
      await rmXfer(xferId);
      res.status(e.code === 'no_client' ? 503 : 500).json({
        ok: false,
        error: e.message || e.code || String(e),
        code: e.code,
      });
    }
  });

  let server = http.createServer(app);

  // Watch the directory (not a glob): chokidar v6 + some FS setups miss
  // glob-only watches, so filter req-*.json by basename instead.
  let watcher = chokidar.watch(rpcDir, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 40, pollInterval: 20 },
    depth: 0,
  });

  let onRpcFile = (filePath) => {
    if (!/^req-.+\.json$/.test(path.basename(filePath))) return;
    handleRpcRequest(filePath).catch((err) => {
      console.error('[dbgserver] rpc handle error', err);
    });
  };
  watcher.on('add', onRpcFile);
  watcher.on('change', onRpcFile);

  /** @type {import('ws').WebSocketServer | null} */
  let wss = null;

  function printAddrInUse() {
    console.error(
      `[dbgserver] port ${opts.port} is already in use on ${opts.host}.`,
    );
    console.error(`[dbgserver] another dbgserver is probably still running. Try:`);
    console.error(`  curl -s http://127.0.0.1:${opts.port}/health`);
    console.error(`  npm run dbgserver:restart`);
    console.error(`  # or: fuser -k ${opts.port}/tcp`);
  }

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      printAddrInUse();
      process.exit(1);
    }
    console.error('[dbgserver] server error', err);
    process.exit(1);
  });

  await new Promise((resolve, reject) => {
    server.listen(opts.port, opts.host, resolve);
    server.once('error', reject);
  }).catch((err) => {
    if (err && err.code === 'EADDRINUSE') printAddrInUse();
    else console.error('[dbgserver] listen failed', err);
    process.exit(1);
  });

  // Attach WS only after the port is ours, so bind errors stay on `server`.
  wss = new WebSocketServer({ server, path: '/tehboxen' });
  wss.on('error', (err) => {
    console.error('[dbgserver] ws error', err);
  });

  wss.on('connection', (ws, req) => {
    if (!allowBrowserWs(req)) {
      ws.close(4001, 'unauthorized');
      return;
    }

    // Keep every client — do not kick the previous one. Preview iframes and
    // parallel connect races used to fight over a single slot and flap forever.
    addClient(ws);
    emit('client', { op: 'connect', clientCount: clients.size }).catch(() => {});
    ws.send(JSON.stringify({ type: 'hello', ts: Date.now() }));

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }

      if (msg.type === 'vfs' || msg.type === 'event') {
        await emit(msg.type === 'vfs' ? 'vfs' : msg.eventType || 'event', {
          op: msg.op || msg.event?.type,
          path: msg.path || msg.event?.path,
          ...(msg.extra || {}),
        });
        return;
      }

      if (msg.type === 'rpc_result' || msg.type === 'rpc_error') {
        let id = msg.id;
        let entry = pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(id);
        if (msg.type === 'rpc_error') {
          let err = new Error(msg.error || 'rpc_error');
          err.code = msg.errno || msg.error || 'rpc_error';
          entry.reject(err);
        } else {
          entry.resolve(msg.result);
        }
      }
    });

    ws.on('close', () => {
      let wasPrimary = primary === ws;
      removeClient(ws);
      emit('client', { op: 'disconnect', clientCount: clients.size }).catch(() => {});
      if (wasPrimary && clients.size === 0) {
        for (let [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(Object.assign(new Error('client_gone'), { code: 'client_gone' }));
          pending.delete(id);
        }
      }
    });

    ws.on('error', () => {});
  });

  console.log(`[dbgserver] listening on http://${opts.host}:${opts.port}`);
  console.log(`[dbgserver] ws://${opts.host}:${opts.port}/tehboxen`);
  console.log(`[dbgserver] dbg dir: ${dbgDir}`);
  console.log(`[dbgserver] meta: ${metaPath}`);
  console.log(`[dbgserver] auth: loopback + Origin *.localhost/localhost (token in meta.json is optional for agents)`);

  async function shutdown() {
    await emit('server', { op: 'stop' });
    try {
      watcher.close();
    } catch {}
    try {
      wss?.close();
    } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[dbgserver] fatal', err);
  process.exit(1);
});
