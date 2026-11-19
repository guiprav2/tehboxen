/*
 * BSD sockets and name resolution for Tehboxen WASI programs.
 *
 * Sockets are real WASI fds in the runtime (other/node/wasi.js), backed by
 * the box's simulated network stack (other/net/). wasi-libc already maps
 * accept/recv/send/shutdown, read/write/close and poll/select onto them;
 * this adds what WASI preview1 lacks: socket, bind, listen, connect,
 * sendto, recvfrom, getsockname, getpeername, setsockopt and
 * getsockopt(SO_ERROR) (via --wrap), plus <netdb.h>. IPv4 only.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <netpacket/packet.h>
#include <unistd.h>
#include <poll.h>

#define IMPORT(name) __attribute__((import_module("tehboxen"), import_name(#name)))
IMPORT(sock_open) int __tb_sock_open(int type, int *fd);
IMPORT(sock_bind) int __tb_sock_bind(int fd, uint32_t ip, int port);
IMPORT(sock_listen) int __tb_sock_listen(int fd, int backlog);
IMPORT(sock_connect) int __tb_sock_connect(int fd, uint32_t ip, int port);
IMPORT(sock_name) int __tb_sock_name(int fd, int peer, uint32_t *ip, uint32_t *port);
IMPORT(sock_sendto) int __tb_sock_sendto(int fd, const void *buf, size_t len, uint32_t ip, int port, uint32_t *n);
IMPORT(sock_recvfrom) int __tb_sock_recvfrom(int fd, void *buf, size_t len, int flags, uint32_t *ip, uint32_t *port, uint32_t *n);
IMPORT(sock_setopt) int __tb_sock_setopt(int fd, int opt, int value, const char *str, size_t len);
IMPORT(sock_error) int __tb_sock_error(int fd, uint32_t *err);
IMPORT(resolve) int __tb_resolve(const char *name, size_t len, uint32_t *ips, int max, uint32_t *count);
IMPORT(reverse) int __tb_reverse(uint32_t ip, char *buf, size_t len);
IMPORT(gethostname) int __tb_gethostname(char *buf, size_t len);
IMPORT(sock_open2) int __tb_sock_open2(int domain, int type, int proto, int *fd);
IMPORT(sock_bind_ll) int __tb_sock_bind_ll(int fd, int ifindex, int ethertype);
IMPORT(sock_recv_ll) int __tb_sock_recv_ll(int fd, void *buf, size_t len, int flags, void *ll, uint32_t *n);
IMPORT(sock_send_ll) int __tb_sock_send_ll(int fd, const void *buf, size_t len, int ifindex, int ethertype, const void *mac, uint32_t *n);

/* Address family per fd: packet sockets talk sockaddr_ll. */
static unsigned char fd_family[1024];
static int is_packet(int fd) { return fd >= 0 && fd < 1024 && fd_family[fd] == AF_PACKET; }

static int fail(int e) {
  errno = e;
  return -1;
}

static int sin_of(const struct sockaddr *sa, socklen_t len, uint32_t *ip, int *port) {
  if (!sa || len < (socklen_t)sizeof(struct sockaddr_in)) return EINVAL;
  if (sa->sa_family != AF_INET) return EAFNOSUPPORT;
  const struct sockaddr_in *in = (const struct sockaddr_in *)sa;
  *ip = ntohl(in->sin_addr.s_addr);
  *port = ntohs(in->sin_port);
  return 0;
}

static void sin_fill(struct sockaddr *sa, socklen_t *len, uint32_t ip, uint32_t port) {
  if (!sa || !len) return;
  struct sockaddr_in in;
  memset(&in, 0, sizeof in);
  in.sin_family = AF_INET;
  in.sin_port = htons((uint16_t)port);
  in.sin_addr.s_addr = htonl(ip);
  socklen_t n = *len < (socklen_t)sizeof in ? *len : (socklen_t)sizeof in;
  memcpy(sa, &in, n);
  *len = sizeof in;
}

