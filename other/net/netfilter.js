/**
 * Netfilter for simulated hosts and routers: iptables tables/chains/rules,
 * connection tracking and NAT, plus the iptables / iptables-save /
 * iptables-restore command-line syntax.
 *
 * Packet path (other/net/stack.js), like Linux:
 *   in:  conntrack → nat PREROUTING (DNAT) → route → filter INPUT (local) or
 *        filter FORWARD → nat POSTROUTING (SNAT/MASQUERADE) → out
 *   out: conntrack → nat OUTPUT (DNAT) → filter OUTPUT → nat POSTROUTING → out
 * NAT rules only see a connection's first packet; the rest follow its
 * conntrack entry, and replies are un-NATed from it.
 */
import { cidrMatch, isIPv4, parseCidr } from './ip.js';

export let TABLES = {
  filter: ['INPUT', 'FORWARD', 'OUTPUT'],
  nat: ['PREROUTING', 'INPUT', 'OUTPUT', 'POSTROUTING'],
  mangle: ['PREROUTING', 'INPUT', 'FORWARD', 'OUTPUT', 'POSTROUTING'],
  raw: ['PREROUTING', 'OUTPUT'],
};

let BUILTIN_TARGETS = new Set(['ACCEPT', 'DROP', 'REJECT', 'RETURN', 'LOG', 'DNAT', 'SNAT', 'MASQUERADE', 'REDIRECT']);

export class NetfilterError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.exitCode = code;
  }
}

function newTables() {
  let t = {};
  for (let [name, chains] of Object.entries(TABLES)) {
    t[name] = { chains: new Map(), policies: new Map() };
    for (let c of chains) {
      t[name].chains.set(c, []);
      t[name].policies.set(c, { target: 'ACCEPT', pkts: 0, bytes: 0 });
    }
  }
  return t;
}

function portMatch(spec, port) {
  if (spec == null) return true;
  if (port == null) return false;
  for (let part of String(spec).split(',')) {
    let [a, b] = part.split(':');
    let lo = a === '' ? 0 : Number(a);
    let hi = b == null ? lo : b === '' ? 65535 : Number(b);
    if (port >= lo && port <= hi) return true;
  }
  return false;
}

let neg = (flag, v) => (flag ? !v : v);

export function ruleMatches(r, pkt, ctx) {
  if (r.proto && r.proto !== 'all' && neg(r.protoNeg, pkt.proto !== r.proto)) return false;
  if (r.src && neg(r.srcNeg, !cidrMatch(pkt.src, r.src))) return false;
  if (r.dst && neg(r.dstNeg, !cidrMatch(pkt.dst, r.dst))) return false;
  if (r.in && neg(r.inNeg, !ifMatch(r.in, ctx.in))) return false;
  if (r.out && neg(r.outNeg, !ifMatch(r.out, ctx.out))) return false;
  if (r.sport != null && neg(r.sportNeg, !portMatch(r.sport, pkt.sport))) return false;
  if (r.dport != null && neg(r.dportNeg, !portMatch(r.dport, pkt.dport))) return false;
  if (r.ctstate && neg(r.ctstateNeg, !r.ctstate.includes(ctx.ctstate))) return false;
  if (r.icmpType != null && (pkt.proto !== 'icmp' || !icmpTypeMatch(r.icmpType, pkt.icmp?.type))) return false;
  if (r.tcpFlags === 'syn' && !(pkt.proto === 'tcp' && pkt.flags === 'S')) return false;
  return true;
}

let ifMatch = (pattern, name) => (pattern.endsWith('+') ? String(name || '').startsWith(pattern.slice(0, -1)) : pattern === name);

let ICMP_TYPES = { 'echo-reply': 0, 'destination-unreachable': 3, 'echo-request': 8, 'time-exceeded': 11, any: -1 };
let icmpTypeMatch = (spec, type) => {
  let want = ICMP_TYPES[spec] ?? Number(spec);
  return want === -1 || want === type;
};

/**
 * Tables + conntrack of one network namespace (a box or a router).
 */
export class Netfilter {
  constructor() {
    this.tables = newTables();
    this.conntrack = new Conntrack();
  }

