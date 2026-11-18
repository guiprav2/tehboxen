/*
 * libtehboxen: POSIX process calls WASI preview1 lacks, for programs built by
 * the Tehboxen toolchain (linked by default with -ltehboxen).
 *
 *   system(cmd)        runs cmd with the Tehboxen shell (like sh -c); the
 *                      child's stdout/stderr go to this process's; returns a
 *                      wait status (use WEXITSTATUS from <sys/wait.h>).
 *   popen(cmd, mode)   "r": runs cmd now, its output becomes the stream;
 *                      "w": what's written is cmd's stdin when pclose runs it.
 *   pclose(f)          closes, returns cmd's wait status.
 *
 * Startup: __tehboxen_init (a constructor the toolchain keeps by
 * linking with --export=__tehboxen_init, so --gc-sections can't drop it) sets wasi-libc's cwd to the process's real cwd, so
 * relative paths resolve like on POSIX and absolute paths reach the "/"
 * preopen instead of the cwd one.
 *
 * The shell is reached through the `tehboxen.system` import, the cwd through
 * `tehboxen.getcwd` (other/node/wasi.js).
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((import_module("tehboxen"), import_name("system"))) int __tehboxen_system(const char *cmd, size_t len);
__attribute__((import_module("tehboxen"), import_name("getcwd"))) int __tehboxen_getcwd(char *buf, size_t len);

__attribute__((constructor)) void __tehboxen_init(void) {
  char buf[1024];
  int n = __tehboxen_getcwd(buf, sizeof buf - 1);
  if (n <= 0 || n >= (int)sizeof buf) return;
  buf[n] = 0;
  chdir(buf);
}

static int run(const char *cmd) {
  fflush(NULL);
  int code = __tehboxen_system(cmd, strlen(cmd));
  if (code < 0) {
    errno = ENOSYS;
    return -1;
  }
  /* 128+N from the shell means killed by signal N. */
  if (code > 128 && code < 160) return code - 128;
  return (code & 0xff) << 8;
}

int system(const char *cmd) {
  if (!cmd) return 1; /* a shell is available */
  return run(cmd);
}

struct popen_entry {
  FILE *f;
  int writing;
  char *cmd;
  char path[64];
  struct popen_entry *next;
};
static struct popen_entry *entries;

static char *quote(const char *s) {
  size_t n = 3;
  for (const char *p = s; *p; p++) n += *p == '\'' ? 4 : 1;
  char *out = malloc(n), *o = out;
  if (!out) return 0;
  *o++ = '\'';
  for (const char *p = s; *p; p++) {
    if (*p == '\'') {
      memcpy(o, "'\\''", 4);
      o += 4;
    } else *o++ = *p;
  }
  *o++ = '\'';
  *o = 0;
  return out;
}

static char *redirect(const char *cmd, const char *op, const char *path) {
  char *q = quote(path);
  if (!q) return 0;
  size_t n = strlen(cmd) + strlen(q) + 16;
  char *out = malloc(n);
  if (out) snprintf(out, n, "{ %s\n} %s %s", cmd, op, q);
  free(q);
  return out;
}

FILE *popen(const char *cmd, const char *mode) {
  if (!cmd || !mode || (mode[0] != 'r' && mode[0] != 'w')) {
    errno = EINVAL;
    return 0;
  }
  struct popen_entry *e = calloc(1, sizeof *e);
  if (!e) return 0;
  unsigned long r = 0;
  getentropy(&r, sizeof r);
  snprintf(e->path, sizeof e->path, "/tmp/.popen-%08lx%04x", r, (unsigned)(size_t)e & 0xffff);
  e->writing = mode[0] == 'w';
  if (e->writing) {
    e->cmd = strdup(cmd);
    e->f = e->cmd ? fopen(e->path, "w") : 0;
  } else {
    char *full = redirect(cmd, ">", e->path);
    if (full) {
      run(full);
      free(full);
      e->f = fopen(e->path, "r");
    }
  }
  if (!e->f) {
    free(e->cmd);
    free(e);
    return 0;
  }
  e->next = entries;
  entries = e;
  return e->f;
}

int pclose(FILE *f) {
  struct popen_entry **pp = &entries;
  while (*pp && (*pp)->f != f) pp = &(*pp)->next;
  struct popen_entry *e = *pp;
  if (!e) {
    errno = ECHILD;
    return -1;
  }
  *pp = e->next;
  fclose(f);
  int status = 0;
  if (e->writing) {
    char *full = redirect(e->cmd, "<", e->path);
    status = full ? run(full) : -1;
    free(full);
  }
  unlink(e->path);
  free(e->cmd);
  free(e);
  return status;
}
