/**
 * /proc/net/{route,arp,dev,tcp,udp} for a stack, in Linux's text formats (served as
 * virtual files by other/node/host.js to node and WASI programs).
 */
import { ipToInt, maskOf } from './ip.js';

/** Linux prints IPv4 addresses in /proc/net as little-endian hex (192.168.1.1 → 0101A8C0). */
let hexLE = (ip) => {
  let n = typeof ip === 'number' ? ip : ipToInt(ip);
  let le = ((n & 255) << 24) | (((n >>> 8) & 255) << 16) | (((n >>> 16) & 255) << 8) | (n >>> 24);
  return (le >>> 0).toString(16).toUpperCase().padStart(8, '0');
};
let hexPort = (p) => Number(p || 0).toString(16).toUpperCase().padStart(4, '0');
let TCP_STATE = { ESTABLISHED: 1, SYN_SENT: 2, SYN_RECV: 3, FIN_WAIT1: 4, FIN_WAIT2: 5, TIME_WAIT: 6, CLOSED: 7, CLOSE_WAIT: 8, LAST_ACK: 9, LISTEN: 10 };

export function procNetFiles(stack) {
  if (!stack) return {};
  let route = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT                                                       \n';
  for (let r of stack.routes) {
    let flags = 0x1 | (r.via ? 0x2 : 0) | (r.prefix === 32 ? 0x4 : 0);
    route += `${r.dev}\t${hexLE(r.dst)}\t${hexLE(r.via || '0.0.0.0')}\t${flags.toString(16).toUpperCase().padStart(4, '0')}\t0\t0\t${r.metric || 0}\t${hexLE(maskOf(r.prefix))}\t0\t0\t0                                                                            \n`;
  }
  let arp = 'IP address       HW type     Flags       HW address            Mask     Device\n';
  for (let [k, n] of stack.neighbors) {
    let [dev, ip] = k.split(' ');
    arp += `${ip.padEnd(17)}0x1         0x2         ${n.mac}     *        ${dev}\n`;
  }
  let dev = 'Inter-|   Receive                                                |  Transmit\n face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed\n';
  for (let i of stack.ifaces.values()) {
    let s = i.stats;
    dev += `${i.name.padStart(6)}: ${String(s.rxBytes).padStart(8)} ${String(s.rxPackets).padStart(7)}    0 ${String(s.rxDropped).padStart(4)}    0     0          0         0 ${String(s.txBytes).padStart(8)} ${String(s.txPackets).padStart(7)}    0 ${String(s.txDropped).padStart(4)}    0     0       0          0\n`;
  }
  let sockLines = (proto) => {
    let out = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    let n = 0;
    for (let s of stack.sockets().filter((x) => x.proto === proto)) {
      let st = proto === 'tcp' ? TCP_STATE[s.state] || 7 : s.state === 'ESTAB' ? 1 : 7;
      let rem = s.remote.port === '*' ? '00000000:0000' : `${hexLE(s.remote.addr)}:${hexPort(s.remote.port)}`;
      out += `${String(n++).padStart(4)}: ${hexLE(s.local.addr)}:${hexPort(s.local.port)} ${rem} ${st.toString(16).toUpperCase().padStart(2, '0')} 00000000:${Number(s.recvQ || 0).toString(16).toUpperCase().padStart(8, '0')} 00:00000000 00000000 ${String(s.owner?.uid ?? 0).padStart(5)}        0 0\n`;
    }
    return out;
  };
  return { route, arp, dev, tcp: sockLines('tcp'), udp: sockLines('udp') };
}
