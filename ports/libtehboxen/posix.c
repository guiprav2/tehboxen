/*
 * More POSIX for Tehboxen WASI programs: signals (in-process only), ioctl
 * (terminal size, interface queries), <net/if.h> name/index helpers, ether
 * address text, syslog, and fork-less process spawning.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
#include <signal.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <net/if.h>
#include <netinet/ether.h>
#include <syslog.h>

#define IMPORT(name) __attribute__((import_module("tehboxen"), import_name(#name)))
IMPORT(ifinfo) int __tb_ifinfo(const char *name, size_t len, int index, void *out);
IMPORT(detach) int __tb_detach(void);

int tehboxen_detach(void) {
  fflush(NULL);
  int e = __tb_detach();
  if (e) {
    errno = e;
    return -1;
  }
  return 0;
}
int tehboxen_winsize(int fd, unsigned short *rows, unsigned short *cols);

/* ---------- signals ---------- */

int sigemptyset(sigset_t *s) {
  memset(s, 0, sizeof *s);
  return 0;
}
int sigfillset(sigset_t *s) {
  memset(s, 0xff, sizeof *s);
  return 0;
}
static int sigbit(int n, unsigned long **word, unsigned long *mask, sigset_t *s) {
  if (n <= 0 || n >= 128) {
    errno = EINVAL;
    return -1;
  }
  *word = &s->__bits[(n - 1) / (8 * sizeof(long))];
  *mask = 1UL << ((n - 1) % (8 * sizeof(long)));
  return 0;
}
int sigaddset(sigset_t *s, int n) {
  unsigned long *w, m;
  if (sigbit(n, &w, &m, s)) return -1;
  *w |= m;
  return 0;
}
int sigdelset(sigset_t *s, int n) {
  unsigned long *w, m;
  if (sigbit(n, &w, &m, s)) return -1;
  *w &= ~m;
  return 0;
}
int sigismember(const sigset_t *s, int n) {
  unsigned long *w, m;
  if (sigbit(n, &w, &m, (sigset_t *)s)) return -1;
  return (*w & m) != 0;
}

static sigset_t blocked;
int sigprocmask(int how, const sigset_t *__restrict set, sigset_t *__restrict old) {
  if (old) *old = blocked;
  if (!set) return 0;
  for (size_t i = 0; i < sizeof blocked.__bits / sizeof blocked.__bits[0]; i++) {
    if (how == SIG_BLOCK) blocked.__bits[i] |= set->__bits[i];
    else if (how == SIG_UNBLOCK) blocked.__bits[i] &= ~set->__bits[i];
    else if (how == SIG_SETMASK) blocked.__bits[i] = set->__bits[i];
    else {
      errno = EINVAL;
      return -1;
    }
  }
  return 0;
}
int pthread_sigmask(int how, const sigset_t *__restrict set, sigset_t *__restrict old) {
  return sigprocmask(how, set, old) ? errno : 0;
}

static struct sigaction actions[65];
int sigaction(int sig, const struct sigaction *__restrict act, struct sigaction *__restrict old) {
  if (sig <= 0 || sig > 64 || sig == SIGKILL || sig == SIGSTOP) {
    errno = EINVAL;
    return -1;
  }
  if (old) *old = actions[sig];
  if (act) {
    actions[sig] = *act;
    /* wasi-libc's emulation calls plain handlers on raise(); SA_SIGINFO handlers get a minimal siginfo. */
    signal(sig, (act->sa_flags & SA_SIGINFO) ? SIG_DFL : act->sa_handler);
  }
  return 0;
}
int sigpending(sigset_t *s) { return sigemptyset(s); }
int sigsuspend(const sigset_t *mask) {
  (void)mask;
  /* No signal can arrive from outside: wait a little and report an interruption. */
  struct timespec ts = {1, 0};
  nanosleep(&ts, 0);
  errno = EINTR;
  return -1;
}
int sigwait(const sigset_t *__restrict set, int *__restrict sig) {
  (void)set;
  for (;;) sleep(3600);
  *sig = 0;
  return 0;
}
int siginterrupt(int sig, int flag) {
  (void)sig, (void)flag;
  return 0;
}
int killpg(int pgrp, int sig) {
  (void)pgrp, (void)sig;
  errno = ESRCH;
  return -1;
}
/* ---------- alarm / setitimer ---------- */