  table(name) {
    let t = this.tables[name || 'filter'];
    if (!t) throw new NetfilterError(`iptables v1.8.10 (nf_tables): can't initialize iptables table \`${name}': Table does not exist (do you need to insmod?)`, 3);
    return t;
  }

  /**
   * Run a chain: { target, rule } for the first terminating match (ACCEPT,
   * DROP, REJECT, DNAT, …), or the chain policy.
   */
  evaluate(tableName, chain, pkt, ctx) {
    let t = this.tables[tableName];
    let walk = (name, depth) => {
      if (depth > 32) return null;
      for (let r of t.chains.get(name) || []) {
        if (!ruleMatches(r, pkt, ctx)) continue;
        r.pkts++;
        r.bytes += pkt.len || 0;
        if (r.target === 'LOG') {
          ctx.log?.(`${r.logPrefix || ''}IN=${ctx.in || ''} OUT=${ctx.out || ''} SRC=${pkt.src} DST=${pkt.dst} PROTO=${pkt.proto.toUpperCase()}${pkt.sport != null ? ` SPT=${pkt.sport} DPT=${pkt.dport}` : ''}`);
          continue;
        }
        if (r.target === 'RETURN') return null;
        if (!r.target) continue;
        if (!BUILTIN_TARGETS.has(r.target)) {
          let v = walk(r.target, depth + 1);
          if (v) return v;
          continue;
        }
        return { target: r.target, rule: r };
      }
      return null;
    };
    let v = walk(chain, 0);
    if (v) return v;
    let pol = t.policies.get(chain);
    if (!pol) return { target: 'ACCEPT' };
    pol.pkts++;
    pol.bytes += pkt.len || 0;
    return { target: pol.target };
  }

  /* ---------- iptables command ---------- */

  /** `iptables …` → { code, stdout, stderr }. uid 0 only (checked by the caller). */
  command(argv, { save = false, restore = null } = {}) {
    try {
      if (save) return { code: 0, stdout: this.save(argv), stderr: '' };
      if (restore != null) {
        this.restore(restore, argv);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: this.run(argv) || '', stderr: '' };
    } catch (err) {
      if (err instanceof NetfilterError) return { code: err.exitCode, stdout: '', stderr: err.message + '\n' };
      throw err;
    }
  }

