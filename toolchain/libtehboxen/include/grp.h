/* Tehboxen: <grp.h> for WASI programs, from the box's /etc/group (libtehboxen). */
#ifndef _GRP_H
#define _GRP_H
#include <sys/types.h>
#ifdef __cplusplus
extern "C" {
#endif
struct group {
  char *gr_name;
  char *gr_passwd;
  gid_t gr_gid;
  char **gr_mem;
};
struct group *getgrnam(const char *);
struct group *getgrgid(gid_t);
struct group *getgrent(void);
void setgrent(void);
void endgrent(void);
#ifdef __cplusplus
}
#endif
#endif
