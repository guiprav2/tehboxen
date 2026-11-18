/** Node `path` (POSIX) for the simulated node runtime: browserify's path-browserify. */
import path from 'https://cdn.jsdelivr.net/npm/path-browserify@1.0.1/+esm';

path.posix = path;
// Tehboxen is POSIX-only; win32 is aliased so `path.win32.*` callers keep working.
path.win32 = path;
export let posix = path;
export default path;
