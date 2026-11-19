/* Tehboxen: <pwd.h> for WASI programs, from the box's /etc/passwd (libtehboxen). */
#ifndef _PWD_H
#define _PWD_H
#include <sys/types.h>
#ifdef __cplusplus
extern "C" {
#endif
struct passwd {
  char *pw_name;
  char *pw_passwd;
  uid_t pw_uid;
  gid_t pw_gid;
  char *pw_gecos;
  char *pw_dir;
  char *pw_shell;
};
struct passwd *getpwnam(const char *);
struct passwd *getpwuid(uid_t);
struct passwd *getpwent(void);
void setpwent(void);
void endpwent(void);
#ifdef __cplusplus
}
#endif
#endif
