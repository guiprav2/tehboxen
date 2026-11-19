/*
 * <resolv.h> for Tehboxen WASI programs: the classic resolver state and DNS
 * message helpers (res_init, res_mkquery, res_send/res_query, dn_expand,
 * dn_comp, dn_skipname). Queries are real DNS over UDP on the simulated
 * network, to the nameservers in /etc/resolv.conf.
 */
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <arpa/nameser.h>
#include <resolv.h>

struct __res_state _res;

int res_init(void) {
  memset(&_res, 0, sizeof _res);
  _res.retrans = RES_TIMEOUT;
  _res.retry = RES_DFLRETRY;
  _res.options = RES_INIT | RES_DEFAULT;
  _res.ndots = 1;
  FILE *f = fopen("/etc/resolv.conf", "r");
  char line[256];
  while (f && fgets(line, sizeof line, f)) {
    char key[32], val[200];
    if (sscanf(line, "%31s %199s", key, val) != 2 || key[0] == '#' || key[0] == ';') continue;
    if (!strcmp(key, "nameserver") && _res.nscount < MAXNS) {
      struct in_addr a;
      if (inet_pton(AF_INET, val, &a) != 1) continue;
      struct sockaddr_in *s = &_res.nsaddr_list[_res.nscount++];
      s->sin_family = AF_INET;
      s->sin_port = htons(53);
      s->sin_addr = a;
    } else if (!strcmp(key, "domain") || !strcmp(key, "search")) {
      snprintf(_res.defdname, sizeof _res.defdname, "%s", val);
    }
  }
  if (f) fclose(f);
  if (!_res.nscount) {
    _res.nscount = 1;
    _res.nsaddr_list[0].sin_family = AF_INET;
    _res.nsaddr_list[0].sin_port = htons(53);
    _res.nsaddr_list[0].sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  }
  _res._u._ext.nscount = 0;
  return 0;
}

int dn_expand(const unsigned char *msg, const unsigned char *eom, const unsigned char *src, char *dst, int space) {
  const unsigned char *p = src;
  char *o = dst, *end = dst + space;
  int len = -1, guard = 0;
  if (p >= eom) return -1;
  while (*p) {
    if (++guard > 128) return -1;
    if ((*p & 0xc0) == 0xc0) {
      if (p + 1 >= eom) return -1;
      if (len < 0) len = (int)(p + 2 - src);
      p = msg + (((p[0] & 0x3f) << 8) | p[1]);
      if (p >= eom) return -1;
      continue;
    }
    int l = *p++;
    if (p + l > eom) return -1;
    if (o != dst) {
      if (o >= end) return -1;
      *o++ = '.';
    }
    if (o + l >= end) return -1;
    memcpy(o, p, (size_t)l);
    o += l;
    p += l;
  }
  if (o >= end) return -1;
  *o = 0;
  if (o == dst && space > 1) {
    dst[0] = 0;
  }
  return len < 0 ? (int)(p + 1 - src) : len;
}

int dn_skipname(const unsigned char *p, const unsigned char *eom) {
  const unsigned char *s = p;
  while (p < eom) {
    if (!*p) return (int)(p + 1 - s);
    if ((*p & 0xc0) == 0xc0) return p + 2 <= eom ? (int)(p + 2 - s) : -1;
    p += *p + 1;
  }
  return -1;
}

int dn_comp(const char *src, unsigned char *dst, int space, unsigned char **dnptrs, unsigned char **lastdnptr) {
  (void)dnptrs, (void)lastdnptr; /* no compression */
  unsigned char *o = dst, *end = dst + space;
  const char *p = src;
  while (*p) {
    const char *dot = strchr(p, '.');
    size_t l = dot ? (size_t)(dot - p) : strlen(p);
    if (l > 63 || o + l + 1 >= end) return -1;
    if (l) {
      *o++ = (unsigned char)l;
      memcpy(o, p, l);
      o += l;
    }
    p += l;
    if (*p == '.') p++;
  }
  if (o >= end) return -1;
  *o++ = 0;
  return (int)(o - dst);
}

