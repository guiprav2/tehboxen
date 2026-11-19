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
 *   termios            tcgetattr/tcsetattr & co. on the session's terminal
 *                      (<termios.h> ships with the toolchain), tehboxen_winsize.
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
#include <termios.h>
#include <pwd.h>
#include <grp.h>
#include <signal.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

__attribute__((import_module("tehboxen"), import_name("system"))) int __tehboxen_system(const char *cmd, size_t len);
__attribute__((import_module("tehboxen"), import_name("getcwd"))) int __tehboxen_getcwd(char *buf, size_t len);
__attribute__((import_module("tehboxen"), import_name("tty_mode"))) int __tehboxen_tty_mode(int icanon, int echo, int isig, int opost);
__attribute__((import_module("tehboxen"), import_name("tty_size"))) int __tehboxen_tty_size(void);
__attribute__((import_module("tehboxen"), import_name("ids"))) long long __tehboxen_ids(void);
__attribute__((import_module("tehboxen"), import_name("mode"))) int __tehboxen_mode(const char *path, size_t len);
__attribute__((import_module("tehboxen"), import_name("owner"))) int __tehboxen_owner(const char *path, size_t len, int follow, unsigned *out);
__attribute__((import_module("tehboxen"), import_name("fd_owner"))) int __tehboxen_fd_owner(int fd, unsigned *out);

static void snapshot_env(void);
__attribute__((constructor)) void __tehboxen_init(void) {
  snapshot_env();
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

/* ---------- termios ---------- */

static struct termios tty_state;
static int tty_inited;

static void tty_init(void) {
  if (tty_inited) return;
  tty_inited = 1;
  memset(&tty_state, 0, sizeof tty_state);
  tty_state.c_iflag = ICRNL | IXON | IUTF8;
  tty_state.c_oflag = OPOST | ONLCR;
  tty_state.c_cflag = CS8 | CREAD;
  tty_state.c_lflag = ISIG | ICANON | ECHO | ECHOE | ECHOK | ECHOCTL | ECHOKE | IEXTEN;
  cc_t *cc = tty_state.c_cc;
  cc[VINTR] = 3;
  cc[VQUIT] = 28;
  cc[VERASE] = 127;
  cc[VKILL] = 21;
  cc[VEOF] = 4;
  cc[VTIME] = 0;
  cc[VMIN] = 1;
  cc[VSTART] = 17;
  cc[VSTOP] = 19;
  cc[VSUSP] = 26;
  cc[VREPRINT] = 18;
  cc[VWERASE] = 23;
  cc[VLNEXT] = 22;
  tty_state.__c_ispeed = tty_state.__c_ospeed = B38400;
}

static int is_tty(int fd) {
  if (!isatty(fd)) {
    errno = ENOTTY;
    return 0;
  }
  return 1;
}

int tcgetattr(int fd, struct termios *t) {
  if (!is_tty(fd)) return -1;
  tty_init();
  *t = tty_state;
  return 0;
}

int tcsetattr(int fd, int act, const struct termios *t) {
  (void)act;
  if (!is_tty(fd)) return -1;
  tty_init();
  tty_state = *t;
  if (__tehboxen_tty_mode(!!(t->c_lflag & ICANON), !!(t->c_lflag & ECHO), !!(t->c_lflag & ISIG), !!(t->c_oflag & OPOST)) < 0) {
    errno = ENOTTY;
    return -1;
  }
  return 0;
}

speed_t cfgetospeed(const struct termios *t) { return t->__c_ospeed; }
speed_t cfgetispeed(const struct termios *t) { return t->__c_ispeed; }
int cfsetospeed(struct termios *t, speed_t s) { t->__c_ospeed = s; return 0; }
int cfsetispeed(struct termios *t, speed_t s) { t->__c_ispeed = s; return 0; }
int cfsetspeed(struct termios *t, speed_t s) { t->__c_ispeed = t->__c_ospeed = s; return 0; }
void cfmakeraw(struct termios *t) {
  t->c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON);
  t->c_oflag &= ~OPOST;
  t->c_lflag &= ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN);
  t->c_cflag &= ~(CSIZE | PARENB);
  t->c_cflag |= CS8;
  t->c_cc[VMIN] = 1;
  t->c_cc[VTIME] = 0;
}
int tcdrain(int fd) { return is_tty(fd) ? 0 : -1; }
int tcflow(int fd, int a) { (void)a; return is_tty(fd) ? 0 : -1; }
int tcflush(int fd, int q) { (void)q; return is_tty(fd) ? 0 : -1; }
int tcsendbreak(int fd, int d) { (void)d; return is_tty(fd) ? 0 : -1; }