int socket(int domain, int type, int protocol) {
  int base = type & ~(SOCK_NONBLOCK | SOCK_CLOEXEC);
  if (domain == AF_PACKET || (domain == AF_INET && base == SOCK_RAW)) {
    /* Packet sockets (root): every frame on an interface; raw IP: ICMP for all, TCP/UDP/RAW for root.
     * protocol is an ethertype in network order for AF_PACKET. */
    if (domain == AF_PACKET && base != SOCK_RAW && base != SOCK_DGRAM) return fail(EPROTONOSUPPORT);
    int fd = -1;
    int proto = domain == AF_PACKET ? ntohs((uint16_t)protocol) : (protocol ? protocol : IPPROTO_RAW);
    int e = __tb_sock_open2(domain == AF_PACKET ? 17 : 1, base == SOCK_DGRAM ? 5 : 3, proto, &fd);
    if (e) return fail(e);
    if (fd >= 0 && fd < 1024) fd_family[fd] = domain == AF_PACKET ? AF_PACKET : AF_INET;
    if (type & SOCK_NONBLOCK) fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    return fd;
  }
  if (domain != AF_INET) return fail(EAFNOSUPPORT);
  /* Raw sockets: ICMP only (ping, traceroute); the kernel lets everyone have them. */
  if (base == SOCK_RAW && protocol != IPPROTO_ICMP) return fail(EPROTONOSUPPORT);
  if (base != SOCK_STREAM && base != SOCK_DGRAM && base != SOCK_RAW) return fail(EPROTONOSUPPORT);
  int fd = -1;
  int e = __tb_sock_open(base, &fd);
  if (e) return fail(e);
  if (fd >= 0 && fd < 1024) fd_family[fd] = AF_INET;
  if (type & SOCK_NONBLOCK) fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  return fd;
}

int bind(int fd, const struct sockaddr *sa, socklen_t len) {
  if (is_packet(fd)) {
    const struct sockaddr_ll *ll = (const struct sockaddr_ll *)sa;
    if (!sa || len < (socklen_t)sizeof(*ll)) return fail(EINVAL);
    int e = __tb_sock_bind_ll(fd, ll->sll_ifindex, ntohs(ll->sll_protocol));
    return e ? fail(e) : 0;
  }
  uint32_t ip;
  int port;
  int e = sin_of(sa, len, &ip, &port);
  if (!e) e = __tb_sock_bind(fd, ip, port);
  return e ? fail(e) : 0;
}

int listen(int fd, int backlog) {
  int e = __tb_sock_listen(fd, backlog);
  return e ? fail(e) : 0;
}

int connect(int fd, const struct sockaddr *sa, socklen_t len) {
  uint32_t ip;
  int port;
  int e = sin_of(sa, len, &ip, &port);
  if (!e) e = __tb_sock_connect(fd, ip, port);
  return e ? fail(e) : 0;
}

int getsockname(int fd, struct sockaddr *__restrict sa, socklen_t *__restrict len) {
  uint32_t ip = 0, port = 0;
  int e = __tb_sock_name(fd, 0, &ip, &port);
  if (e) return fail(e);
  sin_fill(sa, len, ip, port);
  return 0;
}

int getpeername(int fd, struct sockaddr *__restrict sa, socklen_t *__restrict len) {
  uint32_t ip = 0, port = 0;
  int e = __tb_sock_name(fd, 1, &ip, &port);
  if (e) return fail(e);
  sin_fill(sa, len, ip, port);
  return 0;
}

