/**
 * util.inspect / util.format for the simulated node runtime.
 * Follows Node's output shape closely enough for console.log of everyday
 * values: objects, arrays, Maps, Sets, errors, classes, typed arrays, cycles.
 */

export let inspectDefaults = {
  depth: 2,
  colors: false,
  showHidden: false,
  breakLength: 80,
  compact: 3,
  maxArrayLength: 100,
  maxStringLength: 10000,
  sorted: false,
};

let STYLES = {
  number: [33, 39],
  bigint: [33, 39],
  boolean: [33, 39],
  undefined: [90, 39],
  null: [1, 22],
  string: [32, 39],
  symbol: [32, 39],
  date: [35, 39],
  regexp: [31, 39],
  special: [36, 39],
  module: [4, 24],
};

export let customInspect = Symbol.for('nodejs.util.inspect.custom');

function stylize(ctx, text, kind) {
  if (!ctx.colors || !STYLES[kind]) return text;
  let [a, b] = STYLES[kind];
  return `\x1b[${a}m${text}\x1b[${b}m`;
}

function quote(str, ctx) {
  let s = str.length > ctx.maxStringLength ? str.slice(0, ctx.maxStringLength) : str;
  let q = !s.includes("'") ? "'" : !s.includes('"') ? '"' : !s.includes('`') ? '`' : "'";
  s = s.replace(/[\\\n\r\t\b\f\v\0]/g, (c) => ({ '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\b': '\\b', '\f': '\\f', '\v': '\\v', '\0': '\\0' })[c]);
  if (q === "'") s = s.replace(/'/g, "\\'");
  let more = str.length > s.length && str.length > ctx.maxStringLength ? `... ${str.length - ctx.maxStringLength} more characters` : '';
  return q + s + q + more;
}

let IDENT = /^[A-Za-z_$][\w$]*$/;

function keyText(key, ctx) {
  if (typeof key === 'symbol') return '[' + stylize(ctx, key.toString(), 'symbol') + ']';
  return IDENT.test(key) ? key : stylize(ctx, quote(key, ctx), 'string');
}

function ctorName(obj) {
  let proto = Object.getPrototypeOf(obj);
  if (proto === null) return null;
  let c = proto.constructor;
  return typeof c === 'function' && c.name ? c.name : 'Object';
}

function prefix(name, tag, fallback, size) {
  let base = name === null ? `[${fallback}: null prototype]` : name;
  if (tag && tag !== name) base += ` [${tag}]`;
  if (size != null) base += `(${size})`;
  return base;
}

function formatPrimitive(v, ctx) {
  switch (typeof v) {
    case 'string':
      return stylize(ctx, quote(v, ctx), 'string');
    case 'number':
      return stylize(ctx, Object.is(v, -0) ? '-0' : String(v), 'number');
    case 'bigint':
      return stylize(ctx, v + 'n', 'bigint');
    case 'boolean':
      return stylize(ctx, String(v), 'boolean');
    case 'undefined':
      return stylize(ctx, 'undefined', 'undefined');
    case 'symbol':
      return stylize(ctx, v.toString(), 'symbol');
  }
  if (v === null) return stylize(ctx, 'null', 'null');
  return null;
}

function formatError(err, ctx) {
  let stack = typeof err.stack === 'string' && err.stack ? err.stack : `${err.name || 'Error'}: ${err.message}`;
  if (!stack.startsWith(String(err.name || ''))) stack = `${err.name}: ${err.message}\n${stack}`;
  let extra = Object.keys(err).filter((k) => k !== 'stack' && k !== 'message');
  if (err.cause !== undefined && !extra.includes('cause')) extra.push('cause');
  if (!extra.length || ctx.seen.length > ctx.depth + 1) return stack;
  let parts = extra.map((k) => `${keyText(k, ctx)}: ${formatValue(err[k], ctx, ctx.currentDepth + 1)}`);
  return `${stack} {\n${parts.map((p) => '  ' + p.replace(/\n/g, '\n  ')).join(',\n')}\n}`;
}

// Ported from Node's lib/internal/util/inspect.js (groupArrayElements / reduceToSingleString).
let ANSI = /\x1b\[[0-9;]*m/g;
function width(str) {
  return str.replace(ANSI, '').length;
}

function groupArrayElements(ctx, output, value) {
  let totalLength = 0;
  let maxLength = 0;
  let outputLength = output.length;
  if (ctx.extraMore) outputLength--;
  let separatorSpace = 2;
  let dataLen = new Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    let len = width(output[i]);
    dataLen[i] = len;
    totalLength += len + separatorSpace;
    if (maxLength < len) maxLength = len;
  }
  let actualMax = maxLength + separatorSpace;
  if (actualMax * 3 + ctx.indentationLvl < ctx.breakLength && (totalLength / actualMax > 5 || maxLength <= 6)) {
    let averageBias = Math.sqrt(actualMax - totalLength / output.length);
    let biasedMax = Math.max(actualMax - 3 - averageBias, 1);
    let columns = Math.min(
      Math.round(Math.sqrt(2.5 * biasedMax * outputLength) / biasedMax),
      Math.floor((ctx.breakLength - ctx.indentationLvl) / actualMax),
      ctx.compact * 4,
      15,
    );
    if (columns <= 1) return output;
    let tmp = [];
    let maxLineLength = [];
    for (let i = 0; i < columns; i++) {
      let lineLength = 0;
      for (let j = i; j < output.length; j += columns) if (dataLen[j] > lineLength) lineLength = dataLen[j];
      maxLineLength.push(lineLength + separatorSpace);
    }
    let padStart = true;
    if (value !== undefined) {
      for (let i = 0; i < output.length; i++) {
        if (typeof value[i] !== 'number' && typeof value[i] !== 'bigint') {
          padStart = false;
          break;
        }
      }
    }
    for (let i = 0; i < outputLength; i += columns) {
      let max = Math.min(i + columns, outputLength);
      let str = '';
      let j = i;
      for (; j < max - 1; j++) {
        let padding = maxLineLength[j - i] + output[j].length - dataLen[j];
        str += padStart ? `${output[j]}, `.padStart(padding, ' ') : `${output[j]}, `.padEnd(padding, ' ');
      }
      if (padStart) {
        let padding = maxLineLength[j - i] + output[j].length - dataLen[j] - separatorSpace;
        str += output[j].padStart(padding, ' ');
      } else str += output[j];
      tmp.push(str);
    }
    if (ctx.extraMore) tmp.push(output[outputLength]);
    output = tmp;
  }
  return output;
}

function reduceToSingle(output, base, braces, ctx, depth, value, isArray) {
  if (ctx.compact !== true) {
    if (typeof ctx.compact === 'number' && ctx.compact >= 1) {
      let entries = output.length;
      if (isArray && entries > 6) output = groupArrayElements(ctx, output, value);
      if (ctx.currentDepth - depth < ctx.compact && entries === output.length) {
        let start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
        let total = output.reduce((n, o) => n + width(o), output.length) + start;
        if (total <= ctx.breakLength && !base.includes('\n') && !output.some((o) => o.includes('\n'))) {
          return `${base ? `${base} ` : ''}${braces[0]} ${output.join(', ')} ${braces[1]}`;
        }
      }
    }
    let ind = `\n${' '.repeat(ctx.indentationLvl)}`;
    return `${base ? `${base} ` : ''}${braces[0]}${ind}  ${output.join(`,${ind}  `)}${ind}${braces[1]}`;
  }
  let start = output.length + ctx.indentationLvl + braces[0].length + base.length + 10;
  let total = output.reduce((n, o) => n + width(o), output.length) + start;
  if (total <= ctx.breakLength) return `${base ? `${base} ` : ''}${braces[0]} ${output.join(', ')} ${braces[1]}`;
  let ind = `\n${' '.repeat(ctx.indentationLvl)}`;
  return `${base ? `${base} ` : ''}${braces[0]}${ind}  ${output.join(`,${ind}  `)}${ind}${braces[1]}`;
}

function formatValue(value, ctx, depth) {
  let prim = formatPrimitive(value, ctx);
  if (prim !== null) return prim;

  if (ctx.customInspect !== false && value && typeof value[customInspect] === 'function') {
    let out = value[customInspect](ctx.depth - depth, { ...ctx, stylize: (t, k) => stylize(ctx, t, k) }, inspect);
    if (out !== value) return typeof out === 'string' ? out : formatValue(out, ctx, depth);
  }

  if (ctx.seen.includes(value)) {
    let idx = ctx.circular.get(value);
    if (idx == null) {
      idx = ctx.circular.size + 1;
      ctx.circular.set(value, idx);
    }
    return stylize(ctx, `[Circular *${idx}]`, 'special');
  }

  let name = ctorName(value);
  let tag = value[Symbol.toStringTag];
  if (typeof tag !== 'string') tag = '';

  if (typeof value === 'function') {
    let kind = /^class\s/.test(Function.prototype.toString.call(value)) ? 'class' : value.constructor?.name === 'AsyncFunction' ? 'AsyncFunction' : value.constructor?.name === 'GeneratorFunction' ? 'GeneratorFunction' : value.constructor?.name === 'AsyncGeneratorFunction' ? 'AsyncGeneratorFunction' : 'Function';
    let base = kind === 'class' ? `[class ${value.name || '(anonymous)'}${Object.getPrototypeOf(value)?.name ? ' extends ' + Object.getPrototypeOf(value).name : ''}]` : `[${kind}${value.name ? ': ' + value.name : ' (anonymous)'}]`;
    let keys = Object.keys(value);
    base = stylize(ctx, base, 'special');
    if (!keys.length || depth > ctx.depth) return base;
    return formatObjectBody(value, keys, ctx, depth, base, ['{', '}']);
  }

  if (value instanceof Error || Object.prototype.toString.call(value) === '[object Error]') return formatError(value, ctx);
  if (value instanceof RegExp) return stylize(ctx, RegExp.prototype.toString.call(value), 'regexp');
  if (value instanceof Date) return stylize(ctx, Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString(), 'date');
  if (value instanceof Promise) return 'Promise { <pending> }'.replace('<pending>', stylize(ctx, '<pending>', 'special'));
  if (value instanceof WeakMap) return 'WeakMap { <items unknown> }';
  if (value instanceof WeakSet) return 'WeakSet { <items unknown> }';
  if (typeof value === 'object' && value instanceof Number) return `[Number: ${formatPrimitive(value.valueOf(), ctx)}]`;
  if (typeof value === 'object' && value instanceof String) return `[String: ${formatPrimitive(value.valueOf(), ctx)}]`;
  if (typeof value === 'object' && value instanceof Boolean) return `[Boolean: ${formatPrimitive(value.valueOf(), ctx)}]`;
  if (typeof value === 'object' && value instanceof Symbol) return `[Symbol: ${formatPrimitive(value.valueOf(), ctx)}]`;

  if (depth > ctx.depth) {
    if (Array.isArray(value)) return value.length ? stylize(ctx, '[Array]', 'special') : '[]';
    if (name === 'Object' && !Object.keys(value).length) return '{}';
    return stylize(ctx, `[${name === null ? 'Object: null prototype' : tag || name}]`, 'special');
  }

  ctx.seen.push(value);
  ctx.currentDepth = depth;
  let out;
  try {
    if (Array.isArray(value)) out = formatList(value, ctx, depth, name === 'Array' ? '' : prefix(name, tag, 'Array', value.length), ['[', ']']);
    else if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      let isBuf = name === 'Buffer' || value._isBuffer;
      if (isBuf) {
        let hex = [];
        for (let i = 0; i < Math.min(value.length, 50); i++) hex.push(value[i].toString(16).padStart(2, '0'));
        out = `<Buffer${hex.length ? ' ' + hex.join(' ') : ''}${value.length > 50 ? ` ... ${value.length - 50} more bytes` : ''}>`;
      } else out = formatList(Array.from(value), ctx, depth, prefix(name, tag, name, value.length), ['[', ']'], true);
    } else if (value instanceof ArrayBuffer) {
      let bytes = new Uint8Array(value);
      let hex = Array.from(bytes.slice(0, 50), (b) => b.toString(16).padStart(2, '0')).join(' ');
      out = `ArrayBuffer { [Uint8Contents]: <${hex}${bytes.length > 50 ? ` ... ${bytes.length - 50} more bytes` : ''}>, byteLength: ${bytes.length} }`;
    } else if (value instanceof Map) {
      let items = [];
      ctx.indentationLvl += 2;
      for (let [k, v] of value) items.push(`${formatValue(k, ctx, depth + 1)} => ${formatValue(v, ctx, depth + 1)}`);
      ctx.indentationLvl -= 2;
      out = items.length ? reduceToSingle(items, prefix(name, tag, 'Map', value.size), ['{', '}'], ctx, depth) : `${prefix(name, tag, 'Map', value.size)} {}`;
    } else if (value instanceof Set) {
      let items = [];
      ctx.indentationLvl += 2;
      for (let v of value) items.push(formatValue(v, ctx, depth + 1));
      ctx.indentationLvl -= 2;
      out = items.length ? reduceToSingle(items, prefix(name, tag, 'Set', value.size), ['{', '}'], ctx, depth) : `${prefix(name, tag, 'Set', value.size)} {}`;
    } else {
      let keys = Object.keys(value);
      if (ctx.showHidden) keys = Object.getOwnPropertyNames(value);
      keys = keys.concat(Object.getOwnPropertySymbols(value).filter((s) => ctx.showHidden || Object.getOwnPropertyDescriptor(value, s)?.enumerable));
      if (ctx.sorted) keys.sort();
      let base = name === 'Object' ? (tag ? `Object [${tag}]` : '') : name === null ? '[Object: null prototype]' : tag && tag !== name ? `${name} [${tag}]` : name;
      if (!keys.length) out = base ? `${base} {}` : '{}';
      else out = formatObjectBody(value, keys, ctx, depth, base, ['{', '}']);
    }
  } finally {
    ctx.seen.pop();
  }
  let ref = ctx.circular.get(value);
  if (ref != null) out = stylize(ctx, `<ref *${ref}>`, 'special') + ' ' + out;
  return out;
}