int tehboxen_winsize(int fd, unsigned short *rows, unsigned short *cols) {
  if (!is_tty(fd)) return -1;
  int v = __tehboxen_tty_size();
  if (v < 0) {
    errno = ENOTTY;
    return -1;
  }
  if (rows) *rows = (unsigned short)(v >> 16);
  if (cols) *cols = (unsigned short)(v & 0xffff);
  return 0;
}

/* ---------- users and groups ---------- */

unsigned getuid(void) { return (unsigned)(__tehboxen_ids() >> 32); }
unsigned geteuid(void) { return getuid(); }
unsigned getgid(void) { return (unsigned)(__tehboxen_ids() & 0xffffffff); }
unsigned getegid(void) { return getgid(); }

/* Split one colon-separated line in place. */
static int fields(char *line, char **out, int max) {
  int n = 0;
  char *p = line;
  out[n++] = p;
  for (; *p && n < max; p++) {
    if (*p == ':') {
      *p = 0;
      out[n++] = p + 1;
    } else if (*p == '\n') *p = 0;
  }
  for (; *p; p++) if (*p == '\n') *p = 0;
  return n;
}

static FILE *pw_file;
static char pw_line[1024];
static struct passwd pw_entry;

void setpwent(void) {
  if (pw_file) rewind(pw_file);
}
void endpwent(void) {
  if (pw_file) fclose(pw_file);
  pw_file = 0;
}
struct passwd *getpwent(void) {
  if (!pw_file && !(pw_file = fopen("/etc/passwd", "r"))) return 0;
  while (fgets(pw_line, sizeof pw_line, pw_file)) {
    char *f[7];
    if (pw_line[0] == '#' || fields(pw_line, f, 7) < 7) continue;
    pw_entry.pw_name = f[0];
    pw_entry.pw_passwd = f[1];
    pw_entry.pw_uid = (uid_t)strtoul(f[2], 0, 10);
    pw_entry.pw_gid = (gid_t)strtoul(f[3], 0, 10);
    pw_entry.pw_gecos = f[4];
    pw_entry.pw_dir = f[5];
    pw_entry.pw_shell = f[6];
    return &pw_entry;
  }
  return 0;
}
struct passwd *getpwnam(const char *name) {
  struct passwd *p;
  setpwent();
  while ((p = getpwent()))
    if (!strcmp(p->pw_name, name)) break;
  endpwent();
  return p;
}
struct passwd *getpwuid(uid_t uid) {
  struct passwd *p;
  setpwent();
  while ((p = getpwent()))
    if (p->pw_uid == uid) break;
  endpwent();
  return p;
}

static FILE *gr_file;
static char gr_line[2048];
static char *gr_members[64];
static struct group gr_entry;

void setgrent(void) {
  if (gr_file) rewind(gr_file);
}
void endgrent(void) {
  if (gr_file) fclose(gr_file);
  gr_file = 0;
}
struct group *getgrent(void) {
  if (!gr_file && !(gr_file = fopen("/etc/group", "r"))) return 0;
  while (fgets(gr_line, sizeof gr_line, gr_file)) {
    char *f[4];
    if (gr_line[0] == '#' || fields(gr_line, f, 4) < 4) continue;
    gr_entry.gr_name = f[0];
    gr_entry.gr_passwd = f[1];
    gr_entry.gr_gid = (gid_t)strtoul(f[2], 0, 10);
    int n = 0;
    for (char *m = f[3]; *m && n < 63;) {
      gr_members[n++] = m;
      char *comma = strchr(m, ',');
      if (!comma) break;
      *comma = 0;
      m = comma + 1;
    }
    gr_members[n] = 0;
    gr_entry.gr_mem = gr_members;
    return &gr_entry;
  }
  return 0;
}
struct group *getgrnam(const char *name) {
  struct group *g;
  setgrent();
  while ((g = getgrent()))
    if (!strcmp(g->gr_name, name)) break;
  endgrent();
  return g;
}
struct group *getgrgid(gid_t gid) {
  struct group *g;
  setgrent();
  while ((g = getgrent()))
    if (g->gr_gid == gid) break;
  endgrent();
  return g;
}

/* ---------- processes (no fork in WASI) ---------- */

