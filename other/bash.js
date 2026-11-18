/**
 * bash: the interactive shell program (line editing, history, completion,
 * prompt) on a terminal, around a boxsh interpreter (shell.js).
 *
 * The Terminal app is only chrome: it hosts xterm and runs
 * `startInteractiveBash({ term })`, closing its window when the session ends
 * (`exit`, or Ctrl-D on an empty line). Running `bash` with no script inside a
 * session starts a nested session on the same terminal (shell.js cmdBash), so
 * `exit` there returns to the outer one, like the real thing.
 *
 * `term` is an xterm.js Terminal (write, writeln, onData, clear, cols, rows,
 * getSelection); input arrives as terminal bytes through term.onData.
 */

/** Display path for PS1: `/`, `~`, `~/…`, or `/abs`. */
function promptPath(cwd, home) {
  let path = String(cwd || '').replace(/^\/+|\/+$/g, '');
  if (!path) return '/';
  if (path === home) return '~';
  if (path.startsWith(home + '/')) return '~/' + path.slice(home.length + 1);
  return '/' + path;
}

/** Expand a subset of bash PS1 escapes. */
function renderPs1(ps1, cwdLabel, env, user) {
  let out = '';
  let s = String(ps1 ?? '');
  for (let i = 0; i < s.length; i++) {
    let ch = s[i];
    if (ch !== '\\' || i === s.length - 1) {
      out += ch;
      continue;
    }
    let next = s[++i];
    if (next === 'w') out += cwdLabel;
    else if (next === 'W') out += cwdLabel === '/' || cwdLabel === '~' ? cwdLabel : cwdLabel.split('/').pop();
    else if (next === 'u') out += env.USER || user;
    else if (next === 'h' || next === 'H') out += env.HOSTNAME || 'tehboxen';
    else if (next === '$') out += '$';
    else if (next === 'n') out += '\n';
    else if (next === 'e' || next === 'E') out += '\x1b';
    else if (next === '0' && s.slice(i, i + 3) === '033') {
      out += '\x1b';
      i += 2;
    } else if (next === '[' || next === ']') {
      // non-printing span markers — omit
    } else if (next === '\\') out += '\\';
    else if (next === 'a') out += '\x07';
    else out += next;
  }
  // Also allow literal \e / \033 sequences left in the string from boxshrc
  return out.replace(/\\e/g, '\x1b').replace(/\\033/g, '\x1b');
}

function lcp(items) {
  if (!items.length) return '';
  let prefix = items[0];
  for (let i = 1; i < items.length; i++) {
    let s = items[i];
    let n = Math.min(prefix.length, s.length);
    let j = 0;
    while (j < n && prefix[j] === s[j]) j++;
    prefix = prefix.slice(0, j);
    if (!prefix) break;
  }
  return prefix;
}

/**
 * One interactive bash on a terminal. `done` resolves to the exit status.
 */
export class BashSession {
  /**
   * @param {object} o
   * @param {any} o.term xterm Terminal
   * @param {any} o.shell boxsh interpreter (createShell(..., { interactive: true }))
   * @param {any} o.fs VFS fs (for completion)
   * @param {(s: { cwdLabel?: string, mode?: string }) => void} [o.onState]
   */
  constructor({ term, shell, fs, onState }) {
    this.term = term;
    this.shell = shell;
    this.fs = fs;
    this.onState = onState || (() => {});
    this.lineBuf = '';
    this.history = [];
    this.histIdx = 0;
    this.busy = false;
    this.ended = false;
    this.child = null; // nested session (`bash` typed at the prompt)
    this.kitty = null;
    this.tabPending = null;
    this.disposeData = null;
    this.done = new Promise((resolve) => (this._resolve = resolve));
  }

  get home() {
    return this.shell.home;
  }

  /** Print the prompt and start reading input. */
  start() {
    this.prompt();
    this.listen();
    return this.done;
  }

  listen() {
    this.disposeData?.dispose?.();
    this.disposeData = this.term.onData((data) => this.onData(data));
  }

  end(code) {
    if (this.ended) return;
    this.ended = true;
    this.tabPending = null;
    try {
      this.disposeData?.dispose?.();
    } catch {}
    this.disposeData = null;
    this._resolve(code);
  }

