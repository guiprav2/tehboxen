/** VFS-backed apply_patch (ported from kittygpt/applyPatch.js). */

function join(base, file) {
  let b = String(base || '').replace(/\/+$/, '');
  let f = String(file || '').replace(/^\/+/, '');
  if (!b) return f;
  if (!f) return b;
  return b + '/' + f;
}

export default async function applyPatch(patchText, fs, baseDir = '') {
  if (!fs || typeof fs.read !== 'function' || typeof fs.write !== 'function') {
    throw new TypeError('applyPatch expects a VFS fs adapter');
  }

  let lines = String(patchText || '').split(/\r?\n/);
  let i = 0;
  let pushback = null;
  let nextLine = () => {
    if (pushback !== null) {
      let x = pushback;
      pushback = null;
      return x;
    }
    return lines[i++] ?? null;
  };
  let unread = x => {
    pushback = x;
  };

  let report = [];

  while (i < lines.length || pushback !== null) {
    let line = nextLine();
    if (line == null) break;
    if (line !== '*** Begin Patch') continue;

    let header = nextLine();
    if (!header) throw new Error('Malformed patch: missing file header');

    let m = /^\*\*\* Update File: (.+)$/.exec(header);
    if (m) {
      let filename = m[1].trim();
      let fullPath = join(baseDir, filename);
      let original = (await fs.read(fullPath)) ?? '';
      let originalLines = original.split(/\r?\n/);
      if (original.endsWith('\n')) originalLines.pop();

      let ops = [];
      while (true) {
        let l = nextLine();
        if (l == null) throw new Error('Malformed patch: missing End Patch');
        if (l === '*** End Patch') break;
        if (l.startsWith('*** ')) {
          unread(l);
          break;
        }
        if (l.startsWith('@@')) {
          ops.push({ type: 'hunk', lines: [l] });
          continue;
        }
        if (!ops.length) continue;
        ops[ops.length - 1].lines.push(l);
      }

      let out = [...originalLines];
      for (let op of ops) {
        if (op.type !== 'hunk') continue;
        out = applyHunk(out, op.lines);
      }
      let text = out.join('\n');
      if (original.endsWith('\n') || text.length) text += original.endsWith('\n') || out.length ? '\n' : '';
      // Prefer trailing newline for text files
      if (!text.endsWith('\n') && text.length) text += '\n';
      await fs.write(fullPath, text);
      report.push(`Updated ${filename}`);
      continue;
    }

    m = /^\*\*\* Add File: (.+)$/.exec(header);
    if (m) {
      let filename = m[1].trim();
      let fullPath = join(baseDir, filename);
      let body = [];
      while (true) {
        let l = nextLine();
        if (l == null) throw new Error('Malformed patch: missing End Patch');
        if (l === '*** End Patch') break;
        if (l.startsWith('*** ')) {
          unread(l);
          break;
        }
        if (l.startsWith('+')) body.push(l.slice(1));
        else if (l.startsWith(' ')) body.push(l.slice(1));
      }
      let text = body.join('\n');
      if (text.length) text += '\n';
      await fs.write(fullPath, text);
      report.push(`Added ${filename}`);
      continue;
    }

    m = /^\*\*\* Delete File: (.+)$/.exec(header);
    if (m) {
      let filename = m[1].trim();
      let fullPath = join(baseDir, filename);
      await fs.remove(fullPath);
      report.push(`Deleted ${filename}`);
      while (true) {
        let l = nextLine();
        if (l == null || l === '*** End Patch') break;
        if (l.startsWith('*** ')) {
          unread(l);
          break;
        }
      }
      continue;
    }

    throw new Error('Malformed patch header: ' + header);
  }

  return report.length ? report.join('\n') : 'No patch operations';
}

function applyHunk(lines, hunkLines) {
  // Minimal @@ context apply: walk + / - / space lines
  let i = 1; // skip @@ header
  let result = [...lines];
  // Find start via first context/remove line
  let needle = [];
  for (let j = i; j < hunkLines.length; j++) {
    let l = hunkLines[j];
    if (l.startsWith(' ') || l.startsWith('-')) needle.push(l.slice(1));
    if (needle.length >= 3) break;
  }
  let start = 0;
  if (needle.length) {
    let joined = lines;
    outer: for (let s = 0; s < joined.length; s++) {
      for (let k = 0; k < needle.length; k++) {
        if (joined[s + k] !== needle[k]) continue outer;
      }
      start = s;
      break;
    }
  }

  let out = result.slice(0, start);
  let cursor = start;
  for (; i < hunkLines.length; i++) {
    let l = hunkLines[i];
    if (l.startsWith('@@')) continue;
    if (l.startsWith(' ')) {
      out.push(l.slice(1));
      cursor++;
    } else if (l.startsWith('-')) {
      cursor++;
    } else if (l.startsWith('+')) {
      out.push(l.slice(1));
    }
  }
  out.push(...result.slice(cursor));
  return out;
}