function propLine(obj, key, ctx, depth) {
  let desc = Object.getOwnPropertyDescriptor(obj, key) || { value: obj[key] };
  let val;
  if (desc.get || desc.set) val = stylize(ctx, desc.get && desc.set ? '[Getter/Setter]' : desc.get ? '[Getter]' : '[Setter]', 'special');
  else {
    ctx.indentationLvl += 2;
    val = formatValue(desc.value, ctx, depth + 1);
    ctx.indentationLvl -= 2;
  }
  return `${keyText(key, ctx)}: ${val}`;
}

function formatObjectBody(obj, keys, ctx, depth, base, braces) {
  let output = keys.map((k) => propLine(obj, k, ctx, depth));
  return reduceToSingle(output, base, braces, ctx, depth);
}

function formatList(arr, ctx, depth, base, braces, numeric = false) {
  let output = [];
  let max = Math.min(arr.length, ctx.maxArrayLength);
  let holes = 0;
  for (let i = 0; i < max; i++) {
    if (!numeric && !Object.prototype.hasOwnProperty.call(arr, i)) {
      holes++;
      continue;
    }
    if (holes) {
      output.push(stylize(ctx, `<${holes} empty item${holes > 1 ? 's' : ''}>`, 'undefined'));
      holes = 0;
    }
    ctx.indentationLvl += 2;
    output.push(formatValue(arr[i], ctx, depth + 1));
    ctx.indentationLvl -= 2;
  }
  if (holes) output.push(stylize(ctx, `<${holes} empty item${holes > 1 ? 's' : ''}>`, 'undefined'));
  if (arr.length > max) output.push(`... ${arr.length - max} more item${arr.length - max > 1 ? 's' : ''}`);
  if (!numeric) {
    for (let k of Object.keys(arr)) if (!/^\d+$/.test(k)) output.push(propLine(arr, k, ctx, depth));
  }
  if (!output.length) return `${base ? base + ' ' : ''}[]`;
  ctx.extraMore = arr.length > max;
  let res = reduceToSingle(output, base, braces, ctx, depth, numeric ? arr : arr, true);
  ctx.extraMore = false;
  return res;
}