  /** Run a nested interactive session (shell.js `bash` with no script) until it exits. */
  async nested(shell) {
    let child = new BashSession({ term: this.term, shell, fs: this.fs, onState: this.onState });
    child.history = [...this.history];
    child.histIdx = child.history.length;
    this.child = child;
    try {
      return await child.start();
    } finally {
      this.child = null;
    }
  }

  writePrompt() {
    let label = promptPath(this.shell.cwd, this.home);
    this.onState({ cwdLabel: label });
    let env = this.shell.env || {};
    let user = this.shell.user;
    if (env.PS1) this.term.write(renderPs1(env.PS1, label, env, user));
    else this.term.write(`\x1b[38;2;245;194;231m${env.USER || user}\x1b[0m:\x1b[38;2;137;207;240m${label}\x1b[0m$ `);
  }

  prompt() {
    if (this.kitty || this.ended) return;
    for (let line of this.shell.takeNotices?.() || []) this.term.writeln(line);
    this.writePrompt();
    this.lineBuf = '';
  }

  /** Ctrl-L: clear the screen, keep what's being typed. */
  clearScreen() {
    if (this.busy || this.kitty) return;
    this.term.write('\x1b[2J\x1b[3J\x1b[H');
    this.writePrompt();
    this.term.write(this.lineBuf);
  }

  killLine() {
    if (this.busy || this.kitty || !this.lineBuf.length) return;
    this.lineBuf = '';
    this.term.write('\r\x1b[2K');
    this.writePrompt();
  }

  replaceLine(next) {
    while (this.lineBuf.length) {
      this.lineBuf = this.lineBuf.slice(0, -1);
      this.term.write('\b \b');
    }
    this.lineBuf = next;
    this.term.write(next);
  }

  async onData(data) {
    if (this.ended || this.child) return; // a nested bash has the terminal
    if (this.busy && !this.kitty && data === '\u0003') {
      // Ctrl-C while a command runs: interrupt it (node gets SIGINT).
      this.term.write('^C');
      this.shell.interrupt?.();
      return;
    }
    if (this.kitty || this.busy) return;

    // Pastes arrive as one chunk.
    if (data.length > 1 && !data.includes('\x1b') && ![...data].every((ch) => ch.charCodeAt(0) < 32 && ch !== '\t')) {
      await this.paste(data);
      return;
    }
    if (data === '\r') {
      this.tabPending = null;
      this.term.write('\r\n');
      let line = this.lineBuf;
      this.lineBuf = '';
      this.remember(line);
      await this.handleLine(line);
      if (!this.kitty && !this.ended) this.prompt();
      return;
    }
    if (data === '\t') return this.complete();
    if (data === '\u007f' || data === '\b') {
      this.tabPending = null;
      if (this.lineBuf.length) {
        this.lineBuf = this.lineBuf.slice(0, -1);
        this.term.write('\b \b');
      }
      return;
    }
    if (data === '\u0003') {
      this.tabPending = null;
      this.term.write('^C\r\n');
      this.lineBuf = '';
      this.prompt();
      return;
    }
    if (data === '\u0004') {
      // Ctrl-D: EOF on an empty line exits (bash prints "exit").
      if (!this.lineBuf.length) {
        this.term.write('exit\r\n');
        this.end(this.shell.status ?? 0);
      }
      return;
    }
    if (data === '\u000c') {
      this.tabPending = null;
      this.clearScreen();
      return;
    }
    if (data === '\u0015') {
      this.tabPending = null;
      this.killLine();
      return;
    }
    if (data === '\u001b[A') {
      this.tabPending = null;
      if (!this.history.length) return;
      this.histIdx = Math.max(0, this.histIdx - 1);
      this.replaceLine(this.history[this.histIdx] || '');
      return;
    }
    if (data === '\u001b[B') {
      this.tabPending = null;
      this.histIdx = Math.min(this.history.length, this.histIdx + 1);
      this.replaceLine(this.history[this.histIdx] || '');
      return;
    }
    // Other escape sequences (Home/End/PgUp/left/right…) and control bytes: ignored.
    if (data.startsWith('\x1b')) return;
    if (data.length === 1 && data.charCodeAt(0) < 32) return;
    this.tabPending = null;
    this.lineBuf += data;
    this.term.write(data);
  }

