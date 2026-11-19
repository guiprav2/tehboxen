#!/usr/bin/env node
// Regenerate world-seed/index.json (the root computer's seed bundle) after
// editing world-seed/. The version is a content hash, so the root computer
// re-seeds (untouched files only) whenever anything changed.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

let root = new URL('../world-seed/', import.meta.url).pathname;
let files = [];
let walk = (dir) => {
  for (let name of readdirSync(dir).sort()) {
    let p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name !== 'index.json') files.push(relative(root, p));
  }
};
walk(root);
let h = createHash('sha256');
for (let f of files) h.update(f + '\0' + readFileSync(join(root, f)) + '\0');
// Contents are inlined: one fetch, and no server can mistake an extensionless path (etc/rc) for a page.
let index = { version: h.digest('hex').slice(0, 16), files: files.map((path) => ({ path, mode: (statSync(join(root, path)).mode & 0o111) ? '755' : undefined, data: readFileSync(join(root, path), 'utf8') })) };
writeFileSync(join(root, 'index.json'), JSON.stringify(index, null, 1) + '\n');
console.log(`world-seed/index.json: ${files.length} files, version ${index.version}`);
