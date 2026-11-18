import { Writable, chunkToString, isBuffer } from './browser-streams.js';

/**
 * Keeps one terminal block per open thread. Blocks stay in list order
 * (use `{ before }` to insert above another thread). Writes from different
 * streams interleave freely; each thread keeps its own row(s).
 *
 * Write semantics:
 * - Plain text appends (multi-line threads use `\n`).
 * - `\b` deletes the character before the cursor.
 * - With `{ line: true }`, basic ANSI cursor/clear sequences are applied so
 *   readline can use the stream as its `output`, and `\n` commits the line
 *   into scrollback then clears the live row.
 * - With `{ commitOnEnd: true }`, ending the stream pins its text into
 *   scrollback before the live row is removed.
 * - `separator` (constructor option) is inserted between adjacent visible
 *   threads when painting (e.g. `'\n'` for a blank gap before the REPL).
 */
export default class Threads {
  constructor(output, { separator = '' } = {}) {
    if (!output || typeof output.write !== 'function') {
      throw new TypeError('Threads expects a writable output stream');
    }

    this.output = output;
    this.separator = separator;
    this.threads = [];
    this.renderedRows = 0;
    this.threadByWritable = new WeakMap();
    /** Most recent pinToScrollback payload, for quiet Waiting-abort reclaim. */
    this.lastPin = null;
    this.onResize = () => this.render();
    if (typeof output.on === 'function') output.on('resize', this.onResize);
  }

  /** Detach resize listener when the overlay is no longer used. */
  close() {
    if (typeof this.output.off === 'function') this.output.off('resize', this.onResize);
    else if (typeof this.output.removeListener === 'function') {
      this.output.removeListener('resize', this.onResize);
    }
  }

  /**
   * Open a new thread stream.
   * @param {object} [opts]
   * @param {boolean} [opts.line] Readline-friendly single-line editing.
   * @param {boolean} [opts.commitOnEnd] Pin text into scrollback when the stream ends.
   * @param {Writable|object} [opts.before] Insert above this thread
   *   (e.g. open the agent stream above the active REPL).
   */
  open({ line = false, commitOnEnd = false, before = null } = {}) {
    let thread = { text: '', cursor: 0, line, commitOnEnd };

    let insertAt = this.threads.length;
    if (before != null) {
      let ref = this.resolve(before);
      let idx = ref ? this.threads.indexOf(ref) : -1;
      if (idx !== -1) insertAt = idx;
    }
    this.threads.splice(insertAt, 0, thread);

    let stream = new Writable({
      decodeStrings: false,
      write: (chunk, encoding, callback) => {
        try {
          this.writeToThread(
            thread,
            isBuffer(chunk) ? chunk.toString(encoding) : chunkToString(chunk, encoding),
          );
          this.render();
          callback();
        } catch (err) {
          callback(err);
        }
      },
      final: (callback) => {
        try {
          let index = this.threads.indexOf(thread);
          if (index !== -1) {
            if (thread.commitOnEnd && thread.text) this.commit(thread);
            else {
              this.threads.splice(index, 1);
              this.render();
            }
          }
          callback();
        } catch (err) {
          callback(err);
        }
      },
    });

    this.threadByWritable.set(stream, thread);
    thread.stream = stream;

    // Duck-typed hook for editors (e.g. kitty-readline) that prefer replacing
    // the whole line buffer over speaking ANSI into the stream.
    stream.setLine = (text, cursor = String(text).length) => {
      this.setText(stream, text, cursor);
    };
    Object.defineProperty(stream, 'columns', {
      get: () => this.columns(),
      configurable: true,
    });

    return stream;
  }

  /** Replace a thread's visible text in one shot and repaint. */
  setText(threadOrStream, text, cursor = String(text).length) {
    let thread = this.resolve(threadOrStream);
    if (!thread) return;
    thread.text = String(text);
    thread.cursor = Math.max(0, Math.min(thread.text.length, cursor));
    this.render();
  }

  /**
   * Write thread text into scrollback. Always appends `separator` when set, so
   * the gap matches the live overlay both between stacked threads and after a
   * committed user prompt before the first agent row.
   */
  pinToScrollback(thread) {
    if (!thread?.text) return;
    let written = thread.text;
    if (this.separator) {
      let sep = String(this.separator);
      written += sep;
      if (!sep.endsWith('\n')) written += '\n';
    } else if (!thread.text.endsWith('\n')) {
      written += '\n';
    }
    this.output.write(written);
    // Visual rows occupied above the post-pin cursor (soft-wrap aware).
    let rows = this.textVisualRows(written.replace(/\n$/, ''));
    this.lastPin = { text: thread.text, rows };
  }