  run(argv) {
    let a = [...argv];
    let tableName = 'filter';
    let op = null;
    let chain = null;
    let num = null;
    let opArg = null;
    let list = { numeric: false, verbose: false, lineNumbers: false, exact: false };
    let ruleArgs = [];
    let take = () => {
      if (!a.length) throw new NetfilterError(`iptables v1.8.10 (nf_tables): option requires an argument\nTry \`iptables -h' or 'iptables --help' for more information.`);
      return a.shift();
    };
    while (a.length) {
      let x = a.shift();
      if (x === '-t' || x === '--table') tableName = take();
      else if (/^-[ADIRLSFZNXPE]$/.test(x) || ['--append', '--delete', '--insert', '--replace', '--list', '--list-rules', '--flush', '--zero', '--new-chain', '--delete-chain', '--policy', '--rename-chain'].includes(x)) {
        let long = { '--append': '-A', '--delete': '-D', '--insert': '-I', '--replace': '-R', '--list': '-L', '--list-rules': '-S', '--flush': '-F', '--zero': '-Z', '--new-chain': '-N', '--delete-chain': '-X', '--policy': '-P', '--rename-chain': '-E' };
        op = long[x] || x;
        if (a.length && !a[0].startsWith('-')) chain = a.shift();
        if ((op === '-I' || op === '-R' || op === '-D' || op === '-L' || op === '-S') && a.length && /^\d+$/.test(a[0])) num = Number(a.shift());
        if ((op === '-P' || op === '-E') && a.length) opArg = a.shift();
      } else if (x === '-n' || x === '--numeric') list.numeric = true;
      else if (x === '-v' || x === '--verbose') list.verbose = true;
      else if (x === '-x' || x === '--exact') list.exact = true;
      else if (x === '--line-numbers') list.lineNumbers = true;
      else if (/^-[nvL]+$/.test(x) && x.length > 2) {
        // Bundled short flags: -nvL, -vnL …
        for (let ch of x.slice(1)) {
          if (ch === 'n') list.numeric = true;
          else if (ch === 'v') list.verbose = true;
          else if (ch === 'L') op = '-L';
        }
        if (op === '-L' && a.length && !a[0].startsWith('-')) chain = a.shift();
      } else if (x === '-V' || x === '--version') return 'iptables v1.8.10 (nf_tables)\n';
      else if (x === '-h' || x === '--help') return 'iptables v1.8.10\n\nUsage: iptables -[ACD] chain rule-specification [options]\n       iptables -I chain [rulenum] rule-specification [options]\n       iptables -R chain rulenum rule-specification [options]\n       iptables -D chain rulenum [options]\n       iptables -[LS] [chain [rulenum]] [options]\n       iptables -[FZ] [chain] [options]\n       iptables -[NX] chain\n       iptables -E old-chain-name new-chain-name\n       iptables -P chain target [options]\n       iptables -h (print this help information)\n';
      else ruleArgs.push(x);
    }
    let t = this.table(tableName);
    let needChain = (c) => {
      if (!t.chains.has(c)) throw new NetfilterError(`iptables: No chain/target/match by that name.`, 1);
      return t.chains.get(c);
    };
    switch (op) {
      case '-A':
      case '-I':
      case '-R':
      case '-D': {
        let rules = needChain(chain);
        if (op === '-D' && num != null && !ruleArgs.length) {
          if (num < 1 || num > rules.length) throw new NetfilterError('iptables: Index of deletion too big.', 1);
          rules.splice(num - 1, 1);
          return '';
        }
        let rule = parseRule(ruleArgs, tableName, t);
        if (op === '-A') rules.push(rule);
        else if (op === '-I') rules.splice(Math.max(0, (num || 1) - 1), 0, rule);
        else if (op === '-R') {
          if (!num || num > rules.length) throw new NetfilterError('iptables: Index of replacement too big.', 1);
          rules[num - 1] = rule;
        } else {
          let key = ruleSpec(rule);
          let i = rules.findIndex((r) => ruleSpec(r) === key);
          if (i === -1) throw new NetfilterError('iptables: Bad rule (does a matching rule exist in that chain?).', 1);
          rules.splice(i, 1);
        }
        return '';
      }
      case '-N':
        if (t.chains.has(chain)) throw new NetfilterError('iptables: Chain already exists.', 1);
        if (!chain || chain.length > 28) throw new NetfilterError('iptables: Invalid chain name.', 2);
        t.chains.set(chain, []);
        return '';
      case '-X':
        for (let c of chain ? [chain] : [...t.chains.keys()].filter((c) => !t.policies.has(c))) {
          if (t.policies.has(c)) throw new NetfilterError(`iptables: Can't delete built-in chain.`, 1);
          needChain(c);
          for (let rules of t.chains.values()) if (rules.some((r) => r.target === c)) throw new NetfilterError('iptables: Too many links.', 1);
          t.chains.delete(c);
        }
        return '';
      case '-E': {
        let rules = needChain(chain);
        t.chains.delete(chain);
        t.chains.set(opArg, rules);
        for (let rs of t.chains.values()) for (let r of rs) if (r.target === chain) r.target = opArg;
        return '';
      }
      case '-P': {
        if (!t.policies.has(chain)) throw new NetfilterError(`iptables: Bad built-in chain name.`, 1);
        if (!['ACCEPT', 'DROP'].includes(opArg)) throw new NetfilterError(`iptables: Bad policy name. Run \`dmesg' for more information.`, 1);
        t.policies.get(chain).target = opArg;
        return '';
      }
      case '-F':
        for (let c of chain ? [chain] : [...t.chains.keys()]) needChain(c).length = 0;
        return '';
      case '-Z':
        for (let c of chain ? [chain] : [...t.chains.keys()]) {
          for (let r of needChain(c)) r.pkts = r.bytes = 0;
          let p = t.policies.get(c);
          if (p) p.pkts = p.bytes = 0;
        }
        return '';
      case '-S':
        return this.save([], { table: tableName, onlyChain: chain, rulesOnly: true });
      case '-L':
      case null:
        if (op == null && ruleArgs.length) throw new NetfilterError(`iptables v1.8.10 (nf_tables): no command specified\nTry \`iptables -h' or 'iptables --help' for more information.`);
        if (op == null) throw new NetfilterError(`iptables v1.8.10 (nf_tables): no command specified\nTry \`iptables -h' or 'iptables --help' for more information.`);
        return this.list(t, chain, list);
    }
    throw new NetfilterError(`iptables v1.8.10 (nf_tables): unknown option`);
  }

