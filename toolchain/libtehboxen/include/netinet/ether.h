/* <netinet/ether.h> for Tehboxen WASI programs: MAC address text conversion (libtehboxen). */
#ifndef _NETINET_ETHER_H
#define _NETINET_ETHER_H
#include <netinet/if_ether.h>
#ifdef __cplusplus
extern "C" {
#endif
char *ether_ntoa(const struct ether_addr *);
char *ether_ntoa_r(const struct ether_addr *, char *);
struct ether_addr *ether_aton(const char *);
struct ether_addr *ether_aton_r(const char *, struct ether_addr *);
#ifdef __cplusplus
}
#endif
#endif
