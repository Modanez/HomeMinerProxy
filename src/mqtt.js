// Cliente MQTT 3.1.1 e Home Assistant Auto-Discovery — sem dependências externas (TCP/TLS nativo).
// Publica o estado da fazenda em <prefixo>/state, cada worker em <prefixo>/worker/<nome>,
// eventos em <prefixo>/event e os tópicos de descoberta automática em homeassistant/.../config.

const net = require('net');
const tls = require('tls');
const { digest, diffEvents } = require('./telegram');

const HOST_RE = /^[a-zA-Z0-9.\-]{1,253}$/;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const TOPIC_RE = /^[a-zA-Z0-9_\-]{1,48}(?:\/[a-zA-Z0-9_\-]{1,48}){0,3}$/;

// Interpreta '192.168.0.10', '192.168.0.10:1883', 'mqtt://host:1883' ou 'mqtts://u:p@host:8883'.
function parseBroker(raw, user = '', pass = '') {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^[a-zA-Z]+:\/\//.test(s)) s = 'mqtt://' + s;
  let u;
  try { u = new URL(s); } catch (_) { return null; }
  if (u.protocol !== 'mqtt:' && u.protocol !== 'mqtts:') return null;
  if (u.pathname && u.pathname !== '/') return null;
  const host = u.hostname;
  if (!host || !HOST_RE.test(host)) return null;
  if (/^[\d.]+$/.test(host) && !IPV4_RE.test(host)) return null;
  const port = u.port ? Number(u.port) : (u.protocol === 'mqtts:' ? 8883 : 1883);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const finalUser = String(user || (u.username ? decodeURIComponent(u.username) : '')).trim();
  const finalPass = String(pass || (u.password ? decodeURIComponent(u.password) : ''));
  return { protocol: u.protocol, tls: u.protocol === 'mqtts:', host, port, user: finalUser, pass: finalPass };
}

function cleanTopic(raw) {
  const t = String(raw == null || raw === '' ? 'homeminerproxy' : raw).trim().replace(/^\/+|\/+$/g, '');
  return TOPIC_RE.test(t) ? t : null;
}

// ---------------------------------------------------------------- codificação MQTT 3.1.1
function encodeVarInt(n) {
  const bytes = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n > 0) b |= 0x80;
    bytes.push(b);
  } while (n > 0);
  return Buffer.from(bytes);
}

function encodeStr(s) {
  const b = Buffer.from(String(s || ''), 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length, 0);
  return Buffer.concat([len, b]);
}

function connectPacket(opts = {}) {
  const clientId = opts.clientId || 'homeminerproxy-' + Math.random().toString(16).slice(2, 8);
  const keepalive = opts.keepalive ?? 60;
  const hasUser = !!opts.user;
  const hasPass = hasUser && opts.pass !== undefined && opts.pass !== '';
  const hasWill = !!opts.willTopic;
  let flags = 0x02;   // Clean Session
  if (hasWill) flags |= 0x04 | (opts.willRetain ? 0x20 : 0);
  if (hasUser) flags |= 0x80;
  if (hasPass) flags |= 0x40;

  const vh = Buffer.alloc(4);
  vh.writeUInt8(4, 0);      // MQTT 3.1.1 (nível 4)
  vh.writeUInt8(flags, 1);
  vh.writeUInt16BE(keepalive, 2);

  const parts = [encodeStr('MQTT'), vh, encodeStr(clientId)];
  if (hasWill) parts.push(encodeStr(opts.willTopic), encodeStr(opts.willPayload || ''));
  if (hasUser) parts.push(encodeStr(opts.user));
  if (hasPass) parts.push(encodeStr(opts.pass));
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x10]), encodeVarInt(body.length), body]);
}

function publishPacket(topic, payload, retain = false) {
  const t = encodeStr(topic);
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const body = Buffer.concat([t, p]);
  return Buffer.concat([Buffer.from([0x30 | (retain ? 0x01 : 0x00)]), encodeVarInt(body.length), body]);
}