int res_mkquery(int op, const char *dname, int class, int type, const unsigned char *data, int datalen, const unsigned char *newrr, unsigned char *buf, int buflen) {
  (void)data, (void)datalen, (void)newrr;
  if (buflen < 12) return -1;
  if (!(_res.options & RES_INIT)) res_init();
  memset(buf, 0, 12);
  unsigned id = (unsigned)rand() & 0xffff;
  buf[0] = id >> 8;
  buf[1] = id & 255;
  buf[2] = (unsigned char)((op & 15) << 3) | ((_res.options & RES_RECURSE) ? 1 : 0);
  buf[5] = 1;
  int n = dn_comp(dname, buf + 12, buflen - 12 - 4, 0, 0);
  if (n < 0) return -1;
  unsigned char *q = buf + 12 + n;
  q[0] = (unsigned char)(type >> 8);
  q[1] = (unsigned char)type;
  q[2] = (unsigned char)(class >> 8);
  q[3] = (unsigned char)class;
  return 12 + n + 4;
}

int res_send(const unsigned char *msg, int len, unsigned char *ans, int anslen) {
  if (!(_res.options & RES_INIT)) res_init();
  int s = socket(AF_INET, SOCK_DGRAM, 0);
  if (s < 0) return -1;
  for (int attempt = 0; attempt < (_res.retry > 0 ? _res.retry : 2); attempt++) {
    for (int i = 0; i < _res.nscount; i++) {
      sendto(s, msg, (size_t)len, 0, (struct sockaddr *)&_res.nsaddr_list[i], sizeof _res.nsaddr_list[i]);
      struct pollfd p = {s, POLLIN, 0};
      if (poll(&p, 1, (_res.retrans > 0 ? _res.retrans : 5) * 1000) <= 0) continue;
      ssize_t n = recv(s, ans, (size_t)anslen, 0);
      if (n >= 12 && ans[0] == msg[0] && ans[1] == msg[1]) {
        close(s);
        return (int)n;
      }
    }
  }
  close(s);
  errno = ETIMEDOUT;
  return -1;
}

int res_query(const char *dname, int class, int type, unsigned char *ans, int anslen) {
  unsigned char q[512];
  int n = res_mkquery(0, dname, class, type, 0, 0, 0, q, sizeof q);
  if (n < 0) return -1;
  n = res_send(q, n, ans, anslen);
  if (n < 0) return -1;
  int rcode = ans[3] & 15;
  if (rcode) {
    errno = 0;
    return -1;
  }
  return n;
}

int res_search(const char *dname, int class, int type, unsigned char *ans, int anslen) {
  return res_query(dname, class, type, ans, anslen);
}

/* ---------- ns_* message parsing (musl's libresolv API) ---------- */

const struct _ns_flagdata _ns_flagdata[16] = {
  {0x8000, 15}, {0x7800, 11}, {0x0400, 10}, {0x0200, 9}, {0x0100, 8}, {0x0080, 7}, {0x0040, 6}, {0x0020, 5},
  {0x0010, 4}, {0x000f, 0}, {0, 0}, {0, 0}, {0, 0}, {0, 0}, {0, 0}, {0, 0},
};

unsigned ns_get16(const unsigned char *p) { return (unsigned)(p[0] << 8 | p[1]); }
unsigned long ns_get32(const unsigned char *p) { return (unsigned long)p[0] << 24 | (unsigned long)p[1] << 16 | (unsigned long)p[2] << 8 | p[3]; }
void ns_put16(unsigned s, unsigned char *p) {
  p[0] = (unsigned char)(s >> 8);
  p[1] = (unsigned char)s;
}
void ns_put32(unsigned long l, unsigned char *p) {
  p[0] = (unsigned char)(l >> 24);
  p[1] = (unsigned char)(l >> 16);
  p[2] = (unsigned char)(l >> 8);
  p[3] = (unsigned char)l;
}

int ns_skiprr(const unsigned char *ptr, const unsigned char *eom, ns_sect section, int count) {
  const unsigned char *p = ptr;
  while (count--) {
    int r = dn_skipname(p, eom);
    if (r < 0) goto bad;
    if (r + 2 * 2 > eom - p) goto bad;
    p += r + 2 * 2;
    if (section != ns_s_qd) {
      if (4 + 2 > eom - p) goto bad;
      p += 4;
      unsigned rd = ns_get16(p);
      p += 2;
      if (rd > (unsigned)(eom - p)) goto bad;
      p += rd;
    }
  }
  return (int)(p - ptr);
bad:
  errno = EMSGSIZE;
  return -1;
}