  list(t, only, o) {
    let out = [];
    let human = (n) => {
      if (o.exact || n < 10000) return String(n);
      for (let [u, d] of [['G', 1e9], ['M', 1e6], ['K', 1e3]]) if (n >= d * 10) return Math.floor(n / d) + u;
      return String(n);
    };
    let addr = (c, isNeg) => (c ? (isNeg ? '!' : '') + (c.endsWith('/32') ? c.slice(0, -3) : c) : '0.0.0.0/0');
    for (let [name, rules] of t.chains) {
      if (only && name !== only) continue;
      let pol = t.policies.get(name);
      let refs = [...t.chains.values()].flat().filter((r) => r.target === name).length;
      out.push(pol ? `Chain ${name} (policy ${pol.target}${o.verbose ? ` ${human(pol.pkts)} packets, ${human(pol.bytes)} bytes` : ''})` : `Chain ${name} (${refs} references)`);
      let head = (o.lineNumbers ? 'num  ' : '') + (o.verbose ? ' pkts bytes ' : '') + 'target     prot opt ' + (o.verbose ? 'in     out    ' : '') + 'source               destination';
      out.push(head);
      rules.forEach((r, i) => {
        let extra = [];
        if (r.ctstate) extra.push(`${r.ctstateNeg ? '! ' : ''}ctstate ${r.ctstate.join(',')}`);
        if (r.proto && (r.sport != null || r.dport != null)) {
          let multi = String(r.dport ?? '').includes(',') || String(r.sport ?? '').includes(',');
          if (multi) extra.push(`multiport ${r.dport != null ? 'dports ' + (r.dportNeg ? '!' : '') + r.dport : 'sports ' + r.sport}`);
          else {
            if (r.sport != null) extra.push(`${r.proto} spt:${r.sportNeg ? '!' : ''}${r.sport}`);
            if (r.dport != null) extra.push(`${r.proto} dpt:${r.dportNeg ? '!' : ''}${r.dport}`);
          }
        }
        if (r.icmpType != null) extra.push(`icmptype ${ICMP_TYPES[r.icmpType] ?? r.icmpType}`);
        if (r.tcpFlags === 'syn') extra.push('tcp flags:0x17/0x02');
        if (r.comment) extra.push(`/* ${r.comment} */`);
        if (r.target === 'DNAT') extra.push(`to:${r.toDestination}`);
        if (r.target === 'SNAT') extra.push(`to:${r.toSource}`);
        if ((r.target === 'MASQUERADE' || r.target === 'REDIRECT') && r.toPorts) extra.push(`${r.target === 'REDIRECT' ? 'redir ' : 'masq '}ports: ${r.toPorts}`);
        if (r.target === 'REJECT') extra.push(`reject-with ${r.rejectWith || 'icmp-port-unreachable'}`);
        if (r.target === 'LOG') extra.push(`LOG flags 0 level 4${r.logPrefix ? ` prefix "${r.logPrefix}"` : ''}`);
        let proto = (r.protoNeg ? '!' : '') + (r.proto || 'all');
        let line =
          (o.lineNumbers ? String(i + 1).padEnd(5) : '') +
          (o.verbose ? human(r.pkts).padStart(5) + ' ' + human(r.bytes).padStart(5) + ' ' : '') +
          (r.target || '').padEnd(11) +
          proto.padEnd(5) +
          '--  ' +
          (o.verbose ? ((r.inNeg ? '!' : '') + (r.in || '*')).padEnd(7) + ((r.outNeg ? '!' : '') + (r.out || '*')).padEnd(7) : '') +
          addr(r.src, r.srcNeg).padEnd(21) +
          addr(r.dst, r.dstNeg).padEnd(21) +
          extra.join(' ');
        out.push(line.trimEnd());
      });
      out.push('');
    }
    if (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n') + '\n';
  }

  /** iptables-save text (all tables, or one with -t / opts.table). */
  save(argv = [], opts = {}) {
    let only = opts.table || null;
    let counters = false;
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '-t' || argv[i] === '--table') only = argv[++i];
      else if (argv[i] === '-c' || argv[i] === '--counters') counters = true;
    }
    let out = [];
    if (!opts.rulesOnly) out.push(`# Generated by iptables-save v1.8.10 (nf_tables) on ${new Date().toUTCString()}`);
    for (let [name, t] of Object.entries(this.tables)) {
      if (only && name !== only) continue;
      let used = [...t.chains.values()].some((r) => r.length) || [...t.policies.values()].some((p) => p.target !== 'ACCEPT') || [...t.chains.keys()].some((c) => !t.policies.has(c));
      if (!used && !only && !opts.rulesOnly) continue;
      if (!opts.rulesOnly) out.push(`*${name}`);
      for (let [c] of t.chains) {
        if (opts.onlyChain && c !== opts.onlyChain) continue;
        let pol = t.policies.get(c);
        if (opts.rulesOnly) out.push(pol ? `-P ${c} ${pol.target}` : `-N ${c}`);
        else out.push(`:${c} ${pol ? pol.target : '-'} [${counters && pol ? `${pol.pkts}:${pol.bytes}` : '0:0'}]`);
      }
      for (let [c, rules] of t.chains) {
        if (opts.onlyChain && c !== opts.onlyChain) continue;
        for (let r of rules) out.push(`${counters ? `[${r.pkts}:${r.bytes}] ` : ''}-A ${c} ${ruleSpec(r)}`);
      }
      if (!opts.rulesOnly) out.push('COMMIT');
    }
    if (!opts.rulesOnly) out.push(`# Completed on ${new Date().toUTCString()}`);
    return out.join('\n') + '\n';
  }

  /** iptables-restore: replaces the tables named in the input (or adds with -n/--noflush). */
  restore(text, argv = []) {
    let noflush = argv.includes('-n') || argv.includes('--noflush');
    let next = newTables();
    for (let [name, t] of Object.entries(this.tables)) next[name] = t;
    let cur = null;
    let staged = null;
    let lineNo = 0;
    for (let raw of String(text).split('\n')) {
      lineNo++;
      let line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      let fail = (msg) => {
        throw new NetfilterError(`iptables-restore v1.8.10 (nf_tables): ${msg}\nError occurred at line: ${lineNo}\nTry \`iptables-restore -h' or 'iptables-restore --help' for more information.`, 1);
      };
      if (line.startsWith('*')) {
        cur = line.slice(1);
        if (!TABLES[cur]) fail(`table '${cur}' does not exist`);
        staged = noflush ? this.tables[cur] : newTables()[cur];
        continue;
      }
      if (!cur) fail('no table specified');
      if (line === 'COMMIT') {
        next[cur] = staged;
        cur = null;
        continue;
      }
      if (line.startsWith(':')) {
        let [c, pol] = line.slice(1).split(/\s+/);
        if (!staged.chains.has(c)) staged.chains.set(c, []);
        if (staged.policies.has(c) && pol && pol !== '-') staged.policies.get(c).target = pol;
        continue;
      }
      let words = splitWords(line.replace(/^\[\d+:\d+\]\s*/, ''));
      if (words[0] !== '-A' && words[0] !== '-I') fail(`unknown command ${words[0]}`);
      let c = words[1];
      if (!staged.chains.has(c)) fail(`Chain '${c}' does not exist`);
      let rule;
      try {
        rule = parseRule(words.slice(2), cur, staged);
      } catch (err) {
        fail(err.message);
      }
      if (words[0] === '-A') staged.chains.get(c).push(rule);
      else staged.chains.get(c).unshift(rule);
    }
    if (cur) throw new NetfilterError(`iptables-restore: COMMIT expected at line ${lineNo + 1}`, 1);
    this.tables = next;
  }
}