  remember(line) {
    if (!line.trim()) return;
    this.history.push(line);
    this.histIdx = this.history.length;
  }

  /** Paste: the first line joins the current input, complete lines run, the rest stays typed. */
  async paste(text) {
    if (this.busy || this.kitty || this.ended) return;
    let clean = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    let lines = clean.split('\n');
    let first = lines[0] ?? '';
    if (first) {
      this.lineBuf += first;
      this.term.write(first);
    }
    if (lines.length === 1) return;
    let endsWithNl = clean.endsWith('\n');
    let rest = lines.slice(1);
    this.term.write('\r\n');
    let line = this.lineBuf;
    this.lineBuf = '';
    this.remember(line);
    await this.handleLine(line);
    if (this.kitty || this.ended) return;
    let complete = endsWithNl ? rest : rest.slice(0, -1);
    let tail = endsWithNl ? '' : (rest[rest.length - 1] ?? '');
    for (let l of complete) {
      this.prompt();
      if (l.trim()) {
        this.remember(l);
        this.term.write(l + '\r\n');
        await this.handleLine(l);
        if (this.kitty || this.ended) return;
      } else this.term.write('\r\n');
    }
    this.prompt();
    if (tail) {
      this.lineBuf = tail;
      this.term.write(tail);
    }
  }

  async handleLine(line) {
    let trimmed = String(line || '').trim();
    if (!trimmed) return;

    if (trimmed === 'help') {
      this.term.writeln('Builtins: help, clear, kitty [state] [options], exit, bash');
      this.term.writeln('Shell: pwd cd ls cat grep echo printf mkdir rm mv cp touch head tail find wc sed');
      this.term.writeln('Env: export unset env set source .  ·  vars: $NAME ${NAME} $? $HOME $PWD');
      this.term.writeln('kitty: ephemeral by default; pass a JSON path to persist. kitty --help for flags.');
      this.term.writeln('Startup: ~/.boxshrc  ·  MOTD via export MOTD="..."  ·  PS1 via export PS1=...');
      this.term.writeln('Keys: Tab complete paths/$VARS · Ctrl-D / exit quit · Ctrl-L clear · Ctrl-U kill-line · Ctrl-C interrupt · Ctrl-V paste');
      return;
    }
    if (trimmed === 'clear') {
      this.term.write('\x1b[2J\x1b[3J\x1b[H');
      return;
    }
    let kittyMatch = /^(kitty)(?:\s+(.*))?$/i.exec(trimmed);
    if (kittyMatch) return this.runKitty(kittyMatch[2] || '');

    this.busy = true;
    try {
      let streamed = '';
      let live = (text) => {
        if (!text) return;
        streamed = text;
        this.term.write(String(text).replace(/\r?\n/g, '\r\n'));
      };
      // columns/rows make node's stdout a TTY of this size; tty lets `bash` start a nested session here.
      let result = await this.shell.withLive({ out: live, err: live, columns: this.term.cols, rows: this.term.rows, tty: this }, () => this.shell.run(trimmed));
      if (streamed && !streamed.endsWith('\n')) this.term.write('\r\n');
      let { formatResult } = await import('./shell.js');
      let out = streamed && !result.stdout && !result.stderr ? '' : formatResult(result);
      if (out) {
        let text = out.endsWith('\n') ? out.slice(0, -1) : out;
        for (let row of text.split('\n')) this.term.writeln(row);
      }
      if (result.code && !out && !streamed && !result.exit) this.term.writeln(`\x1b[31mexit ${result.code}\x1b[0m`);
      if (result.exit) this.end(result.code ?? 0);
    } catch (err) {
      this.term.writeln('\x1b[31m' + String(err?.message || err) + '\x1b[0m');
    } finally {
      this.busy = false;
    }
  }

