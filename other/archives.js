/**
 * Archive formats Archiver (controllers/Archiver.js) handles, and the box tools behind them.
 * tool: 'zip' (zip/unzip/zipinfo), 'tar' (busybox tar + tarFlag compressor), or a single-file
 * compressor (gzip/bzip2/xz: `tool -c` / `tool -dc`). multi: holds more than one file.
 */
export let ARCHIVE_KINDS = {
  zip: { label: 'ZIP archive', suffix: '.zip', tool: 'zip', multi: true },
  'tar.gz': { label: 'tar + gzip', suffix: '.tar.gz', tool: 'tar', tarFlag: 'z', multi: true },
  tgz: { label: 'tar + gzip', suffix: '.tgz', tool: 'tar', tarFlag: 'z', multi: true },
  'tar.xz': { label: 'tar + xz', suffix: '.tar.xz', tool: 'tar', tarFlag: 'J', multi: true },
  txz: { label: 'tar + xz', suffix: '.txz', tool: 'tar', tarFlag: 'J', multi: true },
  'tar.bz2': { label: 'tar + bzip2', suffix: '.tar.bz2', tool: 'tar', tarFlag: 'j', multi: true },
  tbz2: { label: 'tar + bzip2', suffix: '.tbz2', tool: 'tar', tarFlag: 'j', multi: true },
  tar: { label: 'tar archive', suffix: '.tar', tool: 'tar', tarFlag: '', multi: true },
  gz: { label: 'gzip file', suffix: '.gz', tool: 'gzip', multi: false },
  bz2: { label: 'bzip2 file', suffix: '.bz2', tool: 'bzip2', multi: false },
  xz: { label: 'xz file', suffix: '.xz', tool: 'xz', multi: false },
  lzma: { label: 'lzma file', suffix: '.lzma', tool: 'lzma', multi: false },
};

/** ARCHIVE_KINDS key for a path (longest suffix wins: x.tar.gz is tar.gz, not gz), or null. */
export function archiveKind(path) {
  let p = String(path || '').toLowerCase();
  let best = null;
  for (let [k, info] of Object.entries(ARCHIVE_KINDS)) {
    if (p.endsWith(info.suffix) && p.length > info.suffix.length && (!best || info.suffix.length > ARCHIVE_KINDS[best].suffix.length)) best = k;
  }
  return best;
}
