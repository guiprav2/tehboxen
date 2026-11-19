/* <net/ethernet.h> for Tehboxen WASI programs. */
#ifndef _NET_ETHERNET_H
#define _NET_ETHERNET_H
#include <stdint.h>
#define ETH_ALEN 6
#define ETH_HLEN 14
#define ETH_ZLEN 60
#define ETH_DATA_LEN 1500
#define ETH_FRAME_LEN 1514
#define ETH_P_IP 0x0800
#define ETH_P_ARP 0x0806
#define ETH_P_ALL 0x0003
#define ETHERTYPE_IP 0x0800
#define ETHERTYPE_ARP 0x0806
#define ETHER_ADDR_LEN ETH_ALEN
struct ether_addr {
  uint8_t ether_addr_octet[ETH_ALEN];
};
struct ether_header {
  uint8_t ether_dhost[ETH_ALEN];
  uint8_t ether_shost[ETH_ALEN];
  uint16_t ether_type;
};
struct ethhdr {
  unsigned char h_dest[ETH_ALEN];
  unsigned char h_source[ETH_ALEN];
  uint16_t h_proto;
};
#endif
