// Descoberta de mineradores na rede de casa (sub-rede /24 de cada endereço do servidor).
// O que dá para reconhecer:
//   - AxeOS (Bitaxe, NerdQaxe): GET /api/system/info na porta 80 (modelo, hashrate, pool);
//   - API do cgminer na porta 4028 (Avalon Nano, Antminer e outros ASICs): summary, pools, version;
//   - ESP32 pelo fabricante da placa de rede (Espressif): o NerdMiner não tem API, então só dá para dizer
//     "provavelmente um NerdMiner ou outro aparelho com ESP32" (tomadas Sonoff também usam ESP);
//   - quem já minera pelo proxy (o IP aparece entre os workers conectados).
// Para cada aparelho diz se minera pelo proxy, direto numa pool ou se não dá para saber.

const net = require('net');
const fs = require('fs');
const bitaxe = require('./bitaxe');

// Prefixos de MAC da Espressif (ESP8266/ESP32). Aparelho fora da lista só não ganha o palpite "ESP32".
const ESPRESSIF = new Set(('08:3A:F2 08:B6:1F 0C:DC:7E 10:52:1C 18:FE:34 24:0A:C4 24:62:AB 24:6F:28 24:A1:60 24:B2:DE 24:D7:EB 2C:3A:E8 2C:F4:32 30:83:98 30:AE:A4 ' +
  '30:C6:F7 34:85:18 34:86:5D 34:94:54 34:AB:95 34:B4:72 3C:61:05 3C:71:BF 3C:E9:0E 40:22:D8 40:4C:CA 40:91:51 40:F5:20 44:17:93 48:27:E2 48:3F:DA 48:55:19 48:E7:29 ' +
  '4C:11:AE 4C:75:25 4C:EB:D6 50:02:91 54:32:04 54:43:B2 58:BF:25 58:CF:79 5C:01:3B 5C:CF:7F 60:01:94 60:55:F9 64:B7:08 64:E8:33 68:67:25 68:C6:3A 70:03:9F 70:04:1D ' +
  '70:B8:F6 74:4D:BD 78:21:84 78:E3:6D 7C:87:CE 7C:9E:BD 7C:DF:A1 80:64:6F 80:65:99 80:7D:3A 84:0D:8E 84:CC:A8 84:F3:EB 84:F7:03 84:FC:E6 8C:4B:14 8C:AA:B5 90:38:0C ' +
  '90:97:D5 94:3C:C6 94:B5:55 94:B9:7E 94:E6:86 98:CD:AC 98:F4:AB 9C:9C:1F A0:20:A6 A0:76:4E A0:A3:B3 A0:B7:65 A4:7B:9D A4:CF:12 A8:03:2A A8:42:E3 AC:0B:FB AC:67:B2 ' +
  'B0:A7:32 B0:B2:1C B4:8A:0A B4:E6:2D B8:D6:1A BC:DD:C2 BC:FF:4D C0:49:EF C0:4E:30 C4:4F:33 C4:5B:BE C4:DE:E2 C8:2B:96 C8:2E:18 C8:C9:A3 C8:F0:9E CC:50:E3 CC:7B:5C ' +
  'CC:8D:A2 CC:DB:A7 D4:8A:FC D4:D4:DA D8:13:2A D8:A0:1D D8:BF:C0 DC:06:75 DC:4F:22 DC:54:75 E0:5A:1B E0:98:06 E4:65:B8 E8:06:90 E8:31:CD E8:68:E7 E8:9F:6D E8:DB:84 ' +
  'EC:62:60 EC:64:C9 EC:94:CB EC:DA:3B EC:FA:BC F0:08:D1 F0:9E:9E F4:12:FA F4:CF:A2 FC:B4:67 FC:E8:C0 FC:F5:C4').split(' '));

const isEspressif = (mac) => !!mac && ESPRESSIF.has(String(mac).toUpperCase().slice(0, 8));

// Endereços a varrer: o /24 de cada endereço privado do servidor, sem ele mesmo
function subnetHosts(addresses) {
  const hosts = [], own = new Set(addresses || []);
  for (const a of addresses || []) {
    if (!net.isIPv4(a) || !bitaxe.isPrivateHost(a)) continue;
    const base = a.split('.').slice(0, 3).join('.');
    for (let i = 1; i < 255; i++) { const h = `${base}.${i}`; if (!own.has(h) && !hosts.includes(h)) hosts.push(h); }
  }
  return hosts;
}

// Um comando na API do cgminer (TCP, JSON; a resposta termina com \0 ou com o fim da conexão)
function cgminer(host, command, { port = 4028, timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    let buf = '', done = false;
    const finish = (v) => { if (done) return; done = true; sock.destroy(); resolve(v); };
    const parse = () => { try { return JSON.parse(buf.replace(/\0/g, '').trim()); } catch (_) { return null; } };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs, () => finish(parse()));
    sock.on('connect', () => sock.write(JSON.stringify({ command })));
    sock.on('data', (d) => { buf += d; if (buf.length > 65536) return finish(null); if (buf.includes('\0')) finish(parse()); });
    sock.on('end', () => finish(parse()));
    sock.on('error', () => finish(null));
    sock.on('close', () => finish(parse()));
  });
}