  /**
   * Erase the most recent pin from the terminal. The pin must still sit
   * immediately above the live overlay (e.g. quiet Ctrl-C while Waiting).
   * Returns the pinned text, or null.
   */
  uncommitLast() {
    if (!this.lastPin) return null;
    let { text, rows } = this.lastPin;
    this.lastPin = null;
    this.clearOverlay();
    if (rows > 0) {
      let out = `\x1b[${rows}A`;
      for (let i = 0; i < rows; i++) {
        out += '\r\x1b[2K';
        if (i < rows - 1) out += '\n';
      }
      if (rows > 1) out += `\x1b[${rows - 1}A\r`;
      this.output.write(out);
    }
    return text;
  }

  /** Permanently print a thread's text into scrollback, then drop it from the live overlay. */
  commit(threadOrStream) {
    let thread = this.resolve(threadOrStream);
    if (!thread) return;

    this.clearOverlay();
    this.pinToScrollback(thread);

    let index = this.threads.indexOf(thread);
    if (index !== -1) this.threads.splice(index, 1);
    thread.text = '';
    thread.cursor = 0;
    this.render();
  }

  resolve(threadOrStream) {
    if (!threadOrStream) return null;
    if (this.threads.includes(threadOrStream)) return threadOrStream;
    let thread = this.threadByWritable.get(threadOrStream);
    if (thread && this.threads.includes(thread)) return thread;
    return null;
  }

  writeToThread(thread, text) {
    if (thread.line) this.writeLineMode(thread, text);
    else this.writeTextMode(thread, text);
  }

  writeTextMode(thread, text) {
    for (let ch of text) {
      if (ch === '\b') {
        if (thread.text.length) thread.text = thread.text.slice(0, -1);
        thread.cursor = thread.text.length;
      } else {
        thread.text += ch;
        thread.cursor = thread.text.length;
      }
    }
  }

  writeLineMode(thread, text) {
    let i = 0;
    while (i < text.length) {
      let ch = text[i];

      if (ch === '\x1b') {
        let seq = this.consumeCsi(text, i);
        if (seq) {
          this.applyCsi(thread, seq);
          i += seq.length;
          continue;
        }
        i += 1;
        continue;
      }

      if (ch === '\n') {
        // Editor submitted: pin into scrollback (with separator if rows remain below).
        this.clearOverlay();
        this.pinToScrollback(thread);
        thread.text = '';
        thread.cursor = 0;
        i += 1;
        continue;
      }

      if (ch === '\r') {
        thread.cursor = 0;
        i += 1;
        continue;
      }

      if (ch === '\b' || ch === '\x7f') {
        if (thread.cursor > 0) {
          thread.text = thread.text.slice(0, thread.cursor - 1) + thread.text.slice(thread.cursor);
          thread.cursor -= 1;
        }
        i += 1;
        continue;
      }

      thread.text = thread.text.slice(0, thread.cursor) + ch + thread.text.slice(thread.cursor);
      thread.cursor += 1;
      i += 1;
    }
  }

  consumeCsi(text, i) {
    if (text[i] !== '\x1b') return null;
    if (text[i + 1] === '[') {
      let j = i + 2;
      while (j < text.length && /[0-9;?]/.test(text[j])) j += 1;
      if (j < text.length && /[A-Za-z]/.test(text[j])) return text.slice(i, j + 1);
      return null;
    }
    if (i + 1 < text.length) return text.slice(i, i + 2);
    return null;
  }