  async runKitty(argStr) {
    this.kitty = true;
    this.onState({ mode: 'kitty' });
    this.disposeData?.dispose?.();
    this.disposeData = null;
    let argv = argStr.trim() ? argStr.trim().split(/\s+/) : [];
    try {
      this.term.writeln('');
      let { startKitty, stopKitty } = await import('./kitty-cli.js');
      this.stopKitty = stopKitty;
      await startKitty({ term: this.term, vfs: this.fs, shell: this.shell, argv });
    } catch (err) {
      this.term.writeln('\x1b[31mkitty: ' + String(err?.message || err) + '\x1b[0m');
    } finally {
      this.kitty = null;
      this.stopKitty = null;
      this.onState({ mode: 'shell' });
      this.term.writeln('');
      if (!this.ended) {
        this.listen();
        this.prompt();
      }
    }
  }

  /** Stop everything (the Terminal window closed). */
  async dispose() {
    await this.child?.dispose();
    try {
      if (this.kitty && this.stopKitty) await this.stopKitty();
    } catch {}
    this.shell.interrupt?.('SIGHUP');
    this.end(129);
  }

  /* ---------- completion ---------- */

  resolvePath(input) {
    let cwd = this.shell.cwd || '';
    let text = input == null ? '' : String(input);
    let fromHome = false;
    if (text === '~' || text.startsWith('~/')) {
      text = this.home + text.slice(1);
      fromHome = true;
    }
    let absolute = fromHome || text.startsWith('/');
    if (text.startsWith('/')) text = text.replace(/^\/+/, '');
    let parts = absolute ? [] : cwd ? cwd.split('/').filter(Boolean) : [];
    if (!text || text === '.') return parts.join('/');
    for (let part of text.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return parts.join('/');
  }

  expandPathToken(token) {
    let env = this.shell.env || {};
    let m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}(.*)$/.exec(token);
    if (m) return env[m[1]] == null ? null : String(env[m[1]]) + m[2];
    m = /^\$([A-Za-z_][A-Za-z0-9_]*)(\/.*)?$/.exec(token);
    if (m) return env[m[1]] == null ? null : String(env[m[1]]) + (m[2] || '');
    return token;
  }

  async listDirEntries(dirPath) {
    if (!this.fs?.list) return [];
    let prefix = dirPath ? dirPath + '/' : '';
    let entries = new Map();
    for (let path of await this.fs.list()) {
      if (prefix && !path.startsWith(prefix)) continue;
      if (!prefix && path.startsWith('/')) continue;
      let rest = prefix ? path.slice(prefix.length) : path;
      if (!rest) continue;
      let slash = rest.indexOf('/');
      if (slash === -1) {
        if (rest === '.keep') continue;
        if (!entries.has(rest)) entries.set(rest, 'file');
      } else entries.set(rest.slice(0, slash), 'dir');
    }
    return [...entries.entries()].map(([name, kind]) => ({ name, kind })).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1));
  }

  applyToken(before, nextToken) {
    let next = before + nextToken;
    if (next.startsWith(this.lineBuf)) {
      this.term.write(next.slice(this.lineBuf.length));
      this.lineBuf = next;
      return;
    }
    this.replaceLine(next);
  }

  printCompletions(matches) {
    let saved = this.lineBuf;
    let cols = Math.max(1, Math.floor((this.term.cols || 80) / 16));
    this.term.write('\r\n');
    for (let i = 0; i < matches.length; i++) this.term.write(String(matches[i]).padEnd(15).slice(0, 15) + ((i + 1) % cols === 0 ? '\r\n' : ' '));
    if (matches.length % cols !== 0) this.term.write('\r\n');
    this.writePrompt();
    this.lineBuf = saved;
    this.term.write(saved);
  }

  async completeEnv(before, token) {
    let env = this.shell.env || {};
    let braced = token.startsWith('${');
    let name;
    if (braced) {
      let inner = token.slice(2);
      if (inner.includes('}')) {
        let expanded = this.expandPathToken(token);
        if (expanded != null) await this.completePath(before, token, expanded);
        return;
      }
      name = inner;
    } else {
      let m = /^\$([A-Za-z_][A-Za-z0-9_]*)(\/.*)?$/.exec(token);
      if (m && m[2]) {
        let expanded = this.expandPathToken(token);
        if (expanded != null) await this.completePath(before, token, expanded);
        return;
      }
      name = token.slice(1);
    }
    let replacements = Object.keys(env)
      .filter((k) => k.startsWith(name))
      .sort()
      .map((k) => (braced ? '${' + k + '}' : '$' + k));
    if (!replacements.length) return;
    if (this.tabPending?.kind === 'env' && this.tabPending.token === token && replacements.length > 1) {
      this.printCompletions(replacements);
      this.tabPending = null;
      return;
    }
    if (replacements.length === 1) {
      this.applyToken(before, replacements[0]);
      this.tabPending = null;
      return;
    }
    let common = lcp(replacements);
    if (common.length > token.length) {
      this.applyToken(before, common);
      token = common;
    }
    this.tabPending = { kind: 'env', token };
  }

  async completePath(before, token, expanded) {
    if (token === '~') {
      this.applyToken(before, '~/');
      this.tabPending = null;
      return;
    }
    let pathText = expanded != null ? expanded : token;
    let slash = pathText.lastIndexOf('/');
    let dirText = slash === -1 ? '' : pathText.slice(0, slash + 1);
    let base = slash === -1 ? pathText : pathText.slice(slash + 1);
    let tokSlash = token.lastIndexOf('/');
    let tokDir = tokSlash === -1 ? '' : token.slice(0, tokSlash + 1);
    let resolvedDir = !dirText ? (pathText.startsWith('/') ? '' : this.shell.cwd || '') : this.resolvePath(dirText);
    let matched = (await this.listDirEntries(resolvedDir)).filter((e) => e.name.startsWith(base));
    if (!matched.length) return;
    let names = matched.map((e) => e.name + (e.kind === 'dir' ? '/' : ''));
    let replacements = names.map((n) => tokDir + n);
    if (this.tabPending?.kind === 'path' && this.tabPending.token === token && replacements.length > 1) {
      this.printCompletions(names);
      this.tabPending = null;
      return;
    }
    if (replacements.length === 1) {
      let rep = replacements[0];
      // bash adds a trailing space for a unique file completion
      if (!rep.endsWith('/')) rep += ' ';
      this.applyToken(before, rep);
      this.tabPending = null;
      return;
    }
    let common = lcp(replacements);
    if (common.length > token.length) {
      this.applyToken(before, common);
      token = common;
    }
    this.tabPending = { kind: 'path', token };
  }

  async complete() {
    if (this.busy || this.kitty || this.ended) return;
    let m = /^(.*?)(\S*)$/.exec(this.lineBuf);
    let before = m[1];
    let token = m[2];
    if (!token) return;
    if (token.startsWith('$')) return this.completeEnv(before, token);
    return this.completePath(before, token);
  }
}

