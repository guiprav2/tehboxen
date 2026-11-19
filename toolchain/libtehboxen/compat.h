/* Force-included by the Tehboxen toolchain: declarations wasi-libc leaves out (defined in libtehboxen). */
#ifndef __TEHBOXEN_COMPAT_H
#define __TEHBOXEN_COMPAT_H
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
int execv(const char *, char *const[]);
int execve(const char *, char *const[], char *const[]);
int waitpid(int, int *, int);
int wait(int *);
/* Permission bits of a path (WASI's stat has none), or -1. */
int tehboxen_mode(const char *);
#ifdef __cplusplus
}
#endif
#endif
