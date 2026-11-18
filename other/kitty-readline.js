import { EventEmitter, chunkToString, isBuffer } from './browser-streams.js';

/**
 * Terminal line editor. Thread-agnostic: writes only to the given `output`
 * Writable using ordinary CR / clear-line / cursor moves. Pair it with
 * stream-threads (or any other sink) at the call site.
 *
 * Enter submits. Alt+Enter (meta+return) inserts a newline for multi-line input.
 *
 * Events: `beforeLine` (string, before scrollback pin), `line` (string), `SIGINT`, `close`.
 *
 * Browser: feed keypresses via input emitting `keypress` (see xterm-stdio.js).
 */
export default class KittyReadline extends EventEmitter {
  constructor({
    input,
    output,
    prompt = '> ',
    terminal = true,
    historySize = 100,
    continuationPrompt = null,
  } = {}) {
    super();
    if (!input || typeof input.on !== 'function') {
      throw new TypeError('KittyReadline expects a readable input stream');
    }
    if (!output || typeof output.write !== 'function') {
      throw new TypeError('KittyReadline expects a writable output stream');
    }

    this.input = input;
    this.output = output;
    this._prompt = String(prompt);
    // Shown on wrapped continuation rows; default pads to prompt width.
    this._continuationPrompt = continuationPrompt;
    this.terminal = terminal;
    this.historySize = historySize;

    this.line = '';
    this.cursor = 0;
    this.closed = false;
    this.paused = false;
    /** When true, Ctrl-D always EOF/closes even if the buffer is non-empty (busy turns). */
    this.eofAlways = false;
    this._history = [];
    this._historyIndex = -1;
    this._historyStaging = null;
    this._raw = false;
    this._onData = null;
    this._onKeypress = null;
    this._pipeBuf = '';
    this._displayRows = 0;

    if (this.terminal) this.#attachTerminal();
    else this.#attachPipe();
  }

  get prompt() {
    return this._prompt;
  }

  setPrompt(prompt) {
    this._prompt = String(prompt);
  }

  setContinuationPrompt(prompt) {
    this._continuationPrompt = prompt;
  }

  /** Show the prompt and current buffer on `output`. */
  prompt() {
    if (this.closed) return;
    this.#redraw();
  }

  clearLine() {
    this.line = '';
    this.cursor = 0;
    this.#redraw();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#detach();
    this.emit('close');
  }

  #attachTerminal() {
    // xterm-stdio (or any TTY shim) must emit `keypress` itself; no node:readline.
    if (this.input.isTTY && typeof this.input.setRawMode === 'function') {
      try {
        this.input.setRawMode(true);
        this._raw = true;
      } catch {
        this._raw = false;
      }
    }
    if (typeof this.input.resume === 'function') this.input.resume();