/**
 * Log in a terminal: the user's interactive bash (rc file, MOTD, prompt).
 * @param {{ term: any, onState?: Function }} o
 * @returns {Promise<BashSession>} started session; await `session.done` for the exit status
 */
export async function startInteractiveBash({ term, onState }) {
  let [{ createShell }, { createVfsFs, ensureReady, write, read }] = await Promise.all([import('./shell.js'), import('./vfs.js')]);
  await ensureReady();
  let fs = createVfsFs();
  let shell = createShell(fs, { interactive: true });
  let home = shell.home;
  try {
    await write(home + '/.keep', '');
  } catch {}
  try {
    if ((await read(home + '/.boxshrc')) == null) {
      await write(
        home + '/.boxshrc',
        ['# ~/.boxshrc — sourced by interactive shells', '# export MOTD="Welcome — type help"', '# export PS1="\\[\\e[38;2;245;194;231m\\]\\u\\[\\e[0m\\]:\\[\\e[38;2;137;207;240m\\]\\w\\[\\e[0m\\]$ "', ''].join('\n'),
      );
    }
  } catch {}
  // Background jobs (`cmd &`) write straight to the terminal, like a tty.
  shell.setBackgroundSink((text) => term.write(String(text).replace(/\r?\n/g, '\r\n')));
  // Start a spare node worker now so the first `node` run doesn't pay for startup.
  import('./node/node.js')
    .then((m) => m.prewarmNode())
    .catch(() => {});
  await shell.run('cd ~');
  await shell.loadRc();
  let motd = String(shell.env?.MOTD || '');
  if (motd) for (let line of motd.replace(/\\n/g, '\n').replace(/\\e/g, '\x1b').replace(/\\033/g, '\x1b').split('\n')) term.writeln(line);
  let session = new BashSession({ term, shell, fs, onState });
  session.start();
  return session;
}