static unsigned current_umask = 022;
unsigned umask(unsigned mask) {
  unsigned old = current_umask;
  current_umask = mask & 0777;
  return old;
}
int kill(int pid, int sig) {
  (void)sig;
  /* Only this process exists from our point of view. */
  if (pid == 0 || pid == getpid()) return 0;
  errno = ESRCH;
  return -1;
}
int fork(void) {
  errno = ENOSYS;
  return -1;
}
int vfork(void) { return fork(); }
/*
 * exec without replacing the process image: run the program (through the shell, PATH
 * lookup included) and exit with its status — what the caller observes is the same,
 * except the pid. Programs that fork() first still fail at the fork.
 */
int tehboxen_run_argv(char *const argv[]);
static int exec_as(const char *p, char *const a[]) {
  if (!a || !a[0]) {
    errno = EINVAL;
    return -1;
  }
  char **argv = (char **)a;
  char *saved = argv[0];
  argv[0] = (char *)p; /* run the named file; argv[0] is the program name otherwise */
  int st = tehboxen_run_argv(argv);
  argv[0] = saved;
  if (st < 0) return -1;
  if ((st & 0x7f) == 0 && ((st >> 8) & 0xff) == 127) {
    errno = ENOENT;
    return -1;
  }
  fflush(NULL);
  _exit((st & 0x7f) ? 128 + (st & 0x7f) : (st >> 8) & 0xff);
}
int execve(const char *p, char *const a[], char *const e[]) {
  (void)e;
  return exec_as(p, a);
}
int execv(const char *p, char *const a[]) { return exec_as(p, a); }
int execvp(const char *p, char *const a[]) { return exec_as(p, a); }
/*
 * Fork-less children: tehboxen_spawn() runs argv through the shell right away
 * (synchronously, like system()) and records its wait status under a made-up
 * pid, which waitpid()/wait() then reap. Ports replace fork+exec with it.
 */
static struct { int pid, status; } children[32];
static int next_child_pid = 30000;

static char *join_argv(char *const argv[]) {
  size_t n = 1;
  for (int i = 0; argv[i]; i++) {
    char *q = quote(argv[i]);
    if (!q) return 0;
    n += strlen(q) + 1;
    free(q);
  }
  char *cmd = malloc(n), *o = cmd;
  if (!cmd) return 0;
  for (int i = 0; argv[i]; i++) {
    char *q = quote(argv[i]);
    size_t l = strlen(q);
    memcpy(o, q, l);
    o += l;
    *o++ = argv[i + 1] ? ' ' : 0;
    free(q);
  }
  if (o == cmd) *o = 0;
  return cmd;
}

/* The environment the program started with: spawned commands get what it changed since
 * (udhcpc hands its lease to the script that way), as VAR='value' prefix assignments. */
extern char **environ;
static char **initial_env;
void __wasilibc_ensure_environ(void);
static void snapshot_env(void) {
  __wasilibc_ensure_environ(); /* wasi-libc fills environ lazily */
  size_t n = 0;
  while (environ && environ[n]) n++;
  initial_env = calloc(n + 1, sizeof(char *));
  for (size_t i = 0; initial_env && i < n; i++) initial_env[i] = strdup(environ[i]);
}
static int in_initial(const char *kv) {
  for (size_t i = 0; initial_env && initial_env[i]; i++)
    if (!strcmp(initial_env[i], kv)) return 1;
  return 0;
}
static char *env_prefix(void) {
  size_t n = 1;
  for (char **e = environ; e && *e; e++) {
    if (in_initial(*e)) continue;
    char *q = quote(*e);
    if (q) n += strlen(q) + 1, free(q);
  }
  char *out = malloc(n), *o = out;
  if (!out) return 0;
  for (char **e = environ; e && *e; e++) {
    const char *eq = strchr(*e, '=');
    if (!eq || eq == *e || in_initial(*e)) continue;
    /* NAME='value' (quote only the value) */
    size_t kl = (size_t)(eq - *e);
    int ok = 1;
    for (size_t i = 0; i < kl; i++) {
      char c = (*e)[i];
      if (!(c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (i && c >= '0' && c <= '9'))) ok = 0;
    }
    if (!ok) continue;
    char *q = quote(eq + 1);
    if (!q) continue;
    memcpy(o, *e, kl + 1);
    o += kl + 1;
    size_t ql = strlen(q);
    memcpy(o, q, ql);
    o += ql;
    *o++ = ' ';
    free(q);
  }
  *o = 0;
  return out;
}