const pingPacket = () => Buffer.from([0xc0, 0x00]);
const disconnectPacket = () => Buffer.from([0xe0, 0x00]);

// ---------------------------------------------------------------- Home Assistant Auto-Discovery
const LABELS = {
  pt: {
    devName: 'Fazenda de Mineração',
    hashrate: 'Hashrate da fazenda',
    best_difficulty: 'Recorde da fazenda',
    best_worker: 'Recordista',
    workers_active: 'Workers ativos',
    workers_stopped: 'Workers parados',
    shares_today: 'Shares hoje',
    power_watts: 'Consumo estimado',
    energy_kwh_month: 'Energia mensal estimada',
    cost_month: 'Conta de luz estimada',
    weekly_leader: 'Líder do campeonato semanal',
    achievements_unlocked: 'Conquistas desbloqueadas',
    pool_failover: 'Failover de pool',
  },
  en: {
    devName: 'Mining Farm',
    hashrate: 'Farm hashrate',
    best_difficulty: 'Farm record',
    best_worker: 'Record holder',
    workers_active: 'Active workers',
    workers_stopped: 'Stopped workers',
    shares_today: 'Shares today',
    power_watts: 'Estimated power',
    energy_kwh_month: 'Estimated monthly energy',
    cost_month: 'Estimated monthly power cost',
    weekly_leader: 'Weekly championship leader',
    achievements_unlocked: 'Unlocked achievements',
    pool_failover: 'Pool failover',
  },
};

const bxSlug = (n) => String(n).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 32);
const BX_SENSORS = [
  { id: 'hashrate', unit: 'H/s', icon: 'mdi:pickaxe', state_class: 'measurement', pt: 'hashrate', en: 'hashrate' },
  { id: 'temp', unit: '°C', device_class: 'temperature', state_class: 'measurement', pt: 'temperatura do chip', en: 'chip temperature' },
  { id: 'power', unit: 'W', device_class: 'power', state_class: 'measurement', pt: 'consumo', en: 'power' },
  { id: 'fan', unit: '%', icon: 'mdi:fan', state_class: 'measurement', pt: 'fan', en: 'fan' },
];

