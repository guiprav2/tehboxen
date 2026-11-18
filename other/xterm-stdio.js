/**
 * Bind an xterm.js Terminal to Node-like stdin/stdout streams for kitty-readline
 * and stream-threads.
 */
import { EventEmitter, Readable, Writable, chunkToString } from './browser-streams.js';

/** Parse a raw key string (from xterm onData) into readline-style { name, ctrl, meta, shift }. */
export function parseKeypress(data) {
  let str = String(data ?? '');
  let key = {
    name: undefined,
    ctrl: false,
    meta: false,
    shift: false,
    sequence: str,
  };

  if (str === '\r' || str === '\n') {
    key.name = 'return';
    return { str: '\r', key };
  }
  if (str === '\t') {
    key.name = 'tab';
    return { str, key };
  }
  if (str === '\x7f' || str === '\b') {
    key.name = 'backspace';
    return { str, key };
  }
  if (str === '\x03') {
    key.name = 'c';
    key.ctrl = true;
    return { str, key };
  }
  if (str === '\x04') {
    key.name = 'd';
    key.ctrl = true;
    return { str, key };
  }
  if (str === '\x1a') {
    key.name = 'z';
    key.ctrl = true;
    return { str, key };
  }
  if (str === '\x1b') {
    key.name = 'escape';
    return { str, key };
  }

  // CSI sequences
  if (str.startsWith('\x1b[')) {
    let body = str.slice(2);
    if (body === 'A') key.name = 'up';
    else if (body === 'B') key.name = 'down';
    else if (body === 'C') key.name = 'right';
    else if (body === 'D') key.name = 'left';
    else if (body === 'H') key.name = 'home';
    else if (body === 'F') key.name = 'end';
    else if (body === '3~') key.name = 'delete';
    else if (body === '1;5A') {
      key.name = 'up';
      key.ctrl = true;
    } else if (body === '1;5B') {
      key.name = 'down';
      key.ctrl = true;
    }
    return { str: '', key };
  }

  // Alt+key often arrives as ESC + char
  if (str.startsWith('\x1b') && str.length === 2) {
    key.meta = true;
    let ch = str[1];
    if (ch === '\r' || ch === '\n') key.name = 'return';
    else key.name = ch;
    return { str: ch === '\r' || ch === '\n' ? '' : ch, key };
  }

  if (str.length === 1 && str.charCodeAt(0) < 32) {
    key.ctrl = true;
    key.name = String.fromCharCode(str.charCodeAt(0) + 64).toLowerCase();
    return { str, key };
  }

  return { str, key };
}

export function createXtermStdio(term) {
  if (!term || typeof term.write !== 'function') {
    throw new TypeError('createXtermStdio expects an xterm Terminal');
  }

  let stdin = new Readable();
  stdin.isTTY = true;

  let columns = () => {
    try {
      return term.cols || 80;
    } catch {
      return 80;
    }
  };
  let rows = () => {
    try {
      return term.rows || 24;
    } catch {
      return 24;
    }
  };

  let stdout = new Writable({
    write(chunk, encoding, callback) {
      try {
        let text = chunkToString(chunk, encoding);
        term.write(text);
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
  Object.defineProperty(stdout, 'columns', { get: columns, enumerable: true });
  Object.defineProperty(stdout, 'rows', { get: rows, enumerable: true });
  stdout.isTTY = true;

  let stderr = new Writable({
    write(chunk, encoding, callback) {
      try {
        term.write(chunkToString(chunk, encoding));
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
  Object.defineProperty(stderr, 'columns', { get: columns, enumerable: true });
  stderr.isTTY = true;

  let disposeData = term.onData(data => {
    let { str, key } = parseKeypress(data);
    stdin.emit('keypress', str, key);
    stdin.push(data);
  });

  let disposeResize = null;
  if (typeof term.onResize === 'function') {
    disposeResize = term.onResize(() => {
      stdout.emit('resize');
      stderr.emit('resize');
    });
  }

  function dispose() {
    try {
      disposeData?.dispose?.();
    } catch {}
    try {
      disposeResize?.dispose?.();
    } catch {}
    stdin.destroy?.();
    stdout.destroy?.();
    stderr.destroy?.();
  }

  return { stdin, stdout, stderr, dispose, parseKeypress };
}

export { EventEmitter, Readable, Writable };
