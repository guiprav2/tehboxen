/* <sys/sysmacros.h> for Tehboxen WASI programs: device number helpers (no devices in WASI). */
#ifndef _SYS_SYSMACROS_H
#define _SYS_SYSMACROS_H
#define major(dev) ((unsigned)(((dev) >> 8) & 0xfff))
#define minor(dev) ((unsigned)(((dev) & 0xff) | (((dev) >> 12) & 0xfff00)))
#define makedev(ma, mi) ((((ma) & 0xfff) << 8) | ((mi) & 0xff) | (((mi) & 0xfff00) << 12))
#endif