/** Shell-ish word split for iptables-restore lines (handles "quoted comments"). */
function splitWords(line) {
  let out = [];
  let re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] != null ? m[1].replace(/\\(.)/g, '$1') : m[2]);
  return out;
}

function parseRule(args, tableName, t) {
  let r = { pkts: 0, bytes: 0 };
  let a = [...args];
  let negNext = false;
  let take = (opt) => {
    if (!a.length) throw new NetfilterError(`iptables v1.8.10 (nf_tables): option "${opt}" requires an argument`);
    return a.shift();
  };
  let addr = (v, opt) => {
    let c = parseCidr(v);
    if (!c) throw new NetfilterError(`iptables v1.8.10 (nf_tables): host/network \`${v}' not found\nTry \`iptables -h' or 'iptables --help' for more information.`);
    return `${c.ip}/${c.prefix}`;
  };
  while (a.length) {
    let x = a.shift();
    if (x === '!') {
      negNext = true;
      continue;
    }
    let n = negNext;
    negNext = false;
    switch (x) {
      case '-p':
      case '--protocol':
        r.proto = take(x).toLowerCase();
        if (r.proto === 'all') r.proto = null;
        else if (!['tcp', 'udp', 'icmp'].includes(r.proto)) throw new NetfilterError(`iptables v1.8.10 (nf_tables): unknown protocol "${r.proto}" specified`);
        r.protoNeg = n;
        break;
      case '-s':
      case '--source':
      case '--src':
        r.src = addr(take(x), x);
        r.srcNeg = n;
        break;
      case '-d':
      case '--destination':
      case '--dst':
        r.dst = addr(take(x), x);
        r.dstNeg = n;
        break;
      case '-i':
      case '--in-interface':
        r.in = take(x);
        r.inNeg = n;
        break;
      case '-o':
      case '--out-interface':
        r.out = take(x);
        r.outNeg = n;
        break;
      case '--sport':
      case '--source-port':
      case '--sports':
      case '--source-ports':
        r.sport = take(x);
        r.sportNeg = n;
        break;
      case '--dport':
      case '--destination-port':
      case '--dports':
      case '--destination-ports':
        r.dport = take(x);
        r.dportNeg = n;
        break;
      case '-m':
      case '--match': {
        let m = take(x);
        if (!['state', 'conntrack', 'multiport', 'comment', 'tcp', 'udp', 'icmp', 'limit'].includes(m)) throw new NetfilterError(`iptables v1.8.10 (nf_tables): Couldn't load match \`${m}':No such file or directory`);
        break;
      }
      case '--state':
      case '--ctstate':
        r.ctstate = take(x).toUpperCase().split(',');
        r.ctstateNeg = n;
        break;
      case '--comment':
        r.comment = take(x);
        break;
      case '--icmp-type':
        r.icmpType = take(x);
        break;
      case '--syn':
        r.tcpFlags = 'syn';
        break;
      case '--limit':
      case '--limit-burst':
        take(x);
        break;
      case '-j':
      case '--jump':
      case '-g':
      case '--goto':
        r.target = take(x);
        break;
      case '--to-destination':
      case '--to':
        r.toDestination = take(x);
        break;
      case '--to-source':
        r.toSource = take(x);
        break;
      case '--to-ports':
        r.toPorts = take(x);
        break;
      case '--reject-with':
        r.rejectWith = take(x);
        break;
      case '--log-prefix':
        r.logPrefix = take(x);
        break;
      case '--log-level':
        take(x);
        break;
      default:
        throw new NetfilterError(`iptables v1.8.10 (nf_tables): unknown option "${x}"\nTry \`iptables -h' or 'iptables --help' for more information.`);
    }
  }
  if ((r.sport != null || r.dport != null) && !['tcp', 'udp'].includes(r.proto)) throw new NetfilterError(`iptables v1.8.10 (nf_tables): unknown option "--dport"\nTry \`iptables -h' or 'iptables --help' for more information.`);
  if (r.target) {
    let natOnly = { DNAT: ['PREROUTING', 'OUTPUT'], SNAT: ['POSTROUTING', 'INPUT'], MASQUERADE: ['POSTROUTING'], REDIRECT: ['PREROUTING', 'OUTPUT'] };
    if (natOnly[r.target] && tableName !== 'nat') throw new NetfilterError(`iptables v1.8.10 (nf_tables): RULE_APPEND failed (No such file or directory): rule in chain ${r.target}`, 4);
    if (!BUILTIN_TARGETS.has(r.target) && !t.chains.has(r.target)) throw new NetfilterError(`iptables v1.8.10 (nf_tables): Couldn't load target \`${r.target}':No such file or directory\n\nTry \`iptables -h' or 'iptables --help' for more information.`);
    if (r.target === 'DNAT' && !r.toDestination) throw new NetfilterError('iptables v1.8.10 (nf_tables): DNAT: option "--to-destination" must be specified');
    if (r.target === 'SNAT' && !r.toSource) throw new NetfilterError('iptables v1.8.10 (nf_tables): SNAT: option "--to-source" must be specified');
    for (let v of [r.toDestination, r.toSource].filter(Boolean)) if (!isIPv4(v.split(':')[0])) throw new NetfilterError(`iptables v1.8.10 (nf_tables): Bad IP address "${v}"`);
  }
  return r;
}