ssize_t sendto(int fd, const void *buf, size_t len, int flags, const struct sockaddr *sa, socklen_t alen) {
  (void)flags;
  if (is_packet(fd)) {
    const struct sockaddr_ll *ll = sa && alen >= (socklen_t)sizeof(struct sockaddr_ll) ? (const struct sockaddr_ll *)sa : 0;
    uint32_t n = 0;
    int e = __tb_sock_send_ll(fd, buf, len, ll ? ll->sll_ifindex : 0, ll ? ntohs(ll->sll_protocol) : 0, ll && ll->sll_halen ? ll->sll_addr : 0, &n);
    return e ? fail(e) : (ssize_t)n;
  }
  uint32_t ip = 0, n = 0;
  int port = -1; /* -1: no address (connected socket); ICMP and port 0 are real addresses */
  if (sa) {
    int e = sin_of(sa, alen, &ip, &port);
    if (e) return fail(e);
  }
  int e = __tb_sock_sendto(fd, buf, len, ip, port, &n);
  return e ? fail(e) : (ssize_t)n;
}

/* A pending alarm()/setitimer() interrupts a blocking receive: SIGALRM, then EINTR. */
static int wait_or_alarm(int fd) {
  int ms = tehboxen_alarm_ms();
  if (ms < 0 || (fcntl(fd, F_GETFL) & O_NONBLOCK)) return 0;
  struct pollfd p = {fd, POLLIN, 0};
  if (poll(&p, 1, ms) == 0 && tehboxen_alarm_fire()) {
    errno = EINTR;
    return -1;
  }
  return 0;
}

ssize_t recvfrom(int fd, void *__restrict buf, size_t len, int flags, struct sockaddr *__restrict sa, socklen_t *__restrict alen) {
  uint32_t ip = 0, port = 0, n = 0;
  if (wait_or_alarm(fd)) return -1;
  if (is_packet(fd)) {
    struct sockaddr_ll ll;
    memset(&ll, 0, sizeof ll);
    int e = __tb_sock_recv_ll(fd, buf, len, flags, &ll, &n);
    if (e) return fail(e);
    if (sa && alen) {
      socklen_t k = *alen < (socklen_t)sizeof ll ? *alen : (socklen_t)sizeof ll;
      memcpy(sa, &ll, k);
      *alen = sizeof ll;
    }
    return (ssize_t)n;
  }
  int e = __tb_sock_recvfrom(fd, buf, len, flags, &ip, &port, &n);
  if (e) return fail(e);
  sin_fill(sa, alen, ip, port);
  return (ssize_t)n;
}

int setsockopt(int fd, int level, int name, const void *val, socklen_t len) {
  int opt = 0, v = 0;
  if (val && len >= (socklen_t)sizeof(int)) memcpy(&v, val, sizeof v);
  if (level == SOL_SOCKET) {
    if (name == SO_REUSEADDR) opt = 1;
    else if (name == SO_BROADCAST) opt = 2;
    else if (name == SO_BINDTODEVICE) opt = 4;
    else if (name == SO_KEEPALIVE) opt = 5;
  } else if (level == IPPROTO_TCP && name == TCP_NODELAY) opt = 6;
  else if (level == IPPROTO_IP && name == IP_TTL) opt = 7;
  else if (level == IPPROTO_IP && name == IP_HDRINCL) opt = 8;
  /* SOL_PACKET (memberships, versions, rings), SO_ATTACH_FILTER: capture already sees the
   * whole interface and filtering is done by libpcap in userland. Accepted, ignored. */
  if (!opt) return 0; /* accepted and ignored (buffer sizes, linger, timeouts…) */
  int e = __tb_sock_setopt(fd, opt, v, opt == 4 ? (const char *)val : NULL, opt == 4 ? len : 0);
  return e ? fail(e) : 0;
}

