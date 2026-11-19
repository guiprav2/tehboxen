/* Force-included by the Tehboxen toolchain: declarations wasi-libc leaves out (defined in libtehboxen). */
#ifndef __TEHBOXEN_COMPAT_H
#define __TEHBOXEN_COMPAT_H
#ifndef __ASSEMBLER__
#ifdef __cplusplus
extern "C" {
#endif
struct _IO_FILE;
struct _IO_FILE *popen(const char *, const char *);
int pclose(struct _IO_FILE *);
/* User ids of the process (wasi-libc leaves these out; defined in libtehboxen). */
unsigned getuid(void);
unsigned geteuid(void);
unsigned getgid(void);
unsigned getegid(void);
/* No processes to fork/exec in WASI: these fail like on a system without fork
 * (use system()/popen()); umask is kept per process. */
unsigned umask(unsigned);
int kill(int, int);
int fork(void);
int vfork(void);
int execvp(const char *, char *const[]);
int execl(const char *, const char *, ...);
int execlp(const char *, const char *, ...);
int execv(const char *, char *const[]);
int execve(const char *, char *const[], char *const[]);
int waitpid(int, int *, int);
int wait(int *);
/* Owners, identities, temp files and other calls wasi-libc leaves out (libtehboxen posix.c). */
int chown(const char *, unsigned, unsigned);
int lchown(const char *, unsigned, unsigned);
int fchown(int, unsigned, unsigned);
int fchownat(int, const char *, unsigned, unsigned, int);
int setuid(unsigned);
int setgid(unsigned);
int seteuid(unsigned);
int setegid(unsigned);
int setreuid(unsigned, unsigned);
int setregid(unsigned, unsigned);
int setgroups(__SIZE_TYPE__, const unsigned *);
int initgroups(const char *, unsigned);
int getgroups(int, unsigned[]);
int getgrouplist(const char *, unsigned, unsigned *, int *);
int setsid(void);
int getsid(int);
int getpgrp(void);
int setpgid(int, int);
int getppid(void);
int mkstemp(char *);
int mkostemp(char *, int);
int mkstemps(char *, int);
int mkostemps(char *, int, int);
char *mkdtemp(char *);
char *mktemp(char *);
int mknod(const char *, unsigned, unsigned long long);
int mkfifo(const char *, unsigned);
int sched_getaffinity(int, __SIZE_TYPE__, void *);
int fchdir(int);
int chroot(const char *);
struct timeval;
struct timezone;
int settimeofday(const struct timeval *, const struct timezone *);
int tcgetpgrp(int);
int tcsetpgrp(int, int);
void tzset(void);
/* POSIX tz globals (wasi-libc omits them): the world clock is UTC. */
extern long timezone;
extern int daylight;
extern char *tzname[2];
struct _IO_FILE *tmpfile(void);
/* Fork-less process spawning (no fork in WASI): run argv now through the shell; returns its
 * wait status / a pid that waitpid() reaps. */
int tehboxen_run_argv(char *const[]);
int tehboxen_spawn(char *const[]);
/* Become a daemon: the shell stops waiting for this process, which keeps running (stdio is
 * whatever the caller redirected, usually /dev/null). Stands in for fork-and-exit-the-parent. */
int tehboxen_detach(void);
/* Permission bits of a path (WASI's stat has none), or -1. */
int tehboxen_mode(const char *);
/* BSD sockets (libtehboxen socket.c): wasi-libc declares these only for preview 2. */
struct sockaddr;
int socket(int, int, int);
int bind(int, const struct sockaddr *, unsigned);
int listen(int, int);
int connect(int, const struct sockaddr *, unsigned);
int getsockname(int, struct sockaddr *__restrict, unsigned *__restrict);
int getpeername(int, struct sockaddr *__restrict, unsigned *__restrict);
long sendto(int, const void *, __SIZE_TYPE__, int, const struct sockaddr *, unsigned);
long recvfrom(int, void *__restrict, __SIZE_TYPE__, int, struct sockaddr *__restrict, unsigned *__restrict);
int setsockopt(int, int, int, const void *, unsigned);
int gethostname(char *, __SIZE_TYPE__);
#ifdef __cplusplus
}
#endif

/* Socket options: wasi-libc only defines these for preview 2; libtehboxen's sockets
 * (socket.c) take the Linux values for preview 1 too. */