static long long alarm_at_us;    /* CLOCK_MONOTONIC deadline, 0 = none */
static long long alarm_every_us; /* it_interval */
static long long now_us(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000000 + ts.tv_nsec / 1000;
}
int tehboxen_alarm_ms(void) {
  if (!alarm_at_us) return -1;
  long long left = alarm_at_us - now_us();
  return left <= 0 ? 0 : (int)((left + 999) / 1000);
}
int tehboxen_alarm_fire(void) {
  if (!alarm_at_us || now_us() < alarm_at_us) return 0;
  alarm_at_us = alarm_every_us ? now_us() + alarm_every_us : 0;
  raise(SIGALRM);
  return 1;
}
int setitimer(int which, const struct itimerval *__restrict v, struct itimerval *__restrict old) {
  if (which != ITIMER_REAL) {
    errno = EINVAL;
    return -1;
  }
  if (old) {
    long long left = alarm_at_us ? alarm_at_us - now_us() : 0;
    if (left < 0) left = 0;
    old->it_value.tv_sec = left / 1000000;
    old->it_value.tv_usec = left % 1000000;
    old->it_interval.tv_sec = alarm_every_us / 1000000;
    old->it_interval.tv_usec = alarm_every_us % 1000000;
  }
  if (v) {
    long long val = (long long)v->it_value.tv_sec * 1000000 + v->it_value.tv_usec;
    alarm_every_us = (long long)v->it_interval.tv_sec * 1000000 + v->it_interval.tv_usec;
    alarm_at_us = val ? now_us() + val : 0;
  }
  return 0;
}
int getitimer(int which, struct itimerval *v) { return setitimer(which, 0, v); }
unsigned alarm(unsigned secs) {
  struct itimerval v = {{0, 0}, {secs, 0}}, old;
  setitimer(ITIMER_REAL, &v, &old);
  return (unsigned)old.it_value.tv_sec + (old.it_value.tv_usec ? 1 : 0);
}
unsigned ualarm(unsigned us, unsigned interval) {
  struct itimerval v = {{interval / 1000000, interval % 1000000}, {us / 1000000, us % 1000000}}, old;
  setitimer(ITIMER_REAL, &v, &old);
  return (unsigned)(old.it_value.tv_sec * 1000000 + old.it_value.tv_usec);
}
int pause(void) {
  /* Only a pending alarm can end it. */
  for (;;) {
    int ms = tehboxen_alarm_ms();
    if (ms < 0) {
      sleep(3600);
      continue;
    }
    usleep((useconds_t)ms * 1000);
    if (tehboxen_alarm_fire()) {
      errno = EINTR;
      return -1;
    }
  }
}

/* ---------- interfaces ---------- */

/* What tehboxen.ifinfo fills in (little-endian u32s, then the MAC and the name). */
struct tb_ifinfo {
  uint32_t index, flags, mtu, ip, netmask, broadcast;
  uint8_t mac[6], pad[2];
  char name[16];
};

static int ifinfo_by_name(const char *name, struct tb_ifinfo *out) {
  memset(out, 0, sizeof *out);
  int e = __tb_ifinfo(name, strnlen(name, IFNAMSIZ), 0, out);
  if (e) {
    errno = e;
    return -1;
  }
  return 0;
}
static int ifinfo_by_index(unsigned index, struct tb_ifinfo *out) {
  memset(out, 0, sizeof *out);
  int e = __tb_ifinfo("", 0, (int)index, out);
  if (e) {
    errno = e;
    return -1;
  }
  return 0;
}