/* getsockopt: SO_ERROR (non-blocking connect results) is ours, the rest is wasi-libc's. */
int __real_getsockopt(int, int, int, void *__restrict, socklen_t *__restrict);
int __wrap_getsockopt(int fd, int level, int name, void *__restrict val, socklen_t *__restrict len) {
  if (level == SOL_SOCKET && name == SO_ERROR) {
    uint32_t err = 0;
    int e = __tb_sock_error(fd, &err);
    if (e) return fail(e);
    if (val && len && *len >= (socklen_t)sizeof(int)) {
      int v = (int)err;
      memcpy(val, &v, sizeof v);
      *len = sizeof v;
    }
    return 0;
  }
  if (level == SOL_SOCKET && (name == SO_REUSEADDR || name == SO_KEEPALIVE || name == SO_BROADCAST || name == SO_RCVBUF || name == SO_SNDBUF)) {
    int v = name == SO_RCVBUF || name == SO_SNDBUF ? 212992 : 0;
    if (val && len && *len >= (socklen_t)sizeof v) {
      memcpy(val, &v, sizeof v);
      *len = sizeof v;
    }
    return 0;
  }
  return __real_getsockopt(fd, level, name, val, len);
}

/* accept: WASI's sock_accept has no peer address; fill it in like Linux does. */
int __real_accept(int, struct sockaddr *__restrict, socklen_t *__restrict);
int __real_accept4(int, struct sockaddr *__restrict, socklen_t *__restrict, int);
int __wrap_accept4(int fd, struct sockaddr *__restrict sa, socklen_t *__restrict len, int flags) {
  int c = __real_accept4(fd, 0, 0, flags);
  if (c >= 0 && sa && len) getpeername(c, sa, len);
  return c;
}
int __wrap_accept(int fd, struct sockaddr *__restrict sa, socklen_t *__restrict len) {
  int c = __real_accept(fd, 0, 0);
  if (c >= 0 && sa && len) getpeername(c, sa, len);
  return c;
}

int gethostname(char *name, size_t len) {
  int e = __tb_gethostname(name, len);
  return e ? fail(e) : 0;
}

/* ---------- services and protocols ---------- */

static const struct { const char *name; int port; const char *proto; } SERVICES[] = {
  {"ftp-data", 20, "tcp"}, {"ftp", 21, "tcp"}, {"ssh", 22, "tcp"}, {"telnet", 23, "tcp"}, {"smtp", 25, "tcp"},
  {"domain", 53, "udp"}, {"domain", 53, "tcp"}, {"bootps", 67, "udp"}, {"bootpc", 68, "udp"}, {"tftp", 69, "udp"},
  {"http", 80, "tcp"}, {"www", 80, "tcp"}, {"pop3", 110, "tcp"}, {"ntp", 123, "udp"}, {"imap", 143, "tcp"},
  {"snmp", 161, "udp"}, {"https", 443, "tcp"}, {"syslog", 514, "udp"}, {"imaps", 993, "tcp"}, {"pop3s", 995, "tcp"},
  {"mysql", 3306, "tcp"}, {"postgresql", 5432, "tcp"}, {"http-alt", 8080, "tcp"}, {0, 0, 0},
};

static struct servent serv_ent;
static char *no_aliases[] = {0};

struct servent *getservbyname(const char *name, const char *proto) {
  for (int i = 0; SERVICES[i].name; i++)
    if (!strcmp(SERVICES[i].name, name) && (!proto || !strcmp(SERVICES[i].proto, proto))) {
      serv_ent.s_name = (char *)SERVICES[i].name;
      serv_ent.s_aliases = no_aliases;
      serv_ent.s_port = htons(SERVICES[i].port);
      serv_ent.s_proto = (char *)SERVICES[i].proto;
      return &serv_ent;
    }
  return 0;
}

struct servent *getservbyport(int port, const char *proto) {
  for (int i = 0; SERVICES[i].name; i++)
    if (htons(SERVICES[i].port) == port && (!proto || !strcmp(SERVICES[i].proto, proto))) {
      serv_ent.s_name = (char *)SERVICES[i].name;
      serv_ent.s_aliases = no_aliases;
      serv_ent.s_port = port;
      serv_ent.s_proto = (char *)SERVICES[i].proto;
      return &serv_ent;
    }
  return 0;
}