export function inspect(value, opts = {}) {
  if (typeof opts === 'boolean') opts = { showHidden: opts };
  let ctx = {
    ...inspectDefaults,
    ...opts,
    seen: [],
    circular: new Map(),
    indentationLvl: 0,
    currentDepth: 0,
  };
  if (ctx.depth === null) ctx.depth = Infinity;
  return formatValue(value, ctx, 0);
}
inspect.custom = customInspect;
inspect.defaultOptions = inspectDefaults;
inspect.styles = STYLES;

export function formatWithOptions(opts, ...args) {
  let first = args[0];
  let out = '';
  let i = 1;
  if (typeof first === 'string') {
    if (args.length === 1) return first;
    out = first.replace(/%([sdifjoOc%])/g, (m, f) => {
      if (f === '%') return '%';
      if (i >= args.length) return m;
      let a = args[i++];
      switch (f) {
        case 's':
          if (typeof a === 'bigint') return a + 'n';
          if (typeof a === 'object' && a !== null) return inspect(a, { ...opts, depth: 0, colors: false, compact: 3 });
          return typeof a === 'symbol' ? a.toString() : String(a);
        case 'd':
          if (typeof a === 'bigint') return a + 'n';
          if (typeof a === 'object' && a !== null) return 'NaN';
          return String(Number(a));
        case 'i':
          if (typeof a === 'bigint') return a + 'n';
          return String(parseInt(a));
        case 'f':
          return String(parseFloat(a));
        case 'j':
          try {
            return JSON.stringify(a);
          } catch {
            return '[Circular]';
          }
        case 'o':
          return inspect(a, { ...opts, showHidden: true, depth: 4 });
        case 'O':
          return inspect(a, opts);
        case 'c':
          return '';
      }
      return m;
    });
  } else i = 0;
  for (; i < args.length; i++) {
    let a = args[i];
    out += (out || i > 0 ? ' ' : '') + (typeof a === 'string' ? a : inspect(a, opts));
  }
  return out;
}

export function format(...args) {
  return formatWithOptions({}, ...args);
}