unsigned if_nametoindex(const char *name) {
  struct tb_ifinfo i;
  return ifinfo_by_name(name, &i) ? 0 : i.index;
}
char *if_indextoname(unsigned index, char *buf) {
  struct tb_ifinfo i;
  if (ifinfo_by_index(index, &i)) {
    errno = ENXIO;
    return 0;
  }
  snprintf(buf, IF_NAMESIZE, "%s", i.name);
  return buf;
}
struct if_nameindex *if_nameindex(void) {
  struct if_nameindex *list = calloc(17, sizeof *list);
  if (!list) return 0;
  int n = 0;
  for (unsigned idx = 1; idx <= 16; idx++) {
    struct tb_ifinfo i;
    if (ifinfo_by_index(idx, &i)) break;
    list[n].if_index = i.index;
    list[n].if_name = strdup(i.name);
    n++;
  }
  return list;
}
void if_freenameindex(struct if_nameindex *list) {
  if (!list) return;
  for (struct if_nameindex *p = list; p->if_index; p++) free(p->if_name);
  free(list);
}

static void put_in(struct sockaddr *sa, uint32_t ip) {
  struct sockaddr_in in;
  memset(&in, 0, sizeof in);
  in.sin_family = AF_INET;
  in.sin_addr.s_addr = htonl(ip);
  memcpy(sa, &in, sizeof(struct sockaddr) < sizeof in ? sizeof(struct sockaddr) : sizeof in);
}

/* ioctl: terminal size, SIOCGIF* interface queries, FIONBIO; the rest goes to wasi-libc. */
int __real_ioctl(int, int, ...);
int __wrap_ioctl(int fd, int req, ...) {
  va_list ap;
  va_start(ap, req);
  void *arg = va_arg(ap, void *);
  va_end(ap);
  switch (req) {
    case TIOCGWINSZ: {
      struct winsize *w = arg;
      unsigned short rows, cols;
      if (tehboxen_winsize(fd, &rows, &cols)) {
        errno = ENOTTY;
        return -1;
      }
      memset(w, 0, sizeof *w);
      w->ws_row = rows;
      w->ws_col = cols;
      return 0;
    }
    case TIOCSWINSZ:
    case TIOCSCTTY:
    case TIOCNOTTY:
      return 0;
    case TIOCGPGRP:
      if (arg) *(int *)arg = getpid();
      return 0;
    case TIOCSPGRP:
      return 0;
    case SIOCGIFINDEX:
    case SIOCGIFFLAGS:
    case SIOCGIFADDR:
    case SIOCGIFNETMASK:
    case SIOCGIFBRDADDR:
    case SIOCGIFMTU:
    case SIOCGIFHWADDR:
    case SIOCGIFNAME: {
      struct ifreq *r = arg;
      struct tb_ifinfo i;
      if (req == SIOCGIFNAME ? ifinfo_by_index((unsigned)r->ifr_ifindex, &i) : ifinfo_by_name(r->ifr_name, &i)) {
        errno = ENODEV;
        return -1;
      }
      switch (req) {
        case SIOCGIFINDEX: r->ifr_ifindex = (int)i.index; break;
        case SIOCGIFFLAGS: r->ifr_flags = (short)i.flags; break;
        case SIOCGIFADDR:
          if (!i.ip) {
            errno = EADDRNOTAVAIL;
            return -1;
          }
          put_in(&r->ifr_addr, i.ip);
          break;
        case SIOCGIFNETMASK: put_in(&r->ifr_netmask, i.netmask); break;
        case SIOCGIFBRDADDR: put_in(&r->ifr_broadaddr, i.broadcast); break;
        case SIOCGIFMTU: r->ifr_mtu = (int)i.mtu; break;
        case SIOCGIFHWADDR:
          memset(&r->ifr_hwaddr, 0, sizeof r->ifr_hwaddr);
          r->ifr_hwaddr.sa_family = 1; /* ARPHRD_ETHER */
          memcpy(r->ifr_hwaddr.sa_data, i.mac, 6);
          break;
        case SIOCGIFNAME: snprintf(r->ifr_name, IFNAMSIZ, "%s", i.name); break;
      }
      return 0;
    }
    case SIOCGIFCONF: {
      struct ifconf *c = arg;
      int max = c->ifc_len / (int)sizeof(struct ifreq), n = 0;
      for (unsigned idx = 1; idx <= 16 && (!c->ifc_req || n < max); idx++) {
        struct tb_ifinfo i;
        if (ifinfo_by_index(idx, &i)) break;
        if (!i.ip) continue;
        if (c->ifc_req) {
          memset(&c->ifc_req[n], 0, sizeof c->ifc_req[n]);
          snprintf(c->ifc_req[n].ifr_name, IFNAMSIZ, "%s", i.name);
          put_in(&c->ifc_req[n].ifr_addr, i.ip);
        }
        n++;
      }
      c->ifc_len = n * (int)sizeof(struct ifreq);
      return 0;
    }
    case SIOCSIFFLAGS:
    case SIOCSIFADDR:
    case SIOCSIFNETMASK:
    case SIOCSIFMTU:
    case SIOCADDRT:
    case SIOCDELRT:
      /* Configuring interfaces goes through `ip` (the kernel's netlink front end). */
      errno = EPERM;
      return -1;
  }
  return __real_ioctl(fd, req, arg);
}

