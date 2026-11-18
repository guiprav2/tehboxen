/* Tehboxen: wait-status macros for system()/pclose() (wasi-libc has no <sys/wait.h>). */
#ifndef _SYS_WAIT_H
#define _SYS_WAIT_H
#define WEXITSTATUS(s) (((s) & 0xff00) >> 8)
#define WTERMSIG(s) ((s) & 0x7f)
#define WSTOPSIG(s) WEXITSTATUS(s)
#define WIFEXITED(s) (!WTERMSIG(s))
#define WIFSIGNALED(s) (((s) & 0xffff) - 1U < 0xffu)
#define WIFSTOPPED(s) 0
#define WNOHANG 1
#define WUNTRACED 2
#endif