function discoveryConfigs(prefix = 'homeminerproxy', lang = 'en', currency = 'USD', bitaxes = []) {
  const L = LABELS[lang] || LABELS.en;
  const nodeId = prefix.replace(/[^a-zA-Z0-9_-]/g, '_');
  const stateTopic = `${prefix}/state`;
  const availTopic = `${prefix}/availability`;
  const device = {
    identifiers: [nodeId],
    name: L.devName,
    manufacturer: 'HomeMinerProxy',
    model: 'Stratum V1 Proxy & Dashboard',
  };
  const sensors = [
    { id: 'hashrate', unit: 'H/s', icon: 'mdi:pickaxe', state_class: 'measurement' },
    { id: 'best_difficulty', icon: 'mdi:trophy', state_class: 'measurement' },
    { id: 'best_worker', icon: 'mdi:account-hard-hat' },
    { id: 'workers_active', icon: 'mdi:lan-connect', state_class: 'measurement' },
    { id: 'workers_stopped', icon: 'mdi:lan-disconnect', state_class: 'measurement' },
    { id: 'shares_today', icon: 'mdi:counter', state_class: 'total_increasing' },
    { id: 'power_watts', unit: 'W', device_class: 'power', state_class: 'measurement' },
    { id: 'energy_kwh_month', unit: 'kWh', device_class: 'energy', state_class: 'measurement' },
    { id: 'cost_month', unit: currency, device_class: 'monetary' },
    { id: 'weekly_leader', icon: 'mdi:trophy-award' },
    { id: 'achievements_unlocked', icon: 'mdi:medal', state_class: 'measurement' },
  ];
  const out = sensors.map((s) => {
    const cfg = {
      name: L[s.id],
      unique_id: `${nodeId}_${s.id}`,
      state_topic: stateTopic,
      availability_topic: availTopic,
      value_template: `{{ value_json.${s.id} }}`,
      device,
    };
    if (s.unit) cfg.unit_of_measurement = s.unit;
    if (s.icon) cfg.icon = s.icon;
    if (s.device_class) cfg.device_class = s.device_class;
    if (s.state_class) cfg.state_class = s.state_class;
    return { topic: `homeassistant/sensor/${nodeId}/${s.id}/config`, payload: JSON.stringify(cfg) };
  });
  out.push({
    topic: `homeassistant/binary_sensor/${nodeId}/pool_failover/config`,
    payload: JSON.stringify({
      name: L.pool_failover,
      unique_id: `${nodeId}_pool_failover`,
      state_topic: stateTopic,
      availability_topic: availTopic,
      value_template: '{{ value_json.pool_failover }}',
      payload_on: 'ON',
      payload_off: 'OFF',
      device_class: 'problem',
      device,
    }),
  });
  // um conjunto de sensores por Bitaxe (BITAXES), lidos da API do aparelho
  for (const name of bitaxes) {
    const slug = bxSlug(name);
    for (const s of BX_SENSORS) {
      const cfg = {
        name: `${name} ${s[lang] || s.en}`,
        unique_id: `${nodeId}_bitaxe_${slug}_${s.id}`,
        state_topic: stateTopic,
        availability_topic: availTopic,
        value_template: `{{ value_json.bitaxes.${slug}.${s.id} if value_json.bitaxes is defined and value_json.bitaxes.${slug} is defined else none }}`,
        unit_of_measurement: s.unit,
        device,
      };
      if (s.icon) cfg.icon = s.icon;
      if (s.device_class) cfg.device_class = s.device_class;
      if (s.state_class) cfg.state_class = s.state_class;
      out.push({ topic: `homeassistant/sensor/${nodeId}/bitaxe_${slug}_${s.id}/config`, payload: JSON.stringify(cfg) });
    }
  }
  return out;
}

function statePayload(snap) {
  const f = (snap && snap.farm) || {};
  const e = (snap && snap.energy) || {};
  const h = (snap && snap.health) || {};
  const ws = (f.workers || []).filter((w) => !w.inactive && w.state !== 'unknown');
  const active = ws.filter((w) => w.state === 'ok' || w.state === 'quiet');
  const stopped = ws.filter((w) => w.state === 'stale');
  const leader = (snap && snap.championship && snap.championship.leader) || null;
  const plugs = Array.isArray(e.plugs) && e.plugs.length ? e.plugs.filter((x) => x && x.okAt) : (e.plug && e.plug.okAt ? [e.plug] : []);
  const p = plugs[0] || null;
  const out = {
    hashrate: Math.round(Number(f.hashrate) || 0),
    best_difficulty: Number((Number(f.best) || 0).toFixed(4)),
    best_worker: (((snap && snap.hall) || [])[0] || {}).worker || '—',
    workers_active: active.length,
    workers_stopped: stopped.length,
    shares_today: Number((f.shares || {}).today) || 0,
    shares_last_hour: Number((f.shares || {}).lastHour) || 0,
    power_watts: Number((Number(e.watts) || 0).toFixed(1)),
    energy_kwh_month: Number((Number(e.kwhMonth) || 0).toFixed(2)),
    cost_month: Number((Number(e.costMonth) || 0).toFixed(2)),
    weekly_leader: leader ? leader.name : '—',
    weekly_leader_luck: leader && leader.factor != null ? Number(leader.factor.toFixed(2)) : null,
    achievements_unlocked: Number(((snap && snap.achievements) || {}).unlocked) || 0,
    achievements_total: Number(((snap && snap.achievements) || {}).total) || 0,
    pool_failover: (((snap && snap.proxy) || {}).failover || []).length > 0 ? 'ON' : 'OFF',
    server_temp_c: h.tempC != null ? Number(h.tempC.toFixed(1)) : null,
  };
  if (p) {
    out.plug_on = plugs.some((x) => x.on !== false) ? 'ON' : 'OFF';
    const totalPlugWatts = plugs.reduce((s, x) => s + (x.watts != null ? Number(x.watts) : 0), 0);
    out.plug_watts = p.watts != null ? Number(totalPlugWatts.toFixed(1)) : null;
    out.plug_volts = p.volts != null ? Number(p.volts.toFixed(1)) : null;
  }
  const bxs = (snap && snap.bitaxes) || [];
  if (bxs.length) {
    out.bitaxes = {};
    for (const b of bxs) {
      const d = b.fresh && b.data;
      out.bitaxes[bxSlug(b.name)] = d
        ? { hashrate: Math.round(d.hashRate10m || d.hashRate || 0), temp: d.tempC, power: d.watts != null ? Number(d.watts.toFixed(1)) : null, fan: d.fanPct, online: 'ON' }
        : { hashrate: null, temp: null, power: null, fan: null, online: 'OFF' };
    }
  }
  return out;
}

