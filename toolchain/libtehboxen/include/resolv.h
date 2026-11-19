/* <resolv.h> for Tehboxen WASI programs: res_init reads /etc/resolv.conf; dn_expand /
 * dn_comp / res_mkquery build and read DNS messages (libtehboxen resolv.c). */
#ifndef _RESOLV_H
#define _RESOLV_H
#include <stdint.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/nameser.h>
#ifdef __cplusplus
extern "C" {
#endif
#define MAXNS 3
#define MAXDFLSRCH 3
#define MAXDNSRCH 6
#define LOCALDOMAINPARTS 2
#define RES_TIMEOUT 5
#define MAXRESOLVSORT 10
#define RES_MAXNDOTS 15
#define RES_MAXRETRANS 30
#define RES_MAXRETRY 5
#define RES_DFLRETRY 2
#define RES_MAXTIME 65535
#define RES_INIT 0x00000001
#define RES_DEBUG 0x00000002
#define RES_USEVC 0x00000008
#define RES_RECURSE 0x00000040
#define RES_DEFNAMES 0x00000080
#define RES_DNSRCH 0x00000200
#define RES_DEFAULT (RES_RECURSE | RES_DEFNAMES | RES_DNSRCH)
struct __res_state {
  int retrans;
  int retry;
  unsigned long options;
  int nscount;
  struct sockaddr_in nsaddr_list[MAXNS];
  unsigned short id;
  char *dnsrch[MAXDNSRCH + 1];
  char defdname[256];
  unsigned long pfcode;
  unsigned ndots : 4;
  unsigned nsort : 4;
  unsigned ipv6_unavail : 1;
  unsigned unused : 23;
  struct {
    struct in_addr addr;
    uint32_t mask;
  } sort_list[MAXRESOLVSORT];
  void *qhook;
  void *rhook;
  int res_h_errno;
  int _vcsock;
  unsigned _flags;
  union {
    char pad[52];
    struct {
      uint16_t nscount;
      uint16_t nsmap[MAXNS];
      int nssocks[MAXNS];
      uint16_t nscount6;
      uint16_t nsinit;
      struct sockaddr_in6 *nsaddrs[MAXNS];
      unsigned int _initstamp[2];
    } _ext;
  } _u;
};
typedef struct __res_state *res_state;
extern struct __res_state _res;
int res_init(void);
int res_query(const char *, int, int, unsigned char *, int);
int res_search(const char *, int, int, unsigned char *, int);
int res_mkquery(int, const char *, int, int, const unsigned char *, int, const unsigned char *, unsigned char *, int);
int res_send(const unsigned char *, int, unsigned char *, int);
int dn_comp(const char *, unsigned char *, int, unsigned char **, unsigned char **);
int dn_expand(const unsigned char *, const unsigned char *, const unsigned char *, char *, int);
int dn_skipname(const unsigned char *, const unsigned char *);
#ifdef __cplusplus
}
#endif
#endif