static struct protoent proto_ent;
struct protoent *getprotobynumber(int n) {
  static const char *names[] = {[0] = "ip", [1] = "icmp", [6] = "tcp", [17] = "udp"};
  if (n < 0 || n > 17 || !names[n]) return 0;
  proto_ent.p_name = (char *)names[n];
  proto_ent.p_aliases = no_aliases;
  proto_ent.p_proto = n;
  return &proto_ent;
}
struct protoent *getprotobyname(const char *name) {
  int n = !strcmp(name, "tcp") ? 6 : !strcmp(name, "udp") ? 17 : !strcmp(name, "icmp") ? 1 : !strcmp(name, "ip") ? 0 : -1;
  return n < 0 ? 0 : getprotobynumber(n);
}

void setservent(int stay) { (void)stay; }
void endservent(void) {}
void sethostent(int stay) { (void)stay; }
void endhostent(void) {}

/* ---------- getaddrinfo & co. ---------- */

int h_errno;

static int lookup(const char *name, uint32_t *ips, int max) {
  struct in_addr a;
  if (inet_pton(AF_INET, name, &a) == 1) {
    ips[0] = ntohl(a.s_addr);
    return 1;
  }
  uint32_t count = 0;
  int e = __tb_resolve(name, strlen(name), ips, max, &count);
  if (e) return e == EAGAIN ? EAI_AGAIN : EAI_NONAME;
  return count ? (int)count : EAI_NONAME;
}

int getaddrinfo(const char *__restrict node, const char *__restrict service, const struct addrinfo *__restrict hints, struct addrinfo **__restrict res) {
  int flags = hints ? hints->ai_flags : 0;
  int family = hints ? hints->ai_family : AF_UNSPEC;
  int socktype = hints ? hints->ai_socktype : 0;
  if (family != AF_UNSPEC && family != AF_INET) return EAI_FAMILY;
  if (!node && !service) return EAI_NONAME;
  int port = 0;
  if (service && *service) {
    char *end;
    long p = strtol(service, &end, 10);
    if (!*end) port = (int)p;
    else if (flags & AI_NUMERICSERV) return EAI_NONAME;
    else {
      struct servent *s = getservbyname(service, socktype == SOCK_DGRAM ? "udp" : socktype == SOCK_STREAM ? "tcp" : 0);
      if (!s) return EAI_SERVICE;
      port = ntohs(s->s_port);
    }
  }
  uint32_t ips[16];
  int n;
  if (!node) {
    ips[0] = (flags & AI_PASSIVE) ? INADDR_ANY : INADDR_LOOPBACK;
    n = 1;
  } else {
    if (flags & AI_NUMERICHOST) {
      struct in_addr a;
      if (inet_pton(AF_INET, node, &a) != 1) return EAI_NONAME;
    }
    n = lookup(node, ips, 16);
    if (n < 0) return n;
  }
  int types[2] = {SOCK_STREAM, SOCK_DGRAM};
  int ntypes = socktype ? 1 : 2;
  if (socktype) types[0] = socktype;
  struct addrinfo *head = 0, **tail = &head;
  for (int i = 0; i < n; i++)
    for (int t = 0; t < ntypes; t++) {
      struct addrinfo *ai = calloc(1, sizeof *ai + sizeof(struct sockaddr_in));
      if (!ai) {
        freeaddrinfo(head);
        return EAI_MEMORY;
      }
      struct sockaddr_in *in = (struct sockaddr_in *)(ai + 1);
      in->sin_family = AF_INET;
      in->sin_port = htons((uint16_t)port);
      in->sin_addr.s_addr = htonl(ips[i]);
      ai->ai_family = AF_INET;
      ai->ai_socktype = types[t];
      ai->ai_protocol = types[t] == SOCK_DGRAM ? IPPROTO_UDP : IPPROTO_TCP;
      ai->ai_addrlen = sizeof *in;
      ai->ai_addr = (struct sockaddr *)in;
      if (!head && (flags & AI_CANONNAME) && node) ai->ai_canonname = strdup(node);
      *tail = ai;
      tail = &ai->ai_next;
    }
  *res = head;
  return 0;
}