/** Canonical rule text, as iptables-save prints it. */
export function ruleSpec(r) {
  let p = [];
  let bang = (f) => (f ? '! ' : '');
  if (r.src) p.push(`${bang(r.srcNeg)}-s ${r.src}`);
  if (r.dst) p.push(`${bang(r.dstNeg)}-d ${r.dst}`);
  if (r.in) p.push(`${bang(r.inNeg)}-i ${r.in}`);
  if (r.out) p.push(`${bang(r.outNeg)}-o ${r.out}`);
  if (r.proto) p.push(`${bang(r.protoNeg)}-p ${r.proto}`);
  if (r.ctstate) p.push(`-m conntrack ${bang(r.ctstateNeg)}--ctstate ${r.ctstate.join(',')}`);
  let multi = String(r.dport ?? '').includes(',') || String(r.sport ?? '').includes(',');
  if (multi) {
    p.push('-m multiport');
    if (r.sport != null) p.push(`${bang(r.sportNeg)}--sports ${r.sport}`);
    if (r.dport != null) p.push(`${bang(r.dportNeg)}--dports ${r.dport}`);
  } else if (r.sport != null || r.dport != null || r.tcpFlags) {
    p.push(`-m ${r.proto}`);
    if (r.sport != null) p.push(`${bang(r.sportNeg)}--sport ${r.sport}`);
    if (r.dport != null) p.push(`${bang(r.dportNeg)}--dport ${r.dport}`);
    if (r.tcpFlags === 'syn') p.push('--tcp-flags FIN,SYN,RST,ACK SYN');
  }
  if (r.icmpType != null) p.push(`-m icmp --icmp-type ${r.icmpType}`);
  if (r.comment) p.push(`-m comment --comment ${/\s/.test(r.comment) ? JSON.stringify(r.comment) : r.comment}`);
  if (r.target) p.push(`-j ${r.target}`);
  if (r.toDestination) p.push(`--to-destination ${r.toDestination}`);
  if (r.toSource) p.push(`--to-source ${r.toSource}`);
  if (r.toPorts) p.push(`--to-ports ${r.toPorts}`);
  if (r.rejectWith) p.push(`--reject-with ${r.rejectWith}`);
  if (r.logPrefix) p.push(`--log-prefix ${JSON.stringify(r.logPrefix)}`);
  return p.join(' ');
}