// ---------------------------------------------------------------- teste rápido (tela /config)
function testBroker(rawUrl, user = '', pass = '', rawTopic = 'homeminerproxy', timeoutMs = 6000) {
  return new Promise((resolve) => {
    const b = parseBroker(rawUrl, user, pass);
    const topic = cleanTopic(rawTopic) || 'homeminerproxy';
    if (!b) return resolve({ ok: false, error: 'host' });
    let done = false;
    const finish = (res, sock) => {
      if (done) return;
      done = true;
      if (sock) try { sock.destroy(); } catch (_) {}
      resolve(res);
    };
    const sock = (b.tls ? tls : net).connect({ host: b.host, port: b.port, timeout: timeoutMs }, () => {
      sock.write(connectPacket({ user: b.user, pass: b.pass, willTopic: `${topic}/availability`, willPayload: 'offline', willRetain: true }));
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      if ((buf[0] & 0xf0) !== 0x20) return finish({ ok: false, error: 'protocol' }, sock);
      const rc = buf[3];
      if (rc !== 0) return finish({ ok: false, error: rc === 4 || rc === 5 ? 'mqttauth' : 'CONNACK ' + rc }, sock);
      sock.write(publishPacket(`${topic}/availability`, 'online', true));
      sock.end(disconnectPacket(), () => finish({ ok: true }));
    });
    sock.on('timeout', () => finish({ ok: false, error: 'timeout' }, sock));
    sock.on('error', (e) => finish({ ok: false, error: e.message }, sock));
  });
}

