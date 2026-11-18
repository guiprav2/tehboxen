/* Force-included by the Tehboxen toolchain: declarations wasi-libc leaves out (defined in libtehboxen). */
#ifndef __TEHBOXEN_COMPAT_H
#define __TEHBOXEN_COMPAT_H
#ifdef __cplusplus
extern "C" {
#endif
struct _IO_FILE;
struct _IO_FILE *popen(const char *, const char *);
int pclose(struct _IO_FILE *);
#ifdef __cplusplus
}
#endif
#endif