/* ---------- connection tracking ---------- */

let tupleKey = (proto, src, sport, dst, dport) => `${proto} ${src}:${sport ?? ''} ${dst}:${dport ?? ''}`;

/** Ports for conntrack: TCP/UDP ports, or the ICMP echo id for both. */
export function ctPorts(pkt) {
  if (pkt.proto === 'icmp') {
    let id = pkt.icmp?.id ?? 0;
    return [id, id];
  }
  return [pkt.sport, pkt.dport];
}

let TIMEOUTS = { tcp: 432000e3, tcpClosing: 10e3, tcpNew: 120e3, udp: 30e3, udpStream: 120e3, icmp: 30e3 };

export class Conntrack {
  constructor() {
    this.map = new Map(); // tupleKey → { entry, dir: 'orig'|'reply' }
    this.entries = new Set();
  }

  /** { entry, dir } for a packet's current addresses, dropping expired entries. */
  lookup(pkt) {
    let [sp, dp] = ctPorts(pkt);
    let hit = this.map.get(tupleKey(pkt.proto, pkt.src, sp, pkt.dst, dp));
    if (hit && hit.entry.expires < Date.now()) {
      this.remove(hit.entry);
      return null;
    }
    return hit || null;
  }

  create(pkt) {
    let [sp, dp] = ctPorts(pkt);
    let entry = {
      proto: pkt.proto,
      orig: { src: pkt.src, sport: sp, dst: pkt.dst, dport: dp },
      reply: { src: pkt.dst, sport: dp, dst: pkt.src, dport: sp },
      seenReply: false,
      assured: false,
      tcpState: pkt.proto === 'tcp' ? 'SYN_SENT' : null,
      expires: Date.now() + (pkt.proto === 'tcp' ? TIMEOUTS.tcpNew : pkt.proto === 'udp' ? TIMEOUTS.udp : TIMEOUTS.icmp),
      dnat: null,
      snat: null,
      confirmed: false,
    };
    return entry;
  }