#ifndef SO_REUSEADDR
#define SO_DEBUG 1
#define SO_REUSEADDR 2
#define SO_ERROR 4
#define SO_DONTROUTE 5
#define SO_BROADCAST 6
#define SO_SNDBUF 7
#define SO_RCVBUF 8
#define SO_KEEPALIVE 9
#define SO_OOBINLINE 10
#define SO_PRIORITY 12
#define SO_LINGER 13
#define SO_REUSEPORT 15
#define SO_RCVLOWAT 18
#define SO_SNDLOWAT 19
#define SO_RCVTIMEO 66
#define SO_SNDTIMEO 67
#define SO_BINDTODEVICE 25
#define SO_ACCEPTCONN 30
#define SOMAXCONN 128
#define SOL_IP 0
#define SOL_TCP 6
#define SOL_UDP 17
#endif
#ifndef AF_PACKET
/* Packet sockets (libpcap/libdnet): every frame on an interface, Ethernet framing. */
#define PF_PACKET 17
#define AF_PACKET PF_PACKET
#endif
#ifndef SOCK_RAW
/* wasi-libc numbers SOCK_DGRAM 5 / SOCK_STREAM 6 (WASI filetypes); raw ICMP sockets are libtehboxen's. */
#define SOCK_RAW 3
#define SOCK_RDM 4
#define SOCK_SEQPACKET 7
#endif
#ifndef IPPROTO_ICMPV6
#define IPPROTO_ICMPV6 58
#endif
#ifndef IPPROTO_MAX
#define IPPROTO_MAX 256
#endif
#ifndef EHOSTDOWN
#define EHOSTDOWN 200 /* not a WASI errno; never returned, only compared against */
#endif
/* sendmsg/recvmsg (libtehboxen socket.c: scatter/gather over sendto/recvfrom; no control
 * messages are produced or consumed) and the cmsg helpers preview 1 headers lack. */
#ifndef CMSG_DATA
#ifdef __cplusplus
extern "C" {
#endif
struct cmsghdr {
  unsigned cmsg_len;
  int cmsg_level;
  int cmsg_type;
};
struct msghdr;
long sendmsg(int, const struct msghdr *, int);
long recvmsg(int, struct msghdr *, int);
#ifdef __cplusplus
}
#endif
#define CMSG_ALIGN(len) (((len) + sizeof(long) - 1) & (unsigned)~(sizeof(long) - 1))
#define CMSG_DATA(cmsg) ((unsigned char *)((struct cmsghdr *)(cmsg) + 1))
#define CMSG_SPACE(len) (CMSG_ALIGN(len) + CMSG_ALIGN(sizeof(struct cmsghdr)))
#define CMSG_LEN(len) (CMSG_ALIGN(sizeof(struct cmsghdr)) + (len))
#define CMSG_FIRSTHDR(mhdr) ((mhdr)->msg_controllen >= sizeof(struct cmsghdr) ? (struct cmsghdr *)(mhdr)->msg_control : (struct cmsghdr *)0)
#define CMSG_NXTHDR(mhdr, cmsg) ((struct cmsghdr *)0)
#endif
#ifndef MSG_DONTWAIT
#define MSG_OOB 0x0001
#define MSG_DONTROUTE 0x0004
#define MSG_DONTWAIT 0x0040
#define MSG_NOSIGNAL 0x4000
#endif
#ifndef IP_TTL
#define IP_TOS 1
#define IP_TTL 2
#define IP_HDRINCL 3
#define IP_RECVERR 11
#endif
/* POSIX signals: wasi-libc's emulated signals only have signal()/raise(); libtehboxen
 * (signal.c) adds sigsets, sigaction, sigprocmask… so ported programs compile. Nothing
 * from outside the process interrupts a WASI program (Ctrl-C/kill end it). */
#ifdef _WASI_EMULATED_SIGNAL
#include <signal.h>
#ifndef SIG_BLOCK
#ifdef __cplusplus
extern "C" {
#endif
#ifndef __DEFINED_sigset_t
typedef struct __sigset_t { unsigned long __bits[128 / sizeof(long)]; } sigset_t;
#define __DEFINED_sigset_t
#endif
typedef struct {
  int si_signo, si_errno, si_code;
  int si_pid, si_uid, si_status;
  void *si_addr;
} siginfo_t;
struct sigaction {
  union {
    void (*sa_handler)(int);
    void (*sa_sigaction)(int, siginfo_t *, void *);
  } __sa_handler;
  sigset_t sa_mask;
  int sa_flags;
  void (*sa_restorer)(void);
};
#define sa_handler __sa_handler.sa_handler
#define sa_sigaction __sa_handler.sa_sigaction
#define SIG_BLOCK 0
#define SIG_UNBLOCK 1
#define SIG_SETMASK 2
#define SA_NOCLDSTOP 1
#define SA_NOCLDWAIT 2
#define SA_SIGINFO 4
#define SA_ONSTACK 0x08000000
#define SA_RESTART 0x10000000
#define SA_NODEFER 0x40000000
#define SA_RESETHAND 0x80000000
int sigemptyset(sigset_t *);
int sigfillset(sigset_t *);
int sigaddset(sigset_t *, int);
int sigdelset(sigset_t *, int);
int sigismember(const sigset_t *, int);
int sigprocmask(int, const sigset_t *__restrict, sigset_t *__restrict);
int pthread_sigmask(int, const sigset_t *__restrict, sigset_t *__restrict);
int sigsuspend(const sigset_t *);
int sigaction(int, const struct sigaction *__restrict, struct sigaction *__restrict);
int sigpending(sigset_t *);
int sigwait(const sigset_t *__restrict, int *__restrict);
int siginterrupt(int, int);
int killpg(int, int);
unsigned alarm(unsigned);
int pause(void);
#ifdef __cplusplus
}
#endif
#endif
#endif