void freeaddrinfo(struct addrinfo *ai) {
  while (ai) {
    struct addrinfo *next = ai->ai_next;
    free(ai->ai_canonname);
    free(ai);
    ai = next;
  }
}

const char *gai_strerror(int e) {
  switch (e) {
    case EAI_BADFLAGS: return "Bad value for ai_flags";
    case EAI_NONAME: return "Name or service not known";
    case EAI_AGAIN: return "Temporary failure in name resolution";
    case EAI_FAIL: return "Non-recoverable failure in name resolution";
    case EAI_NODATA: return "No address associated with hostname";
    case EAI_FAMILY: return "ai_family not supported";
    case EAI_SOCKTYPE: return "ai_socktype not supported";
    case EAI_SERVICE: return "Servname not supported for ai_socktype";
    case EAI_MEMORY: return "Memory allocation failure";
    case EAI_SYSTEM: return "System error";
    case EAI_OVERFLOW: return "Argument buffer overflow";
  }
  return "Unknown error";
}

int getnameinfo(const struct sockaddr *__restrict sa, socklen_t salen, char *__restrict host, socklen_t hostlen, char *__restrict serv, socklen_t servlen, int flags) {
  uint32_t ip;
  int port;
  if (sin_of(sa, salen, &ip, &port)) return EAI_FAMILY;
  if (host && hostlen) {
    int done = 0;
    if (!(flags & NI_NUMERICHOST)) done = __tb_reverse(ip, host, hostlen) == 0;
    if (!done) {
      if (flags & NI_NAMEREQD) return EAI_NONAME;
      struct in_addr a = {htonl(ip)};
      if (!inet_ntop(AF_INET, &a, host, hostlen)) return EAI_OVERFLOW;
    }
  }
  if (serv && servlen) {
    struct servent *s = (flags & NI_NUMERICSERV) ? 0 : getservbyport(htons((uint16_t)port), (flags & NI_DGRAM) ? "udp" : "tcp");
    if (s) snprintf(serv, servlen, "%s", s->s_name);
    else snprintf(serv, servlen, "%d", port);
  }
  return 0;
}

static struct hostent host_ent;
static char host_name[256];
static uint32_t host_addrs[16];
static char *host_addr_ptrs[17];

struct hostent *gethostbyname(const char *name) {
  int n = lookup(name, host_addrs, 16);
  if (n < 0) {
    h_errno = n == EAI_AGAIN ? TRY_AGAIN : HOST_NOT_FOUND;
    return 0;
  }
  snprintf(host_name, sizeof host_name, "%s", name);
  for (int i = 0; i < n; i++) {
    host_addrs[i] = htonl(host_addrs[i]);
    host_addr_ptrs[i] = (char *)&host_addrs[i];
  }
  host_addr_ptrs[n] = 0;
  host_ent.h_name = host_name;
  host_ent.h_aliases = no_aliases;
  host_ent.h_addrtype = AF_INET;
  host_ent.h_length = 4;
  host_ent.h_addr_list = host_addr_ptrs;
  return &host_ent;
}

struct hostent *gethostbyname2(const char *name, int af) {
  if (af != AF_INET) {
    h_errno = HOST_NOT_FOUND;
    return 0;
  }
  return gethostbyname(name);
}

struct hostent *gethostbyaddr(const void *addr, socklen_t len, int type) {
  if (type != AF_INET || len < 4) {
    h_errno = HOST_NOT_FOUND;
    return 0;
  }
  uint32_t ip;
  memcpy(&ip, addr, 4);
  if (__tb_reverse(ntohl(ip), host_name, sizeof host_name)) {
    h_errno = HOST_NOT_FOUND;
    return 0;
  }
  host_addrs[0] = ip;
  host_addr_ptrs[0] = (char *)&host_addrs[0];
  host_addr_ptrs[1] = 0;
  host_ent.h_name = host_name;
  host_ent.h_aliases = no_aliases;
  host_ent.h_addrtype = AF_INET;
  host_ent.h_length = 4;
  host_ent.h_addr_list = host_addr_ptrs;
  return &host_ent;
}