  /** Index a (possibly NATed) entry under both directions. */
  confirm(entry) {
    if (entry.confirmed) return;
    entry.confirmed = true;
    this.entries.add(entry);
    let o = entry.orig;
    let r = entry.reply;
    this.map.set(tupleKey(entry.proto, o.src, o.sport, o.dst, o.dport), { entry, dir: 'orig' });
    this.map.set(tupleKey(entry.proto, r.src, r.sport, r.dst, r.dport), { entry, dir: 'reply' });
  }

  remove(entry) {
    this.entries.delete(entry);
    let o = entry.orig;
    let r = entry.reply;
    for (let k of [tupleKey(entry.proto, o.src, o.sport, o.dst, o.dport), tupleKey(entry.proto, r.src, r.sport, r.dst, r.dport)]) {
      if (this.map.get(k)?.entry === entry) this.map.delete(k);
    }
  }

  /** Is a reply tuple taken (for picking NAT source ports)? */
  replyTaken(proto, src, sport, dst, dport) {
    let hit = this.map.get(tupleKey(proto, src, sport, dst, dport));
    return !!hit && hit.entry.expires >= Date.now();
  }

  /** Advance TCP state / timeouts after a packet of `dir`. */
  touch(entry, dir, pkt) {
    let now = Date.now();
    if (dir === 'reply') entry.seenReply = true;
    if (entry.proto === 'tcp') {
      let f = pkt.flags || '';
      if (f.includes('R')) {
        entry.tcpState = 'CLOSE';
        entry.expires = now + TIMEOUTS.tcpClosing;
        return;
      }
      if (f.includes('F')) {
        entry.tcpState = entry.tcpState === 'FIN_WAIT' ? 'TIME_WAIT' : 'FIN_WAIT';
        entry.expires = now + TIMEOUTS.tcpClosing * (entry.tcpState === 'TIME_WAIT' ? 1 : 12);
        return;
      }
      if (f === 'SA' && dir === 'reply') entry.tcpState = 'SYN_RECV';
      else if (entry.seenReply && entry.tcpState !== 'FIN_WAIT' && entry.tcpState !== 'TIME_WAIT') {
        entry.tcpState = 'ESTABLISHED';
        entry.assured = true;
      }
      entry.expires = now + (entry.tcpState === 'ESTABLISHED' ? TIMEOUTS.tcp : TIMEOUTS.tcpNew);
    } else if (entry.proto === 'udp') {
      if (entry.seenReply) entry.assured = true;
      entry.expires = now + (entry.assured ? TIMEOUTS.udpStream : TIMEOUTS.udp);
    } else entry.expires = now + TIMEOUTS.icmp;
  }

  /** /proc/net/nf_conntrack-style lines (conntrack -L). */
  list() {
    let now = Date.now();
    let out = [];
    for (let e of this.entries) {
      if (e.expires < now) {
        this.remove(e);
        continue;
      }
      let secs = Math.round((e.expires - now) / 1000);
      let num = { tcp: 6, udp: 17, icmp: 1 }[e.proto];
      let ports = (t) => (e.proto === 'icmp' ? `type=8 code=0 id=${t.sport}` : `sport=${t.sport} dport=${t.dport}`);
      out.push(`${e.proto.padEnd(8)} ${num} ${secs} ${e.tcpState ? e.tcpState + ' ' : ''}src=${e.orig.src} dst=${e.orig.dst} ${ports(e.orig)} ${e.seenReply ? '' : '[UNREPLIED] '}src=${e.reply.src} dst=${e.reply.dst} ${ports(e.reply)} ${e.assured ? '[ASSURED] ' : ''}mark=0 use=1`);
    }
    return out;
  }
}