/* ---------- ethernet addresses ---------- */

char *ether_ntoa_r(const struct ether_addr *a, char *buf) {
  const uint8_t *b = a->ether_addr_octet;
  sprintf(buf, "%x:%x:%x:%x:%x:%x", b[0], b[1], b[2], b[3], b[4], b[5]);
  return buf;
}
char *ether_ntoa(const struct ether_addr *a) {
  static char buf[18];
  return ether_ntoa_r(a, buf);
}
struct ether_addr *ether_aton_r(const char *s, struct ether_addr *a) {
  for (int i = 0; i < 6; i++) {
    char *end;
    unsigned long v = strtoul(s, &end, 16);
    if (end == s || v > 255 || (i < 5 && *end != ':')) return 0;
    a->ether_addr_octet[i] = (uint8_t)v;
    s = end + (i < 5);
  }
  return *s ? 0 : a;
}
struct ether_addr *ether_aton(const char *s) {
  static struct ether_addr a;
  return ether_aton_r(s, &a);
}

/* ---------- syslog: appended to /var/log/syslog ---------- */

static char log_ident[64];
static int log_opts, log_facility = LOG_USER, log_mask = 0xff;
void openlog(const char *ident, int opts, int facility) {
  snprintf(log_ident, sizeof log_ident, "%s", ident ? ident : "");
  log_opts = opts;
  if (facility) log_facility = facility;
}
void closelog(void) {}
int setlogmask(int mask) {
  int old = log_mask;
  if (mask) log_mask = mask;
  return old;
}
void vsyslog(int pri, const char *fmt, va_list ap) {
  if (!(log_mask & LOG_MASK(LOG_PRI(pri)))) return;
  int saved = errno;
  char msg[1024];
  va_list ap2;
  va_copy(ap2, ap);
  /* %m is glibc/musl syslog's strerror(errno). */
  char fmt2[512];
  size_t o = 0;
  for (const char *p = fmt; *p && o < sizeof fmt2 - 64; p++) {
    if (p[0] == '%' && p[1] == 'm') {
      o += (size_t)snprintf(fmt2 + o, sizeof fmt2 - o, "%s", strerror(saved));
      p++;
    } else fmt2[o++] = *p;
  }
  fmt2[o] = 0;
  vsnprintf(msg, sizeof msg, fmt2, ap2);
  va_end(ap2);
  char stamp[32];
  time_t now = time(0);
  strftime(stamp, sizeof stamp, "%b %e %H:%M:%S", localtime(&now));
  char host[64] = "localhost";
  gethostname(host, sizeof host);
  char line[1300];
  int n = snprintf(line, sizeof line, "%s %s %s%s%s%s: %s\n", stamp, host, log_ident[0] ? log_ident : "syslog", (log_opts & LOG_PID) ? "[" : "", "", (log_opts & LOG_PID) ? "]" : "", msg);
  if (log_opts & LOG_PID) n = snprintf(line, sizeof line, "%s %s %s[%d]: %s\n", stamp, host, log_ident[0] ? log_ident : "syslog", getpid(), msg);
  int fd = open("/var/log/syslog", O_WRONLY | O_APPEND | O_CREAT, 0640);
  if (fd >= 0) {
    write(fd, line, (size_t)n);
    close(fd);
  }
  if (fd < 0 || (log_opts & LOG_PERROR)) fprintf(stderr, "%s: %s\n", log_ident[0] ? log_ident : "syslog", msg);
  errno = saved;
}
void syslog(int pri, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vsyslog(pri, fmt, ap);
  va_end(ap);
}