const char *hstrerror(int e) {
  switch (e) {
    case HOST_NOT_FOUND: return "Unknown host";
    case TRY_AGAIN: return "Host name lookup failure";
    case NO_RECOVERY: return "Unknown server error";
    case NO_DATA: return "No address associated with name";
  }
  return "Unknown error";
}

void herror(const char *s) {
  fprintf(stderr, "%s%s%s\n", s && *s ? s : "", s && *s ? ": " : "", hstrerror(h_errno));
}

/* ---------- sendmsg / recvmsg: gather/scatter over sendto/recvfrom ---------- */

#include <sys/uio.h>
struct netent *getnetbyname(const char *name) {
  (void)name;
  return 0; /* no /etc/networks */
}
struct netent *getnetbyaddr(uint32_t net, int type) {
  (void)net, (void)type;
  return 0;
}

long sendmsg(int fd, const struct msghdr *m, int flags) {
  size_t n = 0;
  for (int i = 0; i < (int)m->msg_iovlen; i++) n += m->msg_iov[i].iov_len;
  unsigned char *buf = malloc(n ? n : 1), *o = buf;
  if (!buf) return fail(ENOMEM);
  for (int i = 0; i < (int)m->msg_iovlen; i++) {
    memcpy(o, m->msg_iov[i].iov_base, m->msg_iov[i].iov_len);
    o += m->msg_iov[i].iov_len;
  }
  long r = sendto(fd, buf, n, flags, (const struct sockaddr *)m->msg_name, m->msg_namelen);
  free(buf);
  return r;
}

long recvmsg(int fd, struct msghdr *m, int flags) {
  size_t n = 0;
  for (int i = 0; i < (int)m->msg_iovlen; i++) n += m->msg_iov[i].iov_len;
  unsigned char *buf = malloc(n ? n : 1);
  if (!buf) return fail(ENOMEM);
  socklen_t alen = m->msg_namelen;
  long r = recvfrom(fd, buf, n, flags, (struct sockaddr *)m->msg_name, m->msg_name ? &alen : 0);
  if (r >= 0) {
    size_t o = 0;
    for (int i = 0; i < (int)m->msg_iovlen && o < (size_t)r; i++) {
      size_t k = (size_t)r - o < m->msg_iov[i].iov_len ? (size_t)r - o : m->msg_iov[i].iov_len;
      memcpy(m->msg_iov[i].iov_base, buf + o, k);
      o += k;
    }
    if (m->msg_name) m->msg_namelen = alen;
    m->msg_controllen = 0;
    m->msg_flags = 0;
  }
  free(buf);
  return r;
}

/* send(): wasi-libc refuses any flags; programs pass MSG_NOSIGNAL (curl, OpenSSL BIOs…), which
 * means nothing without SIGPIPE, and MSG_DONTWAIT, done here by going non-blocking for one call. */
ssize_t __real_send(int fd, const void *buf, size_t len, int flags);
ssize_t __wrap_send(int fd, const void *buf, size_t len, int flags) {
  if (is_packet(fd)) return sendto(fd, buf, len, flags, 0, 0);
  int fl = -1;
  if (flags & MSG_DONTWAIT) {
    fl = fcntl(fd, F_GETFL);
    if (fl >= 0 && !(fl & O_NONBLOCK)) fcntl(fd, F_SETFL, fl | O_NONBLOCK);
    else fl = -1;
  }
  ssize_t r = __real_send(fd, buf, len, flags & ~(MSG_NOSIGNAL | MSG_DONTWAIT));
  if (fl >= 0) {
    int e = errno;
    fcntl(fd, F_SETFL, fl);
    errno = e;
  }
  return r;
}