  applyCsi(thread, seq) {
    let m = /^\x1b\[([0-9;]*)([A-Za-z])$/.exec(seq);
    if (!m) return;
    let args = m[1] ? m[1].split(';').map(x => (x === '' ? 0 : Number(x))) : [];
    let code = m[2];
    let n = args[0] || 0;

    if (code === 'G') {
      thread.cursor = Math.max(0, Math.min(thread.text.length, (n || 1) - 1));
      return;
    }
    if (code === 'D') {
      thread.cursor = Math.max(0, thread.cursor - (n || 1));
      return;
    }
    if (code === 'C') {
      thread.cursor = Math.min(thread.text.length, thread.cursor + (n || 1));
      return;
    }
    if (code === 'K') {
      let mode = n || 0;
      if (mode === 0) thread.text = thread.text.slice(0, thread.cursor);
      else if (mode === 1) {
        thread.text = thread.text.slice(thread.cursor);
        thread.cursor = 0;
      } else if (mode === 2) {
        thread.text = '';
        thread.cursor = 0;
      }
      return;
    }
    if (code === 'J') thread.text = thread.text.slice(0, thread.cursor);
  }

  visibleRows() {
    return this.threads.filter(t => t.text.length > 0);
  }

  /** Terminal width used for soft-wrap row counting. */
  columns() {
    let cols = this.output.columns;
    return cols && cols > 0 ? cols : 80;
  }

  /** How many visual terminal rows a single logical line occupies when soft-wrapped. */
  lineVisualRows(line, cols = this.columns()) {
    let len = [...String(line)].length;
    if (len <= 0) return 1;
    return Math.ceil(len / cols);
  }

  textVisualRows(text, cols = this.columns()) {
    if (!text) return 0;
    return text.split('\n').reduce((sum, line) => sum + this.lineVisualRows(line, cols), 0);
  }

  clearOverlay() {
    if (this.renderedRows <= 0) return;
    let output = '\r';
    if (this.renderedRows > 1) output += `\x1b[${this.renderedRows - 1}A`;
    for (let i = 0; i < this.renderedRows; i++) {
      output += '\r\x1b[2K';
      if (i < this.renderedRows - 1) output += '\n';
    }
    if (this.renderedRows > 1) output += `\x1b[${this.renderedRows - 1}A\r`;
    this.output.write(output);
    this.renderedRows = 0;
  }

  render() {
    let cols = this.columns();
    let rows = this.visibleRows();
    let sep = this.separator == null ? '' : String(this.separator);
    let body = rows.map(t => t.text).join(sep);
    let lines = body.length ? body.split('\n') : [];

    let writtenRows = lines.reduce((sum, line) => sum + this.lineVisualRows(line, cols), 0);
    let output = '';

    // Erase the previous overlay by its *visual* height. Soft-wrapped lines
    // occupy multiple rows; counting only hard `\n` leaves leftovers that look
    // like the paragraph restarting on every delta.
    if (this.renderedRows > 0) {
      output += '\r';
      if (this.renderedRows > 1) output += `\x1b[${this.renderedRows - 1}A`;
      for (let i = 0; i < this.renderedRows; i++) {
        output += '\r\x1b[2K';
        if (i < this.renderedRows - 1) output += '\n';
      }
      if (this.renderedRows > 1) output += `\x1b[${this.renderedRows - 1}A\r`;
    }

    if (lines.length) output += lines.join('\n');

    let caret = this.#caretEscape(rows, cols, sep, writtenRows);
    if (caret) output += caret;

    if (output) this.output.write(output);
    this.renderedRows = writtenRows;
  }

  #caretEscape(visibleThreads, cols, sep, writtenRows) {
    let lineThread = null;
    for (let i = visibleThreads.length - 1; i >= 0; i--) {
      if (visibleThreads[i].line) {
        lineThread = visibleThreads[i];
        break;
      }
    }
    if (!lineThread || writtenRows <= 0) return '';

    let caret = Math.max(0, Math.min(lineThread.text.length, lineThread.cursor));
    // Build the same flat string render() paints, and locate the caret inside it.
    let parts = [];
    let caretAt = 0;
    for (let i = 0; i < visibleThreads.length; i++) {
      if (i > 0) parts.push(sep);
      if (visibleThreads[i] === lineThread) {
        caretAt = parts.join('').length + caret;
      }
      parts.push(visibleThreads[i].text);
    }
    let before = parts.join('').slice(0, caretAt);
    let row = 0;
    let col = 0;
    let hard = before.split('\n');
    for (let i = 0; i < hard.length; i++) {
      let units = [...hard[i]].length;
      if (i < hard.length - 1) {
        row += this.lineVisualRows(hard[i], cols);
      } else {
        row += Math.floor(units / cols);
        col = units % cols;
      }
    }
    let rowsFromEnd = writtenRows - 1 - row;
    let esc = '';
    if (rowsFromEnd > 0) esc += `\x1b[${rowsFromEnd}A`;
    esc += '\r';
    if (col > 0) esc += `\x1b[${col}C`;
    return esc;
  }
}