// hashrate em H/s a partir do SUMMARY (cada firmware usa um campo: MHS, GHS ou THS; média ou 5s)
function cgHashrate(s) {
  if (!s) return null;
  for (const [k, m] of [['MHS 5s', 1e6], ['MHS av', 1e6], ['GHS 5s', 1e9], ['GHS av', 1e9], ['THS 5s', 1e12], ['THS av', 1e12]]) {
    const v = Number(s[k]);
    if (Number.isFinite(v) && v > 0) return v * m;
  }
  return 0;
}

// separa "stratum+tcp://host:porta" em { url: host, port }
function splitPool(u) {
  const m = /^(?:[a-z+]+:\/\/)?\[?([^\]\s/:]+)\]?(?::(\d+))?/i.exec(String(u || '').trim());
  return m ? { url: m[1], port: m[2] ? Number(m[2]) : null } : null;
}

async function cgminerInfo(host, timeoutMs = 1200, port = 4028) {
  const summary = await cgminer(host, 'summary', { timeoutMs, port });
  const s = summary && Array.isArray(summary.SUMMARY) ? summary.SUMMARY[0] : null;
  if (!s) return { ok: false };
  const [version, pools] = await Promise.all([cgminer(host, 'version', { timeoutMs, port }), cgminer(host, 'pools', { timeoutMs, port })]);
  const v = version && Array.isArray(version.VERSION) ? version.VERSION[0] || {} : {};
  const list = pools && Array.isArray(pools.POOLS) ? pools.POOLS : [];
  const active = list.find((p) => p['Stratum Active'] === true) || list.find((p) => p.Status === 'Alive') || list[0] || null;
  const pool = active ? { ...splitPool(active.URL), user: active.User || null } : null;
  return { ok: true, data: { model: v.Type || v.PROD || v.Model || (v.CGMiner ? 'cgminer ' + v.CGMiner : v.BMMiner ? 'bmminer ' + v.BMMiner : 'cgminer'), hashRate: cgHashrate(s), pool } };
}

// Tabela ARP do Linux: IP → MAC (só as entradas completas). A varredura TCP já obriga o sistema a resolver os MACs.
function readArp(file = '/proc/net/arp') {
  const out = new Map();
  let txt = '';
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return out; }
  for (const line of txt.split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 4 || c[2] === '0x0' || !/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(c[3]) || c[3] === '00:00:00:00:00:00') continue;
    out.set(c[0], c[3].toUpperCase());
  }
  return out;
}

// known: { ourHosts: [endereços e nomes deste servidor], workers: { ip: nome do worker no proxy }, bitaxes: [{ name, host }] }
async function scan(addresses, { known = {}, timeoutMs = 1200, concurrency = 48, probeAxe = bitaxe.info, probeCg = cgminerInfo, arpFile, hosts } = {}) {
  const list = hosts || subnetHosts(addresses);
  const ours = new Set((known.ourHosts || []).map((h) => String(h).toLowerCase()));
  const workers = known.workers || {};
  const found = new Map();
  let next = 0;
  const run = async () => {
    while (next < list.length) {
      const ip = list[next++];
      const [axe, cg] = await Promise.all([probeAxe(ip, timeoutMs).catch(() => ({ ok: false })), probeCg(ip, timeoutMs).catch(() => ({ ok: false }))]);
      if (axe && axe.ok) {
        const d = axe.data;
        found.set(ip, { ip, kind: 'axeos', model: d.model || 'AxeOS', name: d.hostname || null, worker: d.worker || null, hashRate: d.hashRate ?? null,
          pool: d.pool && d.pool.url ? { url: d.pool.url, port: d.pool.port ?? null, user: d.pool.user || null } : null });
      } else if (cg && cg.ok) {
        found.set(ip, { ip, kind: 'cgminer', model: cg.data.model, name: null, worker: cg.data.pool && cg.data.pool.user ? String(cg.data.pool.user).split('.').slice(1).join('.') || null : null,
          hashRate: cg.data.hashRate, pool: cg.data.pool });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, run));
  const arp = readArp(arpFile);
  const inScan = new Set(list);
  for (const [ip, mac] of arp) if (inScan.has(ip) && !found.has(ip) && isEspressif(mac)) found.set(ip, { ip, kind: 'esp32', model: null, name: null, worker: null, hashRate: null, pool: null });
  // quem está conectado no proxy mas não respondeu a nenhuma API (NerdMiner com MAC desconhecido, PC com cpuminer…)
  for (const ip of Object.keys(workers)) if (inScan.has(ip) && !found.has(ip)) found.set(ip, { ip, kind: 'proxy', model: null, name: null, worker: null, hashRate: null, pool: null });
  const bx = known.bitaxes || [];
  const out = [...found.values()].map((d) => {
    d.mac = arp.get(d.ip) || null;
    d.proxyWorker = workers[d.ip] || null;
    const reg = bx.find((b) => b.host === d.ip || (d.name && (b.host === d.name || b.host === d.name + '.local')));
    d.registered = reg ? reg.name : null;
    d.via = d.proxyWorker || (d.pool && ours.has(String(d.pool.url).toLowerCase())) ? 'proxy' : d.pool ? 'direct' : 'unknown';
    return d;
  });
  return out.sort((x, y) => Number(x.ip.split('.')[3]) - Number(y.ip.split('.')[3]));
}

module.exports = { scan, subnetHosts, cgminer, cgminerInfo, cgHashrate, splitPool, readArp, isEspressif, ESPRESSIF };