/** Run argv (PATH lookup by the shell); returns its wait status, or -1. */
int tehboxen_run_argv(char *const argv[]) {
  __wasilibc_ensure_environ();
  char *args = join_argv(argv);
  char *pre = env_prefix();
  char *cmd = args && pre ? malloc(strlen(pre) + strlen(args) + 1) : 0;
  if (cmd) {
    strcpy(cmd, pre);
    strcat(cmd, args);
  }
  free(args);
  free(pre);
  if (!cmd) {
    errno = ENOMEM;
    return -1;
  }
  int st = run(cmd);
  free(cmd);
  return st;
}

/** "Fork and exec" argv: runs it now; returns a pid for waitpid(). */
int tehboxen_spawn(char *const argv[]) {
  int st = tehboxen_run_argv(argv);
  if (st < 0) return -1;
  for (int i = 0; i < 32; i++)
    if (!children[i].pid) {
      children[i].pid = next_child_pid++;
      children[i].status = st;
      return children[i].pid;
    }
  errno = EAGAIN;
  return -1;
}

int waitpid(int pid, int *st, int opt) {
  (void)opt;
  for (int i = 0; i < 32; i++)
    if (children[i].pid && (pid == -1 || pid == 0 || children[i].pid == pid)) {
      int p = children[i].pid;
      if (st) *st = children[i].status;
      children[i].pid = 0;
      return p;
    }
  errno = ECHILD;
  return -1;
}
int wait(int *st) { return waitpid(-1, st, 0); }

/* ---------- permissions (WASI's stat has no mode bits) ---------- */

int tehboxen_mode(const char *path) {
  if (!path || !*path) return -1;
  if (path[0] == '/') return __tehboxen_mode(path, strlen(path));
  char abs[1024];
  if (!getcwd(abs, sizeof abs)) return -1;
  size_t n = strlen(abs);
  if (snprintf(abs + n, sizeof abs - n, "%s%s", n > 1 ? "/" : "", path) >= (int)(sizeof abs - n)) return -1;
  return __tehboxen_mode(abs, strlen(abs));
}

/* ---------- stat with permissions and owners ----------
 * WASI's filestat has no mode bits or owners, so wasi-libc's stat() reports
 * type-only modes (everything looks read-only) and uid/gid 0. The toolchain
 * links with --wrap=stat,lstat,fstat,fstatat so these fill in the VFS's.
 */
int __real_stat(const char *restrict, struct stat *restrict);
int __real_lstat(const char *restrict, struct stat *restrict);
int __real_fstat(int, struct stat *);
int __real_fstatat(int, const char *restrict, struct stat *restrict, int);

static int absolute(const char *path, char *buf, size_t size) {
  if (path[0] == '/') return snprintf(buf, size, "%s", path) < (int)size ? 0 : -1;
  if (!getcwd(buf, size)) return -1;
  size_t n = strlen(buf);
  return snprintf(buf + n, size - n, "%s%s", n > 1 ? "/" : "", path) < (int)(size - n) ? 0 : -1;
}

static void apply(struct stat *st, const unsigned *o) {
  st->st_mode = (st->st_mode & S_IFMT) | (o[0] & 07777);
  st->st_uid = o[1];
  st->st_gid = o[2];
  /* WASI filestat has no block counts (du, ls -s): 512-byte blocks of 4K pages, like ext4. */
  st->st_blksize = 4096;
  st->st_blocks = S_ISDIR(st->st_mode) ? 8 : ((st->st_size + 4095) / 4096) * 8;
}

static void fix_path(const char *path, struct stat *st, int follow) {
  char abs[1024];
  unsigned o[3];
  if (!path || absolute(path, abs, sizeof abs)) return;
  if (__tehboxen_owner(abs, strlen(abs), follow, o) == 0) apply(st, o);
}

int __wrap_stat(const char *restrict path, struct stat *restrict st) {
  int r = __real_stat(path, st);
  if (r == 0) fix_path(path, st, 1);
  return r;
}
int __wrap_lstat(const char *restrict path, struct stat *restrict st) {
  int r = __real_lstat(path, st);
  if (r == 0) fix_path(path, st, 0);
  return r;
}
int __wrap_fstat(int fd, struct stat *st) {
  int r = __real_fstat(fd, st);
  unsigned o[3];
  if (r == 0 && __tehboxen_fd_owner(fd, o) == 0) apply(st, o);
  return r;
}
int __wrap_fstatat(int dirfd, const char *restrict path, struct stat *restrict st, int flags) {
  int r = __real_fstatat(dirfd, path, st, flags);
  // Only cwd-relative or absolute paths can be resolved here.
  if (r == 0 && (dirfd == AT_FDCWD || (path && path[0] == '/'))) fix_path(path, st, !(flags & AT_SYMLINK_NOFOLLOW));
  return r;
}