// ---------------------------------------------------------------- serviço contínuo
// opts: url, user, pass, topic, lang, currency, snapshot(), ignore[], personal, everyMs, log
function start(opts = {}) {
  const b = parseBroker(opts.url, opts.user, opts.pass);
  const prefix = cleanTopic(opts.topic) || 'homeminerproxy';
  if (!b) return null;
  const lang = opts.lang === 'pt' ? 'pt' : 'en';
  const currency = opts.currency || 'USD';
  const log = opts.log || ((m) => console.log('mqtt: ' + m));
  let stopped = false, sock = null, ready = false, prev = null;
  const down = new Set(), timers = [];

  const send = (pkt) => { if (sock && ready && !sock.destroyed) try { sock.write(pkt); } catch (_) {} };
  const publish = (topic, payload, retain = false) => send(publishPacket(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), retain));

  function publishDiscovery() {
    publish(`${prefix}/availability`, 'online', true);
    for (const d of discoveryConfigs(prefix, lang, currency, opts.bitaxes || [])) {
      send(publishPacket(d.topic, d.payload, true));
    }
  }

  function tick() {
    if (!ready || !opts.snapshot) return;
    let snap;
    try { snap = opts.snapshot(); } catch (_) { return; }
    if (!snap || !snap.farm || !snap.farm.hasData) return;
    publish(`${prefix}/state`, statePayload(snap), true);
    for (const w of (snap.farm.workers || []).filter((x) => !x.inactive)) {
      const safeName = String(w.name || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
      if (!safeName) continue;
      publish(`${prefix}/worker/${safeName}`, {
        name: w.name,
        state: w.state,
        hashrate: Math.round(Number(w.hashRate) || 0),
        best_difficulty: Number((Number(w.bestDifficulty) || 0).toFixed(4)),
        pool: w.pool || null,
        via_proxy: !!w.viaProxy,
        last_seen: w.lastSeen || null,
      }, true);
    }
    for (const p of ((snap.energy && snap.energy.plugs) || []).filter((x) => x && x.okAt)) {
      const safePlug = String(p.name || p.deviceId || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
      if (!safePlug) continue;
      publish(`${prefix}/plug/${safePlug}`, {
        name: p.name || p.deviceId,
        device_id: p.deviceId,
        worker: p.worker || null,
        on: p.on === false ? 'OFF' : 'ON',
        watts: p.watts != null ? Number(Number(p.watts).toFixed(1)) : null,
        volts: p.volts != null ? Number(Number(p.volts).toFixed(1)) : null,
        current_ma: p.currentMa != null ? Number(p.currentMa) : null,
        kwh_total: p.kwhTotal != null ? Number(p.kwhTotal) : null,
      }, true);
    }
    const cur = digest(snap);
    if (prev) {
      const EVENT_NAMES = {
        record: 'farm_record',
        personal: 'personal_record',
        stopped: 'worker_offline',
        back: 'worker_online',
        failover: 'pool_failover',
        failback: 'pool_recovered',
        money: 'wallet_received',
        block: 'block_found',
        achievement: 'achievement_unlocked',
      };
      for (const ev of diffEvents(prev, cur, { lang, ignore: opts.ignore || [], personal: !!opts.personal, down })) {
        publish(`${prefix}/event`, { type: EVENT_NAMES[ev.type] || ev.type, text: ev.text.replace(/<[^>]+>/g, ''), at: new Date().toISOString() }, false);
      }
    }
    prev = cur;
  }

  function connect() {
    if (stopped) return;
    ready = false;
    sock = (b.tls ? tls : net).connect({ host: b.host, port: b.port, timeout: opts.timeoutMs || 10000 }, () => {
      sock.write(connectPacket({ user: b.user, pass: b.pass, willTopic: `${prefix}/availability`, willPayload: 'offline', willRetain: true }));
    });
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      if (ready) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      if ((buf[0] & 0xf0) === 0x20 && buf[3] === 0) {
        ready = true;
        log(`conectado a ${b.host}:${b.port} (tópico ${prefix}/*)`);
        publishDiscovery();
        tick();
      } else {
        log(`broker recusou a conexão (código ${buf[3]})`);
        sock.destroy();
      }
    });
    sock.on('timeout', () => sock.destroy());
    sock.on('error', () => {});
    sock.on('close', () => {
      ready = false;
      if (!stopped) {
        const t = setTimeout(connect, opts.reconnectMs || 15000);
        if (t.unref) t.unref();
        timers.push(t);
      }
    });
  }

  connect();
  const tTick = setInterval(tick, opts.everyMs || 30000);
  const tPing = setInterval(() => send(pingPacket()), opts.pingMs || 25000);
  for (const t of [tTick, tPing]) { if (t.unref) t.unref(); timers.push(t); }

  return {
    tick,
    publish,
    stop() {
      stopped = true;
      timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
      if (sock && !sock.destroyed) {
        try {
          if (ready) sock.write(publishPacket(`${prefix}/availability`, 'offline', true));
          sock.end(disconnectPacket());
        } catch (_) { sock.destroy(); }
      }
    },
  };
}

module.exports = { parseBroker, cleanTopic, encodeVarInt, encodeStr, connectPacket, publishPacket, pingPacket, disconnectPacket, discoveryConfigs, statePayload, testBroker, start };
