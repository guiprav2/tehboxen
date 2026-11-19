/* <net/if_arp.h> for Tehboxen WASI programs: ARP header and the SIOC*ARP cache requests. */
#ifndef _NET_IF_ARP_H
#define _NET_IF_ARP_H
#include <stdint.h>
#include <sys/socket.h>
#define MAX_ADDR_LEN 7
#define ARPOP_REQUEST 1
#define ARPOP_REPLY 2
#define ARPOP_RREQUEST 3
#define ARPOP_RREPLY 4
#define ARPHRD_NETROM 0
#define ARPHRD_ETHER 1
#define ARPHRD_LOOPBACK 772
#define ARPHRD_VOID 0xFFFF
#define ARPHRD_NONE 0xFFFE
#define ATF_COM 0x02
#define ATF_PERM 0x04
#define ATF_PUBL 0x08
struct arphdr {
  uint16_t ar_hrd, ar_pro;
  uint8_t ar_hln, ar_pln;
  uint16_t ar_op;
};
struct arpreq {
  struct sockaddr arp_pa;
  struct sockaddr arp_ha;
  int arp_flags;
  struct sockaddr arp_netmask;
  char arp_dev[16];
};
#define SIOCDARP 0x8953
#define SIOCGARP 0x8954
#define SIOCSARP 0x8955
#endif
