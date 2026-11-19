/**
 * IPv4 helpers for the simulated network (other/net/).
 *
 * Addresses are dotted strings everywhere outside these helpers; numbers are
 * only used for masks and comparisons.
 */

export function ipToInt(ip) {
  let p = String(ip).split('.');
  if (p.length !== 4) return NaN;
  let n = 0;
  for (let x of p) {
    if (!/^\d{1,3}$/.test(x) || Number(x) > 255) return NaN;
    n = n * 256 + Number(x);
  }
  return n >>> 0;
}

export function intToIp(n) {
  n >>>= 0;
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

export let isIPv4 = (s) => !Number.isNaN(ipToInt(s));

export function maskOf(prefix) {
  prefix = Number(prefix);
  return prefix <= 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

/** "10.0.0.0/8" → { ip: '10.0.0.0', prefix: 8 }; a bare address is /32. */
export function parseCidr(s) {
  let [ip, prefix] = String(s).split('/');
  if (ip === 'default' || ip === 'any') return { ip: '0.0.0.0', prefix: 0 };
  let p = prefix == null ? 32 : Number(prefix);
  if (!isIPv4(ip) || !(p >= 0 && p <= 32)) return null;
  return { ip, prefix: p };
}

export function inSubnet(ip, net, prefix) {
  let m = maskOf(prefix);
  return ((ipToInt(ip) & m) >>> 0) === ((ipToInt(net) & m) >>> 0);
}

export function networkOf(ip, prefix) {
  return intToIp(ipToInt(ip) & maskOf(prefix));
}

export function broadcastOf(ip, prefix) {
  return intToIp((ipToInt(ip) | ~maskOf(prefix)) >>> 0);
}

export function cidrMatch(ip, cidr) {
  let c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  return !!c && inSubnet(ip, c.ip, c.prefix);
}

export let isLoopback = (ip) => inSubnet(ip, '127.0.0.0', 8);
export let isBroadcast = (ip) => ip === '255.255.255.255';
export let isPrivate = (ip) => inSubnet(ip, '10.0.0.0', 8) || inSubnet(ip, '172.16.0.0', 12) || inSubnet(ip, '192.168.0.0', 16) || inSubnet(ip, '100.64.0.0', 10);

export function randomMac() {
  let b = crypto.getRandomValues(new Uint8Array(6));
  b[0] = (b[0] & 0xfe) | 0x02; // locally administered unicast
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(':');
}

/** IANA-ish service names for ss/netstat/nmap. */
export let SERVICES = {
  tcp: { 20: 'ftp-data', 21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 80: 'http', 110: 'pop3', 111: 'rpcbind', 143: 'imap', 443: 'https', 445: 'microsoft-ds', 993: 'imaps', 995: 'pop3s', 1433: 'ms-sql-s', 2049: 'nfs', 3000: 'ppp', 3306: 'mysql', 3389: 'ms-wbt-server', 5432: 'postgresql', 5900: 'vnc', 6379: 'redis', 8000: 'http-alt', 8080: 'http-proxy', 8443: 'https-alt', 9200: 'wap-wsp', 27017: 'mongod' },
  udp: { 53: 'domain', 67: 'bootps', 68: 'bootpc', 69: 'tftp', 123: 'ntp', 161: 'snmp', 514: 'syslog' },
};