int ns_initparse(const unsigned char *msg, int msglen, ns_msg *handle) {
  handle->_msg = msg;
  handle->_eom = msg + msglen;
  if (msglen < 12) goto bad;
  handle->_id = (uint16_t)ns_get16(msg);
  handle->_flags = (uint16_t)ns_get16(msg + 2);
  for (int i = 0; i < ns_s_max; i++) handle->_counts[i] = (uint16_t)ns_get16(msg + 4 + 2 * i);
  msg += 12;
  for (int i = 0; i < ns_s_max; i++) {
    if (handle->_counts[i]) {
      handle->_sections[i] = msg;
      int r = ns_skiprr(msg, handle->_eom, (ns_sect)i, handle->_counts[i]);
      if (r < 0) return -1;
      msg += r;
    } else handle->_sections[i] = 0;
  }
  if (msg != handle->_eom) goto bad;
  handle->_sect = ns_s_max;
  handle->_rrnum = -1;
  handle->_msg_ptr = 0;
  return 0;
bad:
  errno = EMSGSIZE;
  return -1;
}

int ns_name_uncompress(const unsigned char *msg, const unsigned char *eom, const unsigned char *src, char *dst, size_t dstsiz) {
  int r = dn_expand(msg, eom, src, dst, (int)dstsiz);
  if (r < 0) errno = EMSGSIZE;
  return r;
}

int ns_parserr(ns_msg *handle, ns_sect section, int rrnum, ns_rr *rr) {
  if ((int)section < 0 || section >= ns_s_max) goto bad;
  if (section != handle->_sect) {
    handle->_sect = section;
    handle->_rrnum = 0;
    handle->_msg_ptr = handle->_sections[section];
  }
  if (rrnum == -1) rrnum = handle->_rrnum;
  if (rrnum < 0 || rrnum >= handle->_counts[section]) goto bad;
  if (rrnum < handle->_rrnum) {
    handle->_rrnum = 0;
    handle->_msg_ptr = handle->_sections[section];
  }
  if (rrnum > handle->_rrnum) {
    int r = ns_skiprr(handle->_msg_ptr, handle->_eom, section, rrnum - handle->_rrnum);
    if (r < 0) return -1;
    handle->_msg_ptr += r;
    handle->_rrnum = rrnum;
  }
  int r = ns_name_uncompress(handle->_msg, handle->_eom, handle->_msg_ptr, rr->name, NS_MAXDNAME);
  if (r < 0) return -1;
  handle->_msg_ptr += r;
  if (2 * 2 > handle->_eom - handle->_msg_ptr) goto size;
  rr->type = (uint16_t)ns_get16(handle->_msg_ptr);
  rr->rr_class = (uint16_t)ns_get16(handle->_msg_ptr + 2);
  handle->_msg_ptr += 4;
  if (section != ns_s_qd) {
    if (4 + 2 > handle->_eom - handle->_msg_ptr) goto size;
    rr->ttl = (uint32_t)ns_get32(handle->_msg_ptr);
    rr->rdlength = (uint16_t)ns_get16(handle->_msg_ptr + 4);
    handle->_msg_ptr += 6;
    if (rr->rdlength > handle->_eom - handle->_msg_ptr) goto size;
    rr->rdata = handle->_msg_ptr;
    handle->_msg_ptr += rr->rdlength;
  } else {
    rr->ttl = 0;
    rr->rdlength = 0;
    rr->rdata = 0;
  }
  handle->_rrnum++;
  if (handle->_rrnum > handle->_counts[section]) {
    handle->_sect = section + 1;
    if (handle->_sect == ns_s_max) {
      handle->_rrnum = -1;
      handle->_msg_ptr = 0;
    } else handle->_rrnum = 0;
  }
  return 0;
bad:
  errno = ENODEV;
  return -1;
size:
  errno = EMSGSIZE;
  return -1;
}
