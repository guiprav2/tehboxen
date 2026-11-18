export function decode_ansi_escapes(text) {
  return String(text).replace(/\\(?:u001b|x1b)/gi, '\x1b');
}

export function create_ansi_escape_decoder() {
  let pending = '';
  let markers = ['\\u001b', '\\x1b'];
  return {
    push(text) {
      let value = pending + String(text);
      pending = '';
      let keep = 0;
      for (let marker of markers) {
        for (let length = 1; length < marker.length; length++) {
          if (value.endsWith(marker.slice(0, length))) keep = Math.max(keep, length);
        }
      }
      if (keep) {
        pending = value.slice(-keep);
        value = value.slice(0, -keep);
      }
      return decode_ansi_escapes(value);
    },
    flush() {
      let value = pending;
      pending = '';
      return value;
    },
  };
}