/* ---------- owners, ids, temp files, misc ---------- */

#include <dirent.h>
#include <pwd.h>
#include <grp.h>
#include <sys/stat.h>

IMPORT(chown) int __tb_chown(const char *path, size_t len, int uid, int gid, int follow);
IMPORT(fd_chown) int __tb_fd_chown(int fd, int uid, int gid);

static int abs_path(const char *path, char *buf, size_t size) {
  if (path[0] == '/') return snprintf(buf, size, "%s", path) < (int)size ? 0 : -1;
  if (!getcwd(buf, size)) return -1;
  size_t n = strlen(buf);
  return snprintf(buf + n, size - n, "%s%s", n > 1 ? "/" : "", path) < (int)(size - n) ? 0 : -1;
}
static int do_chown(const char *path, uid_t uid, gid_t gid, int follow) {
  char abs[1024];
  if (abs_path(path, abs, sizeof abs)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  int e = __tb_chown(abs, strlen(abs), (int)uid, (int)gid, follow);
  if (e) {
    errno = e;
    return -1;
  }
  return 0;
}
int chown(const char *path, uid_t uid, gid_t gid) { return do_chown(path, uid, gid, 1); }
int lchown(const char *path, uid_t uid, gid_t gid) { return do_chown(path, uid, gid, 0); }
int fchown(int fd, uid_t uid, gid_t gid) {
  int e = __tb_fd_chown(fd, (int)uid, (int)gid);
  if (e) {
    errno = e;
    return -1;
  }
  return 0;
}
int fchownat(int dirfd, const char *path, uid_t uid, gid_t gid, int flags) {
  (void)dirfd;
  return do_chown(path, uid, gid, !(flags & 0x100 /* AT_SYMLINK_NOFOLLOW */));
}

/* chmod family (--wrap: wasi-libc has ENOSYS stubs that link in anyway); the VFS keeps real modes (owner or root). */
IMPORT(chmod) int __tb_chmod(const char *path, size_t len, int mode);
IMPORT(fd_chmod) int __tb_fd_chmod(int fd, int mode);
int __wrap_chmod(const char *path, mode_t mode) {
  char abs[1024];
  if (abs_path(path, abs, sizeof abs)) {
    errno = ENAMETOOLONG;
    return -1;
  }
  int e = __tb_chmod(abs, strlen(abs), (int)(mode & 07777));
  if (e) {
    errno = e;
    return -1;
  }
  return 0;
}
int __wrap_fchmod(int fd, mode_t mode) {
  int e = __tb_fd_chmod(fd, (int)(mode & 07777));
  if (e) {
    errno = e;
    return -1;
  }
  return 0;
}
int __wrap_fchmodat(int dirfd, const char *path, mode_t mode, int flags) {
  (void)dirfd;
  if (flags & 0x100 /* AT_SYMLINK_NOFOLLOW */) {
    errno = EOPNOTSUPP; /* like Linux: symlinks have no mode of their own */
    return -1;
  }
  return __wrap_chmod(path, mode);
}

/* Processes can't change identity (the shell's sudo/su do); root may "drop" to itself. */
int setuid(uid_t uid) {
  if (uid == getuid() || getuid() == 0) return 0;
  errno = EPERM;
  return -1;
}
int setgid(gid_t gid) {
  if (gid == getgid() || getuid() == 0) return 0;
  errno = EPERM;
  return -1;
}
int seteuid(uid_t uid) { return setuid(uid); }
int setegid(gid_t gid) { return setgid(gid); }
int setreuid(uid_t r, uid_t e) { return setuid(e == (uid_t)-1 ? r : e); }
int setregid(gid_t r, gid_t e) { return setgid(e == (gid_t)-1 ? r : e); }
int setgroups(size_t n, const gid_t *list) {
  (void)n, (void)list;
  if (getuid() == 0) return 0;
  errno = EPERM;
  return -1;
}
int initgroups(const char *user, gid_t gid) {
  (void)user, (void)gid;
  return setgroups(0, 0);
}
pid_t setsid(void) { return getpid(); }
pid_t getsid(pid_t pid) {
  (void)pid;
  return getpid();
}
pid_t getpgrp(void) { return getpid(); }
int setpgid(pid_t pid, pid_t pgid) {
  (void)pid, (void)pgid;
  return 0;
}
pid_t getppid(void) { return 1; }

int getgrouplist(const char *user, gid_t group, gid_t *groups, int *ngroups) {
  int n = 0, max = *ngroups;
  if (n < max) groups[n] = group;
  n++;
  struct group *g;
  setgrent();
  while ((g = getgrent())) {
    if (g->gr_gid == group) continue;
    for (char **m = g->gr_mem; m && *m; m++)
      if (!strcmp(*m, user)) {
        if (n < max) groups[n] = g->gr_gid;
        n++;
        break;
      }
  }
  endgrent();
  *ngroups = n;
  return n > max ? -1 : n;
}
int getgroups(int size, gid_t list[]) {
  struct passwd *pw = getpwuid(getuid());
  gid_t tmp[64];
  int n = 64;
  getgrouplist(pw ? pw->pw_name : "", getgid(), tmp, &n);
  if (n > 64) n = 64;
  if (size == 0) return n;
  if (size < n) {
    errno = EINVAL;
    return -1;
  }
  memcpy(list, tmp, (size_t)n * sizeof(gid_t));
  return n;
}

static void fill_template(char *t, size_t xs) {
  static const char chars[] = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  unsigned char r[16];
  arc4random_buf(r, sizeof r);
  for (size_t i = 0; i < xs; i++) t[i] = chars[r[i % sizeof r] % (sizeof chars - 1)];
}
static char *template_x(char *t, size_t suffix, size_t *xs) {
  size_t n = strlen(t);
  if (n < 6 + suffix || memcmp(t + n - suffix - 6, "XXXXXX", 6)) {
    errno = EINVAL;
    return 0;
  }
  *xs = 6;
  return t + n - suffix - 6;
}
int mkostemps(char *t, int suffix, int flags) {
  size_t xs;
  char *x = template_x(t, (size_t)suffix, &xs);
  if (!x) return -1;
  for (int tries = 0; tries < 100; tries++) {
    fill_template(x, xs);
    int fd = open(t, O_RDWR | O_CREAT | O_EXCL | (flags & ~O_ACCMODE), 0600);
    if (fd >= 0 || errno != EEXIST) return fd;
  }
  return -1;
}
int mkstemp(char *t) { return mkostemps(t, 0, 0); }
int mkostemp(char *t, int flags) { return mkostemps(t, 0, flags); }
int mkstemps(char *t, int suffix) { return mkostemps(t, suffix, 0); }
char *mkdtemp(char *t) {
  size_t xs;
  char *x = template_x(t, 0, &xs);
  if (!x) return 0;
  for (int tries = 0; tries < 100; tries++) {
    fill_template(x, xs);
    if (!mkdir(t, 0700)) return t;
    if (errno != EEXIST) return 0;
  }
  return 0;
}
char *mktemp(char *t) {
  size_t xs;
  char *x = template_x(t, 0, &xs);
  if (!x) {
    if (t) *t = 0;
    return t;
  }
  struct stat st;
  for (int tries = 0; tries < 100; tries++) {
    fill_template(x, xs);
    if (stat(t, &st) && errno == ENOENT) return t;
  }
  *t = 0;
  return t;
}

int mknod(const char *path, mode_t mode, dev_t dev) {
  (void)dev;
  if ((mode & S_IFMT) == S_IFREG || !(mode & S_IFMT)) {
    int fd = open(path, O_WRONLY | O_CREAT | O_EXCL, mode & 07777);
    if (fd < 0) return -1;
    close(fd);
    return 0;
  }
  if ((mode & S_IFMT) == S_IFDIR) return mkdir(path, mode & 07777);
  errno = EPERM; /* no device nodes or fifos */
  return -1;
}
int mkfifo(const char *path, mode_t mode) {
  (void)path, (void)mode;
  errno = ENOSYS;
  return -1;
}

int sched_getaffinity(pid_t pid, size_t size, void *set) {
  (void)pid;
  /* One CPU. */
  memset(set, 0, size);
  if (size) ((unsigned char *)set)[0] = 1;
  return 0;
}

int execlp(const char *file, const char *arg, ...) {
  const char *argv[64];
  int n = 0;
  argv[n++] = arg;
  va_list ap;
  va_start(ap, arg);
  while (n < 63 && (argv[n] = va_arg(ap, const char *))) n++;
  va_end(ap);
  argv[n] = 0;
  return execvp(file, (char *const *)argv);
}
int execl(const char *path, const char *arg, ...) {
  const char *argv[64];
  int n = 0;
  argv[n++] = arg;
  va_list ap;
  va_start(ap, arg);
  while (n < 63 && (argv[n] = va_arg(ap, const char *))) n++;
  va_end(ap);
  argv[n] = 0;
  return execv(path, (char *const *)argv);
}

int fchdir(int fd) {
  (void)fd;
  errno = ENOSYS; /* WASI fds don't expose their path to the program */
  return -1;
}
int chroot(const char *path) {
  (void)path;
  errno = EPERM;
  return -1;
}
int settimeofday(const struct timeval *tv, const struct timezone *tz) {
  (void)tv, (void)tz;
  errno = EPERM;
  return -1;
}

/* ---------- dup: wasi-libc's dup/dup2 fail; the runtime shares the open file ---------- */

IMPORT(dup) int __tb_dup(int oldfd, int newfd, int *out);
static int do_dup(int oldfd, int newfd) {
  int out = -1;
  int e = __tb_dup(oldfd, newfd, &out);
  if (e) {
    errno = e;
    return -1;
  }
  return out;
}
int __wrap_dup(int fd) { return do_dup(fd, -1); }
int __wrap_dup2(int fd, int to) {
  if (to < 0) {
    errno = EBADF;
    return -1;
  }
  return do_dup(fd, to);
}
int __wrap_dup3(int fd, int to, int flags) {
  (void)flags;
  if (fd == to) {
    errno = EINVAL;
    return -1;
  }
  return __wrap_dup2(fd, to);
}

int tcgetpgrp(int fd) {
  (void)fd;
  return getpid();
}
int tcsetpgrp(int fd, int pgrp) {
  (void)fd, (void)pgrp;
  return 0;
}
void tzset(void) {}
long timezone = 0;
int daylight = 0;
char *tzname[2] = { "UTC", "UTC" };

static struct rlimit limits[RLIM_NLIMITS];
static int limits_init;
int getrlimit(int res, struct rlimit *r) {
  if (res < 0 || res >= RLIM_NLIMITS) {
    errno = EINVAL;
    return -1;
  }
  if (!limits_init) {
    for (int i = 0; i < RLIM_NLIMITS; i++) limits[i].rlim_cur = limits[i].rlim_max = RLIM_INFINITY;
    limits[RLIMIT_NOFILE].rlim_cur = limits[RLIMIT_NOFILE].rlim_max = 1024;
    limits[RLIMIT_STACK].rlim_cur = limits[RLIMIT_STACK].rlim_max = 1024 * 1024;
    limits[RLIMIT_CORE].rlim_cur = limits[RLIMIT_CORE].rlim_max = 0;
    limits_init = 1;
  }
  *r = limits[res];
  return 0;
}
int setrlimit(int res, const struct rlimit *r) {
  struct rlimit cur;
  if (getrlimit(res, &cur)) return -1;
  if (r->rlim_cur > r->rlim_max || r->rlim_max > cur.rlim_max) {
    errno = EPERM;
    return -1;
  }
  limits[res] = *r;
  return 0;
}

/* tmpfile: an anonymous temporary file (created in /tmp, unlinked right away). */
FILE *tmpfile(void) {
  char t[] = "/tmp/.tmpfile-XXXXXX";
  int fd = mkstemp(t);
  if (fd < 0) return 0;
  unlink(t);
  FILE *f = fdopen(fd, "w+");
  if (!f) close(fd);
  return f;
}
