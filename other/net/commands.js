/**
 * Shell front ends to this box's kernel network state (they talk to the
 * stack directly, like the netlink/nf_tables CLIs they mimic):
 *   ip (addr/link/route/neigh), iptables / iptables-save / iptables-restore,
 *   ss / netstat, hostname, sysctl, conntrack.
 * Userland network programs (ping, nc, dhcp clients, ssh, …) are ports.
 */
import { localStack, hostname as getHostname, setHostname } from './local.js';
import { broadcastOf, parseCidr, SERVICES, isIPv4 } from './ip.js';

export let NET_COMMANDS = ['ip', 'iptables', 'iptables-save', 'iptables-restore', 'ss', 'netstat', 'hostname', 'sysctl', 'conntrack'];

let ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
let fail = (stderr, code = 1) => ({ code, stdout: '', stderr: stderr.endsWith('\n') ? stderr : stderr + '\n' });

/**
 * @param {string} name
 * @param {string[]} args
 * @param {{ uid: number, stdin?: string|null, writeFile?: (abs: string, text: string) => Promise<void> }} ctx
 */
export async function runNetCommand(name, args, ctx) {
  let stack;
  try {
    stack = await localStack(5000);
  } catch {
    return fail(`${name}: network is not available`);
  }
  let root = Number(ctx.uid) === 0;
  switch (name) {
    case 'ip':
      return ipCmd(stack, args, root);
    case 'iptables': {
      if (!root) return fail('iptables v1.8.10 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)', 4);
      return stack.nf.command(args);
    }
    case 'iptables-save':
      if (!root) return fail('iptables-save v1.8.10 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)', 1);
      return stack.nf.command(args, { save: true });
    case 'iptables-restore': {
      if (!root) return fail('iptables-restore v1.8.10 (nf_tables): Could not fetch rule set generation id: Permission denied (you must be root)', 1);
      let file = args.find((a) => !a.startsWith('-'));
      let text = ctx.stdin ?? '';
      if (file && ctx.readFile) text = (await ctx.readFile(file)) ?? '';
      return stack.nf.command(args.filter((a) => a.startsWith('-')), { restore: text });
    }
    case 'ss':
      return ssCmd(stack, args);
    case 'netstat':
      return netstatCmd(stack, args);
    case 'hostname': {
      let flags = args.filter((a) => a.startsWith('-'));
      let rest = args.filter((a) => !a.startsWith('-'));
      if (flags.includes('-I') || flags.includes('--all-ip-addresses')) return ok(stack.localAddrs().filter((a) => !a.startsWith('127.')).join(' ') + ' \n');
      if (flags.includes('-i') || flags.includes('--ip-address')) {
        let r = stack.route('8.8.8.8');
        return ok((r?.src && r.src !== '0.0.0.0' ? r.src : '127.0.1.1') + '\n');
      }
      if (flags.includes('-s') || flags.includes('--short')) return ok(getHostname().split('.')[0] + '\n');
      if (flags.includes('-f') || flags.includes('--fqdn') || flags.includes('--long')) return ok(getHostname() + '\n');
      if (rest.length) {
        if (!root) return fail('hostname: you must be root to change the host name');
        setHostname(rest[0]);
        await ctx.writeFile?.('/etc/hostname', rest[0] + '\n').catch(() => {});
        return ok();
      }
      return ok(getHostname() + '\n');
    }
    case 'sysctl': {
      let out = '';
      let all = args.includes('-a');
      let quiet = args.includes('-q');
      let items = args.filter((a) => !a.startsWith('-'));
      if (all || !items.length) return ok(Object.entries(stack.sysctl).map(([k, v]) => `${k} = ${v}\n`).join(''));
      for (let it of items) {
        let [k, v] = it.split('=');
        k = k.trim().replace(/\//g, '.');
        if (!(k in stack.sysctl)) return fail(`sysctl: cannot stat /proc/sys/${k.replace(/\./g, '/')}: No such file or directory`, 255);
        if (v != null) {
          if (!root) return fail(`sysctl: permission denied on key "${k}"`, 255);
          stack.sysctl[k] = v.trim();
          if (!quiet) out += `${k} = ${v.trim()}\n`;
        } else out += args.includes('-n') ? `${stack.sysctl[k]}\n` : `${k} = ${stack.sysctl[k]}\n`;
      }
      return ok(out);
    }
    case 'conntrack': {
      if (!root) return fail('conntrack v1.4.8 (conntrack-tools): Operation failed: Operation not permitted', 1);
      if (args.includes('-F') || args.includes('--flush')) {
        for (let e of [...stack.nf.conntrack.entries]) stack.nf.conntrack.remove(e);
        return { code: 0, stdout: '', stderr: 'conntrack v1.4.8 (conntrack-tools): connection tracking table has been emptied.\n' };
      }
      if (args.includes('-C') || args.includes('--count')) return ok(stack.nf.conntrack.list().length + '\n');
      let lines = stack.nf.conntrack.list();
      return { code: 0, stdout: lines.map((l) => l + '\n').join(''), stderr: `conntrack v1.4.8 (conntrack-tools): ${lines.length} flow entries have been shown.\n` };
    }
  }
  return null;
}

/* ---------- ip ---------- */

function ipCmd(stack, argv, root) {
  let a = [...argv];
  let brief = false;
  let color = false;
  while (a[0]?.startsWith('-')) {
    let f = a.shift();
    if (f === '-br' || f === '-brief') brief = true;
    else if (f === '-c' || f === '-color') color = true;
    else if (f === '-4' || f === '-o' || f === '-s' || f === '-d') continue;
    else if (f === '-V' || f === '-Version') return ok('ip utility, iproute2-6.1.0, libbpf 1.1.0\n');
    else return fail(`Option "${f}" is unknown, try "ip -help".`, 255);
  }
  void color;
  let obj = a.shift() || 'help';
  let match = (word, full) => word && full.startsWith(word);
  let perm = () => fail('RTNETLINK answers: Operation not permitted', 2);
  let flagsOf = (i) => (i.loopback ? ['LOOPBACK', 'UP', 'LOWER_UP'] : i.up ? ['BROADCAST', 'MULTICAST', 'UP', 'LOWER_UP'] : ['BROADCAST', 'MULTICAST']);
  let ifaces = [...stack.ifaces.values()];
  let idx = (i) => ifaces.indexOf(i) + 1;
  let wrap = (fn) => {
    try {
      return fn();
    } catch (err) {
      return fail(err.message?.startsWith('RTNETLINK') || err.message?.startsWith('Error') || err.message?.startsWith('Cannot') ? err.message : `RTNETLINK answers: ${err.strerror || err.message}`, 2);
    }
  };

  if (match(obj, 'address') || obj === 'a') {
    let cmd = a.shift() || 'show';
    if (match(cmd, 'show') || cmd === 'list' || cmd === 'ls') {
      let dev = a[0] === 'dev' ? a[1] : a[0];
      let list = dev ? ifaces.filter((i) => i.name === dev) : ifaces;
      if (dev && !list.length) return fail(`Device "${dev}" does not exist.`);
      if (brief) return ok(list.map((i) => `${i.name.padEnd(16)} ${(i.up ? (i.loopback ? 'UNKNOWN' : 'UP') : 'DOWN').padEnd(14)} ${i.addrs.map((x) => `${x.ip}/${x.prefix}`).join(' ')} \n`).join(''));
      let out = '';
      for (let i of list) {
        out += `${idx(i)}: ${i.name}: <${flagsOf(i).join(',')}> mtu ${i.mtu} qdisc ${i.loopback ? 'noqueue' : 'fq_codel'} state ${i.loopback ? 'UNKNOWN' : i.up ? 'UP' : 'DOWN'} group default qlen 1000\n`;
        out += `    link/${i.loopback ? 'loopback' : 'ether'} ${i.mac} brd ${i.loopback ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'}\n`;
        for (let x of i.addrs) {
          out += `    inet ${x.ip}/${x.prefix}${x.prefix < 31 && !i.loopback ? ` brd ${broadcastOf(x.ip, x.prefix)}` : ''} scope ${i.loopback ? 'host' : 'global'}${x.proto === 'dhcp' ? ' dynamic' : ''} ${i.name}\n`;
          out += `       valid_lft forever preferred_lft forever\n`;
        }
      }
      return ok(out);
    }
    if (!root) return perm();
    if (cmd === 'add' || cmd === 'del' || cmd === 'delete') {
      let c = parseCidr(a[0]);
      let dev = a[a.indexOf('dev') + 1];
      if (!c) return fail(`Error: any valid prefix is expected rather than "${a[0]}".`, 1);
      if (a.indexOf('dev') === -1 || !stack.ifaces.has(dev)) return fail(`Cannot find device "${dev || ''}"`, 1);
      return wrap(() => {
        if (cmd === 'add') stack.addAddr(dev, c.ip, a[0].includes('/') ? c.prefix : 32);
        else stack.delAddr(dev, c.ip, a[0].includes('/') ? c.prefix : null);
        return ok();
      });
    }
    if (cmd === 'flush') {
      let dev = a[a.indexOf('dev') + 1] || a[0];
      return wrap(() => (stack.flushAddrs(dev), ok()));
    }
    return fail(`Command "${cmd}" is unknown, try "ip address help".`, 255);
  }

  if (match(obj, 'link') || obj === 'l') {
    let cmd = a.shift() || 'show';
    if (match(cmd, 'show') || cmd === 'list') {
      let dev = a[0] === 'dev' ? a[1] : a[0];
      let list = dev ? ifaces.filter((i) => i.name === dev) : ifaces;
      if (dev && !list.length) return fail(`Device "${dev}" does not exist.`);
      if (brief) return ok(list.map((i) => `${i.name.padEnd(16)} ${(i.loopback ? 'UNKNOWN' : i.up ? 'UP' : 'DOWN').padEnd(14)} ${i.mac} <${flagsOf(i).join(',')}> \n`).join(''));
      return ok(list.map((i) => `${idx(i)}: ${i.name}: <${flagsOf(i).join(',')}> mtu ${i.mtu} qdisc ${i.loopback ? 'noqueue' : 'fq_codel'} state ${i.loopback ? 'UNKNOWN' : i.up ? 'UP' : 'DOWN'} mode DEFAULT group default qlen 1000\n    link/${i.loopback ? 'loopback' : 'ether'} ${i.mac} brd ${i.loopback ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff'}\n`).join(''));
    }
    if (cmd === 'set') {
      if (!root) return perm();
      let dev = a[0] === 'dev' ? a[1] : a[0];
      if (!stack.ifaces.has(dev)) return fail(`Cannot find device "${dev}"`, 1);
      if (a.includes('up')) stack.setLink(dev, true);
      if (a.includes('down')) stack.setLink(dev, false);
      return ok();
    }
    return fail(`Command "${cmd}" is unknown, try "ip link help".`, 255);
  }

  if (match(obj, 'route') || obj === 'r') {
    let cmd = a.shift() || 'show';
    let fmt = (r) => {
      let dst = r.prefix === 0 ? 'default' : `${r.dst}/${r.prefix}`;
      return `${dst}${r.via ? ` via ${r.via}` : ''} dev ${r.dev}${r.proto !== 'static' ? ` proto ${r.proto}` : ''}${!r.via ? ' scope link' : ''}${r.src && !r.via ? ` src ${r.src}` : ''}${r.metric ? ` metric ${r.metric}` : ''} \n`;
    };
    if (match(cmd, 'show') || cmd === 'list') {
      let sorted = [...stack.routes].sort((x, y) => x.prefix - y.prefix || x.metric - y.metric);
      return ok(sorted.map(fmt).join(''));
    }
    if (cmd === 'get') {
      let dst = a[0];
      if (!isIPv4(dst)) return fail(`Error: inet prefix is expected rather than "${dst}".`, 1);
      let r = stack.route(dst);
      if (!r) return fail('RTNETLINK answers: Network is unreachable', 2);
      if (r.local) return ok(`local ${dst} dev lo src ${r.src} uid 0 \n    cache <local> \n`);
      return ok(`${dst}${r.via ? ` via ${r.via}` : ''} dev ${r.dev} src ${r.src} uid 0 \n    cache \n`);
    }
    if (!root) return perm();
    if (cmd === 'add' || cmd === 'del' || cmd === 'delete' || cmd === 'replace') {
      let target = a.shift();
      let c = parseCidr(target);
      if (!c) return fail(`Error: inet prefix is expected rather than "${target}".`, 1);
      let opt = (k) => (a.includes(k) ? a[a.indexOf(k) + 1] : null);
      return wrap(() => {
        let spec = { dst: c.ip, prefix: target === 'default' ? 0 : target.includes('/') ? c.prefix : 32, via: opt('via'), dev: opt('dev'), metric: Number(opt('metric')) || 0, src: opt('src') };
        if (cmd === 'replace') {
          try {
            stack.delRoute(spec);
          } catch {}
        }
        if (cmd === 'add' || cmd === 'replace') stack.addRoute(spec);
        else stack.delRoute(spec);
        return ok();
      });
    }
    if (cmd === 'flush') {
      stack.routes = stack.routes.filter((r) => r.proto === 'kernel');
      return ok();
    }
    return fail(`Command "${cmd}" is unknown, try "ip route help".`, 255);
  }

  if (match(obj, 'neighbour') || match(obj, 'neighbor') || obj === 'n') {
    let out = '';
    for (let [k, n] of stack.neighbors) {
      let [dev, ip] = k.split(' ');
      let age = Date.now() - n.at;
      out += `${ip} dev ${dev} lladdr ${n.mac} ${age < 30000 ? 'REACHABLE' : 'STALE'}\n`;
    }
    return ok(out);
  }
  if (obj === 'help' || obj === '-h') return ok('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | link | route | neigh }\n       OPTIONS := { -4 | -br[ief] | -c[olor] }\n');
  return fail(`Object "${obj}" is unknown, try "ip help".`, 1);
}

/* ---------- ss / netstat ---------- */

let svc = (proto, port, numeric) => (numeric || port === '*' ? String(port) : SERVICES[proto]?.[port] || String(port));

function ssCmd(stack, argv) {
  let flags = new Set();
  for (let a of argv) {
    if (a.startsWith('--')) flags.add(a.slice(2));
    else if (a.startsWith('-')) for (let c of a.slice(1)) flags.add(c);
  }
  let wantTcp = flags.has('t') || flags.has('tcp');
  let wantUdp = flags.has('u') || flags.has('udp');
  if (!wantTcp && !wantUdp) wantTcp = wantUdp = true;
  let listening = flags.has('l') || flags.has('listening');
  let all = flags.has('a') || flags.has('all');
  let numeric = flags.has('n') || flags.has('numeric');
  let procs = flags.has('p') || flags.has('processes');
  let rows = stack.sockets().filter((s) => (s.proto === 'tcp' ? wantTcp : wantUdp)).filter((s) => {
    let isListen = s.state === 'LISTEN' || s.state === 'UNCONN';
    return all ? true : listening ? isListen : !isListen;
  });
  let names = { ESTABLISHED: 'ESTAB', LISTEN: 'LISTEN', UNCONN: 'UNCONN', ESTAB: 'ESTAB', SYN_SENT: 'SYN-SENT', SYN_RECV: 'SYN-RECV', FIN_WAIT1: 'FIN-WAIT-1', FIN_WAIT2: 'FIN-WAIT-2', TIME_WAIT: 'TIME-WAIT', CLOSE_WAIT: 'CLOSE-WAIT', LAST_ACK: 'LAST-ACK', CLOSED: 'CLOSE' };
  let showNetid = wantTcp && wantUdp;
  let lines = [`${showNetid ? 'Netid '.padEnd(7) : ''}${'State'.padEnd(11)}${'Recv-Q'.padEnd(7)}${'Send-Q'.padEnd(7)}${'Local Address:Port'.padEnd(36)}${'Peer Address:Port'.padEnd(20)}${procs ? 'Process' : ''}`];
  for (let s of rows) {
    let local = `${s.local.addr === '0.0.0.0' ? '0.0.0.0' : s.local.addr}:${svc(s.proto, s.local.port, numeric)}`;
    let peer = `${s.remote.addr === '0.0.0.0' ? '0.0.0.0' : s.remote.addr}:${svc(s.proto, s.remote.port, numeric)}`;
    let proc = procs && s.owner ? `users:(("${s.owner.comm || '?'}",pid=${s.owner.pid ?? '?'},fd=3))` : '';
    lines.push(`${showNetid ? s.proto.padEnd(7) : ''}${(names[s.state] || s.state).padEnd(11)}${String(s.recvQ).padEnd(7)}${String(s.sendQ).padEnd(7)}${local.padEnd(36)}${peer.padEnd(20)}${proc}`);
  }
  return ok(lines.map((l) => l.trimEnd()).join('\n') + '\n');
}

function netstatCmd(stack, argv) {
  let flags = new Set();
  for (let a of argv) if (a.startsWith('-') && !a.startsWith('--')) for (let c of a.slice(1)) flags.add(c);
  if (flags.has('r')) {
    let out = 'Kernel IP routing table\nDestination     Gateway         Genmask         Flags   MSS Window  irtt Iface\n';
    for (let r of stack.routes) {
      let mask = r.prefix ? [0, 8, 16, 24].map((s) => ((0xffffffff << (32 - r.prefix)) >>> (24 - s)) & 255).join('.') : '0.0.0.0';
      out += `${(r.prefix ? r.dst : '0.0.0.0').padEnd(16)}${(r.via || '0.0.0.0').padEnd(16)}${mask.padEnd(16)}${(r.via ? 'UG' : 'U').padEnd(8)}0 0          0 ${r.dev}\n`;
    }
    return ok(out);
  }
  if (flags.has('i')) {
    let out = 'Kernel Interface table\nIface             MTU    RX-OK RX-ERR RX-DRP RX-OVR    TX-OK TX-ERR TX-DRP TX-OVR Flg\n';
    for (let i of stack.ifaces.values()) out += `${i.name.padEnd(13)}${String(i.mtu).padStart(8)}${String(i.stats.rxPackets).padStart(9)}      0${String(i.stats.rxDropped).padStart(7)} 0${String(i.stats.txPackets).padStart(13)}      0      0      0 ${i.loopback ? 'LRU' : 'BMRU'}\n`;
    return ok(out);
  }
  let wantTcp = flags.has('t');
  let wantUdp = flags.has('u');
  if (!wantTcp && !wantUdp) wantTcp = wantUdp = true;
  let numeric = flags.has('n');
  let listening = flags.has('l');
  let all = flags.has('a');
  let procs = flags.has('p');
  let rows = stack.sockets().filter((s) => (s.proto === 'tcp' ? wantTcp : wantUdp)).filter((s) => {
    let isListen = s.state === 'LISTEN' || s.state === 'UNCONN';
    return all ? true : listening ? isListen : !isListen;
  });
  let out = `Active Internet connections (${listening ? 'only servers' : all ? 'servers and established' : 'w/o servers'})\nProto Recv-Q Send-Q Local Address           Foreign Address         State      ${procs ? ' PID/Program name' : ''}\n`;
  for (let s of rows) {
    let st = s.proto === 'udp' ? (s.state === 'ESTAB' ? 'ESTABLISHED' : '') : s.state;
    let local = `${s.local.addr}:${svc(s.proto, s.local.port, numeric)}`;
    let peer = `${s.remote.addr}:${svc(s.proto, s.remote.port, numeric)}`;
    out += `${s.proto.padEnd(6)}${String(s.recvQ).padStart(6)}${String(s.sendQ).padStart(7)} ${local.padEnd(24)}${peer.padEnd(24)}${st.padEnd(11)}${procs && s.owner ? ` ${s.owner.pid}/${s.owner.comm}` : ''}\n`;
  }
  return ok(out.replace(/ +\n/g, '\n'));
}