    this._onKeypress = (str, key) => {
      if (this.closed || this.paused) return;
      this.#handleKey(str, key || {});
    };
    this.input.on('keypress', this._onKeypress);
  }

  #attachPipe() {
    this._onData = chunk => {
      if (this.closed) return;
      this._pipeBuf += isBuffer(chunk) ? chunk.toString('utf8') : chunkToString(chunk);
      let idx;
      while ((idx = this._pipeBuf.indexOf('\n')) >= 0) {
        let line = this._pipeBuf.slice(0, idx);
        this._pipeBuf = this._pipeBuf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        this.#submit(line);
      }
    };
    this.input.on('data', this._onData);
    this.input.on('end', () => {
      if (this._pipeBuf) {
        let line = this._pipeBuf;
        this._pipeBuf = '';
        this.#submit(line);
      }
      this.close();
    });
  }

  #detach() {
    if (this._onKeypress) this.input.off('keypress', this._onKeypress);
    if (this._onData) this.input.off('data', this._onData);
    if (this._raw && typeof this.input.setRawMode === 'function') {
      try { this.input.setRawMode(false); } catch { /* ignore */ }
      this._raw = false;
    }
  }

  #write(s) {
    if (s) this.output.write(s);
  }

  #columns() {
    let cols = this.output.columns;
    return cols && cols > 0 ? cols : 80;
  }

  #contPrompt() {
    if (this._continuationPrompt != null) return String(this._continuationPrompt);
    return ' '.repeat([...this._prompt].length);
  }

  /** Rendered rows: first line uses the main prompt, later hard-lines use continuation. */
  #displayLines() {
    let parts = this.line.split('\n');
    let cont = this.#contPrompt();
    return parts.map((part, i) => (i === 0 ? this._prompt : cont) + part);
  }

  #lineVisualRows(text, cols) {
    let len = [...String(text)].length;
    if (len <= 0) return 1;
    return Math.ceil(len / cols);
  }

  #totalDisplayRows() {
    let cols = this.#columns();
    return this.#displayLines().reduce((sum, line) => sum + this.#lineVisualRows(line, cols), 0);
  }

  /** Index of the caret inside the painted display string (prompts included). */
  #displayCaretIndex() {
    let before = this.line.slice(0, this.cursor);
    let parts = before.split('\n');
    let lineIdx = parts.length - 1;
    let cont = this.#contPrompt();
    let idx = 0;
    for (let i = 0; i < lineIdx; i++) {
      idx += (i === 0 ? this._prompt : cont).length + (this.line.split('\n')[i] ?? '').length + 1;
    }
    idx += (lineIdx === 0 ? this._prompt : cont).length + parts[parts.length - 1].length;
    return idx;
  }

  #paintSetLine() {
    let text = this.#displayLines().join('\n');
    this.output.setLine(text, this.#displayCaretIndex());
    this._displayRows = this.#totalDisplayRows();
  }

  /** Clear previous displayRows, then paint prompt(s) + buffer and restore cursor. */
  #redraw() {
    // Prefer a sink that can replace its buffer wholesale (e.g. a stream-threads
    // Writable with `.setLine`). Keeps this module free of Threads imports.
    if (typeof this.output.setLine === 'function') {
      this.#paintSetLine();
      return;
    }

    let cols = this.#columns();
    let lines = this.#displayLines();
    let nextRows = lines.reduce((sum, line) => sum + this.#lineVisualRows(line, cols), 0);
    let out = '';

    if (this._displayRows > 0) {
      out += '\r';
      if (this._displayRows > 1) out += `\x1b[${this._displayRows - 1}A`;
      for (let i = 0; i < this._displayRows; i++) {
        out += '\r\x1b[2K';
        if (i < this._displayRows - 1) out += '\n';
      }
      if (this._displayRows > 1) out += `\x1b[${this._displayRows - 1}A\r`;
    }

    out += lines.join('\n');

    let { rowOffset, col } = this.#caretPos(cols);
    let rowsUp = (nextRows - 1) - rowOffset;
    if (rowsUp > 0) out += `\x1b[${rowsUp}A`;
    out += '\r';
    if (col > 0) out += `\x1b[${col}C`;

    this.#write(out);
    this._displayRows = nextRows;
  }

  /** Caret position within the painted multi-line block (0-based row offset, column). */
  #caretPos(cols = this.#columns()) {
    let before = this.line.slice(0, this.cursor);
    let parts = before.split('\n');
    let lineIdx = parts.length - 1;
    let cont = this.#contPrompt();
    let rowOffset = 0;
    let all = this.line.split('\n');
    for (let i = 0; i < lineIdx; i++) {
      let painted = (i === 0 ? this._prompt : cont) + (all[i] ?? '');
      rowOffset += this.#lineVisualRows(painted, cols);
    }
    let prefix = lineIdx === 0 ? this._prompt : cont;
    let units = [...(prefix + parts[parts.length - 1])];
    return {
      rowOffset: rowOffset + Math.floor(units.length / cols),
      col: units.length % cols,
    };
  }

  #units() {
    return [...this.line];
  }

  #cursorUnits() {
    return [...this.line.slice(0, this.cursor)].length;
  }

  #setFromUnits(units, unitCursor) {
    this.line = units.join('');
    let u = Math.max(0, Math.min(units.length, unitCursor));
    this.cursor = units.slice(0, u).join('').length;
  }

  #pushHistory(line) {
    if (!line) return;
    if (this._history[0] === line) return;
    this._history.unshift(line);
    if (this._history.length > this.historySize) this._history.length = this.historySize;
  }

  #submit(line) {
    this.#pushHistory(line);
    this._historyIndex = -1;
    this._historyStaging = null;

    // Fires before the line is pinned to scrollback so callers can seal
    // streams that must appear above this prompt (mid-agent inject).
    this.emit('beforeLine', line);

    if (typeof this.output.setLine === 'function') {
      // Paint the final buffer, then a bare `\n` lets a line-mode sink commit it.
      this.#paintSetLine();
      this.line = '';
      this.cursor = 0;
      this.#write('\n');
      this._displayRows = 0;
    } else {
      this.line = '';
      this.cursor = 0;
      this.#write('\r\n');
      this._displayRows = 0;
    }

    this.emit('line', line);
  }

  #insertChar(ch) {
    if (!ch || ch === '\x1b') return;
    let units = this.#units();
    let at = this.#cursorUnits();
    units.splice(at, 0, ...[...ch]);
    this.#setFromUnits(units, at + [...ch].length);
    this.#redraw();
  }

  #insertNewline() {
    this.#insertChar('\n');
  }

  #backspace() {
    let units = this.#units();
    let at = this.#cursorUnits();
    if (at <= 0) return;
    units.splice(at - 1, 1);
    this.#setFromUnits(units, at - 1);
    this.#redraw();
  }

  #delete() {
    let units = this.#units();
    let at = this.#cursorUnits();
    if (at >= units.length) return;
    units.splice(at, 1);
    this.#setFromUnits(units, at);
    this.#redraw();
  }

  #left() {
    let at = this.#cursorUnits();
    if (at <= 0) return;
    this.#setFromUnits(this.#units(), at - 1);
    this.#redraw();
  }

  #right() {
    let units = this.#units();
    let at = this.#cursorUnits();
    if (at >= units.length) return;
    this.#setFromUnits(units, at + 1);
    this.#redraw();
  }

  #home() {
    // Soft home: start of current hard line. Ctrl+A goes there; repeated use stays.
    let before = this.line.slice(0, this.cursor);
    let lastNl = before.lastIndexOf('\n');
    this.cursor = lastNl + 1;
    this.#redraw();
  }

  #end() {
    let after = this.line.slice(this.cursor);
    let nextNl = after.indexOf('\n');
    this.cursor = nextNl === -1 ? this.line.length : this.cursor + nextNl;
    this.#redraw();
  }

  #killToEnd() {
    let after = this.line.slice(this.cursor);
    let nextNl = after.indexOf('\n');
    let end = nextNl === -1 ? this.line.length : this.cursor + nextNl;
    this.line = this.line.slice(0, this.cursor) + this.line.slice(end);
    this.#redraw();
  }

  #killToStart() {
    let before = this.line.slice(0, this.cursor);
    let lastNl = before.lastIndexOf('\n');
    let start = lastNl + 1;
    this.line = this.line.slice(0, start) + this.line.slice(this.cursor);
    this.cursor = start;
    this.#redraw();
  }

  /** Move caret to the previous hard line, same column when possible. */
  #lineUp() {
    let parts = this.line.split('\n');
    let before = this.line.slice(0, this.cursor);
    let row = before.split('\n').length - 1;
    if (row <= 0) return false;
    let col = before.split('\n').at(-1).length;
    let prev = parts[row - 1];
    let newCol = Math.min(col, prev.length);
    let offset = parts.slice(0, row - 1).join('\n');
    this.cursor = (offset ? offset.length + 1 : 0) + newCol;
    this.#redraw();
    return true;
  }

  #lineDown() {
    let parts = this.line.split('\n');
    let before = this.line.slice(0, this.cursor);
    let row = before.split('\n').length - 1;
    if (row >= parts.length - 1) return false;
    let col = before.split('\n').at(-1).length;
    let next = parts[row + 1];
    let newCol = Math.min(col, next.length);
    let offset = parts.slice(0, row + 1).join('\n');
    this.cursor = offset.length + 1 + newCol;
    this.#redraw();
    return true;
  }

  #historyPrev() {
    if (!this._history.length) return;
    if (this._historyIndex < 0) this._historyStaging = this.line;
    if (this._historyIndex >= this._history.length - 1) return;
    this._historyIndex += 1;
    this.line = this._history[this._historyIndex];
    this.cursor = this.line.length;
    this.#redraw();
  }

  #historyNext() {
    if (this._historyIndex < 0) return;
    this._historyIndex -= 1;
    if (this._historyIndex < 0) {
      this.line = this._historyStaging ?? '';
      this._historyStaging = null;
    } else {
      this.line = this._history[this._historyIndex];
    }
    this.cursor = this.line.length;
    this.#redraw();
  }

  #handleKey(str, key) {
    let name = key.name || '';
    let ctrl = !!key.ctrl;
    let meta = !!key.meta;

    if (ctrl && name === 'c') {
      this.emit('SIGINT');
      return;
    }

    if (ctrl && name === 'd') {
      // Idle empty line, or busy turn (eofAlways): treat as EOF and close.
      if (!this.line || this.eofAlways) {
        this.emit('EOF');
        this.close();
        return;
      }
      this.#delete();
      return;
    }

    // Alt+Enter / meta+return → newline. Plain Enter → submit.
    if (name === 'return' || name === 'enter') {
      if (meta) {
        this.#insertNewline();
        return;
      }
      this.#submit(this.line);
      return;
    }

    // Some terminals send ESC then Enter as separate events; also accept
    // sequence `\x1b\r` as a single keypress string.
    if (str === '\x1b\r' || str === '\x1b\n') {
      this.#insertNewline();
      return;
    }

    if (name === 'backspace') {
      this.#backspace();
      return;
    }
    if (name === 'delete') {
      this.#delete();
      return;
    }
    if (name === 'left') {
      this.#left();
      return;
    }
    if (name === 'right') {
      this.#right();
      return;
    }
    if (name === 'home' || (ctrl && name === 'a')) {
      this.#home();
      return;
    }
    if (name === 'end' || (ctrl && name === 'e')) {
      this.#end();
      return;
    }
    if (ctrl && name === 'k') {
      this.#killToEnd();
      return;
    }
    if (ctrl && name === 'u') {
      this.#killToStart();
      return;
    }
    if (name === 'up') {
      if (!this.#lineUp()) this.#historyPrev();
      return;
    }
    if (name === 'down') {
      if (!this.#lineDown()) this.#historyNext();
      return;
    }

    if (ctrl || meta) return;
    if (name === 'escape') return;

    if (str && str >= ' ') this.#insertChar(str);
  }
}