/* Interval timers (SIGALRM): libtehboxen keeps the deadline and delivers the signal at blocking
 * calls (recvfrom/poll), which then fail with EINTR, like a kernel interrupting a syscall. */
#ifndef ITIMER_REAL
/* Only struct timeval: including <sys/time.h> here would declare gettimeofday() & co. and break
 * autoconf's `char gettimeofday();` link probes. */
#include <__struct_timeval.h>
#ifdef __cplusplus
extern "C" {
#endif
struct itimerval {
  struct timeval it_interval;
  struct timeval it_value;
};
#define ITIMER_REAL 0
#define ITIMER_VIRTUAL 1
#define ITIMER_PROF 2
int setitimer(int, const struct itimerval *__restrict, struct itimerval *__restrict);
int getitimer(int, struct itimerval *);
unsigned ualarm(unsigned, unsigned);
/* ms until the pending alarm (-1: none); fire it if due (runs the SIGALRM handler), returning 1. */
int tehboxen_alarm_ms(void);
int tehboxen_alarm_fire(void);
#ifdef __cplusplus
}
#endif
#endif

/* Resource limits (libtehboxen posix.c): fixed, generous values; setrlimit accepts lowering. */
#ifndef RLIMIT_NOFILE
#ifdef __cplusplus
extern "C" {
#endif
typedef unsigned long long rlim_t;
struct rlimit {
  rlim_t rlim_cur;
  rlim_t rlim_max;
};
#define RLIM_INFINITY (~0ULL)
#define RLIM_SAVED_MAX RLIM_INFINITY
#define RLIM_SAVED_CUR RLIM_INFINITY
#define RLIMIT_CPU 0
#define RLIMIT_FSIZE 1
#define RLIMIT_DATA 2
#define RLIMIT_STACK 3
#define RLIMIT_CORE 4
#define RLIMIT_RSS 5
#define RLIMIT_NPROC 6
#define RLIMIT_NOFILE 7
#define RLIMIT_MEMLOCK 8
#define RLIMIT_AS 9
#define RLIM_NLIMITS 16
int getrlimit(int, struct rlimit *);
int setrlimit(int, const struct rlimit *);
#ifdef __cplusplus
}
#endif
#endif

/* ioctl: terminal size (TIOCGWINSZ) and interface queries (SIOCGIF*) are libtehboxen's
 * (ioctl.c, via --wrap=ioctl); everything else is wasi-libc's. */
#ifndef TIOCGWINSZ
struct winsize {
  unsigned short ws_row, ws_col, ws_xpixel, ws_ypixel;
};
#define TIOCGWINSZ 0x5413
#define TIOCSWINSZ 0x5414
#define TIOCSCTTY 0x540E
#define TIOCNOTTY 0x5422
#define TIOCGPGRP 0x540F
#define TIOCSPGRP 0x5410
#define TIOCOUTQ 0x5411
#define TIOCSTI 0x5412
#endif
#ifndef _IO
/* Linux ioctl request encoding (_IO/_IOR/_IOW/_IOWR). */
#define _IOC(dir, type, nr, size) (((dir) << 30) | ((size) << 16) | ((type) << 8) | (nr))
#define _IO(type, nr) _IOC(0U, (type), (nr), 0)
#define _IOR(type, nr, t) _IOC(2U, (type), (nr), sizeof(t))
#define _IOW(type, nr, t) _IOC(1U, (type), (nr), sizeof(t))
#define _IOWR(type, nr, t) _IOC(3U, (type), (nr), sizeof(t))
#endif
#ifndef SIOCGIFINDEX
#define SIOCGIFDSTADDR 0x8917
#define SIOCSIFDSTADDR 0x8918
#define SIOCSIFBRDADDR 0x891a
#define SIOCGIFNAME 0x8910
#define SIOCGIFCONF 0x8912
#define SIOCGIFFLAGS 0x8913
#define SIOCSIFFLAGS 0x8914
#define SIOCGIFADDR 0x8915
#define SIOCSIFADDR 0x8916
#define SIOCGIFBRDADDR 0x8919
#define SIOCGIFNETMASK 0x891b
#define SIOCSIFNETMASK 0x891c
#define SIOCGIFMTU 0x8921
#define SIOCSIFMTU 0x8922
#define SIOCGIFHWADDR 0x8927
#define SIOCSIFHWADDR 0x8924
#define SIOCGIFINDEX 0x8933
#define SIOCADDRT 0x890B
#define SIOCDELRT 0x890C
#endif
#endif /* __ASSEMBLER__ */
#endif
