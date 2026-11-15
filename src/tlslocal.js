// HTTPS na rede de casa, sem domínio: uma autoridade certificadora (CA) própria, criada na primeira vez,
// assina o certificado do servidor para homeminer, homeminer.local e os IPs da placa. Cada aparelho instala a
// CA uma vez (o painel entrega em /homeminer-ca.crt) e passa a ver o cadeado e a poder instalar o app (PWA).
// Let's Encrypt não serve aqui: ele só emite para domínio público, nunca para .local ou IP da rede de casa.
//
// Usa o openssl do sistema (Debian/Armbian já trazem; no Docker vem no pacote "openssl"). Arquivos em DATA_DIR/tls/:
// ca.key + ca.crt (10 anos) e server.key + server.crt (825 dias, o máximo que o iPhone aceita), refeito sozinho
// quando faltam 30 dias, quando muda o nome ou quando a placa ganha um IP novo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const OPENSSL = () => process.env.OPENSSL_PATH || ['/usr/bin/openssl', '/usr/local/bin/openssl', '/bin/openssl'].find((p) => fs.existsSync(p)) || null;
const available = () => !!OPENSSL();

// Nomes e IPs que o certificado cobre
function names(hostname = os.hostname(), ifaces = os.networkInterfaces()) {
  const host = String(hostname || 'homeminer').toLowerCase().replace(/\.local$/, '');
  const dns = [...new Set([host, host + '.local', 'homeminer', 'homeminer.local', 'localhost'])].filter((n) => /^[a-z0-9.-]+$/.test(n));
  const ips = ['127.0.0.1'];
  for (const list of Object.values(ifaces || {})) for (const a of list || []) if (a && a.family === 'IPv4' && !a.internal && !ips.includes(a.address)) ips.push(a.address);
  return { dns, ips };
}

const run = (args, opts = {}) => execFileSync(OPENSSL(), args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, ...opts }).toString();

function certInfo(file) {
  try {
    const txt = run(['x509', '-in', file, '-noout', '-enddate', '-text']);   // -text: funciona no openssl 1.1 e 3
    const end = Date.parse((/notAfter=(.+)/.exec(txt) || [])[1]);
    const san = ((/Subject Alternative Name:[^\n]*\n\s*(.+)/.exec(txt) || [])[1] || '').split(',').map((s) => s.trim().replace(/^DNS:|^IP Address:/, '')).filter(Boolean);
    return { end, san };
  } catch (_) { return null; }
}

// Garante CA + certificado do servidor; devolve { key, cert, ca, caFile } ou null (sem openssl / erro)
function ensure(dataDir, { now = Date.now(), log = console.log, want = names() } = {}) {
  if (!available()) return null;
  const dir = path.join(dataDir, 'tls');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = (n) => path.join(dir, n);
  try {
    if (!fs.existsSync(f('ca.key')) || !fs.existsSync(f('ca.crt'))) {
      run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
        '-keyout', f('ca.key'), '-out', f('ca.crt'), '-subj', '/CN=HomeMinerProxy local CA/O=HomeMinerProxy',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
      fs.chmodSync(f('ca.key'), 0o600);
      log('https: autoridade certificadora local criada (instale /homeminer-ca.crt nos aparelhos)');
      try { fs.unlinkSync(f('server.crt')); } catch (_) { /* refaz abaixo */ }
    }
    const wantSan = [...want.dns, ...want.ips];
    const info = fs.existsSync(f('server.crt')) && fs.existsSync(f('server.key')) ? certInfo(f('server.crt')) : null;
    const stale = !info || !(info.end > now + 30 * 86400e3) || wantSan.some((n) => !info.san.includes(n));
    if (stale) {
      const ext = f('server.ext');
      fs.writeFileSync(ext, [
        'basicConstraints=critical,CA:FALSE', 'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
        'subjectAltName=' + [...want.dns.map((d) => 'DNS:' + d), ...want.ips.map((i) => 'IP:' + i)].join(','),
      ].join('\n') + '\n');
      run(['req', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', f('server.key'), '-out', f('server.csr'), '-subj', '/CN=' + want.dns[0]]);
      run(['x509', '-req', '-in', f('server.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-days', '825', '-sha256', '-extfile', ext, '-out', f('server.crt')]);
      fs.chmodSync(f('server.key'), 0o600);
      for (const n of ['server.csr', 'server.ext']) { try { fs.unlinkSync(f(n)); } catch (_) { /* segue */ } }
      log('https: certificado para ' + wantSan.join(', '));
    }
    return { key: fs.readFileSync(f('server.key')), cert: fs.readFileSync(f('server.crt')), ca: fs.readFileSync(f('ca.crt')), caFile: f('ca.crt') };
  } catch (e) {
    log('https: não consegui criar o certificado (' + String(e.stderr || e.message).trim().split('\n')[0] + ')');
    return null;
  }
}

// HTTPS ao lado do HTTP: o mesmo servidor atende nas duas. Porta HTTPS_PORT (padrão 443 como root, senão 3443).
// Com o "tailscale serve" ligado, o Tailscale ocupa a 443 no IP dele (100.x): aí o painel abre a 443 só nos IPs da
// rede de casa, e o https://homeminer.local continua sem porta. Sem nenhuma 443 livre, vai para a 3443.
// HTTPS=0 desliga. Devolve { port, hosts, close() } ou null.
const TAILNET = (ip) => { const [a, b] = ip.split('.').map(Number); return a === 100 && b >= 64 && b <= 127; };
function lanIps(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces || {})) for (const a of list || []) if (a && a.family === 'IPv4' && !a.internal && !TAILNET(a.address)) out.push(a.address);
  return out;
}
function listenOnce(handler, opts, port, host) {
  return new Promise((resolve) => {
    const s = require('https').createServer(opts, handler);
    s.once('error', (e) => resolve({ ok: false, code: e.code, message: e.message }));
    s.listen(port, host, () => resolve({ ok: true, server: s }));
  });
}
function serve(server, { dataDir, host = '0.0.0.0', log = console.log, ensureFn = ensure, ips = lanIps } = {}) {
  if (process.env.HTTPS === '0') return null;
  if (process.env.NODE_TEST_CONTEXT && process.env.HTTPS !== '1') return null;   // nos testes do painel, só quando pedido
  const tls = ensureFn(dataDir, { log });
  if (!tls) return null;
  const root = typeof process.getuid !== 'function' || process.getuid() === 0;
  const fixed = process.env.HTTPS_PORT ? Number(process.env.HTTPS_PORT) : null;
  const handler = (req, res) => server.emit('request', req, res);
  const opts = { key: tls.key, cert: tls.cert };
  const state = { port: null, hosts: [], servers: [], close() { for (const s of state.servers) s.close(); } };
  state.ready = (async () => {
    const plan = fixed ? [[fixed, [host]]] : [...(root ? [[443, [host]], [443, ips()]] : []), [3443, [host]]];
    for (const [port, hosts] of plan) {
      if (!hosts.length) continue;
      const got = [];
      for (const h of hosts) { const r = await listenOnce(handler, opts, port, h); if (r.ok) got.push([h, r.server]); else if (!['EADDRINUSE', 'EACCES', 'EADDRNOTAVAIL'].includes(r.code)) log('https: ' + r.message); }
      if (got.length) {
        Object.assign(state, { port, hosts: got.map(([h]) => h), servers: got.map(([, s]) => s) });
        log('https: também em ' + got.map(([h]) => `https://${h}:${port}`).join(', ') + (hosts !== plan[0][1] && port === 443 ? ' (a 443 do Tailscale fica com ele)' : ''));
        return state;
      }
    }
    log('https: nenhuma porta livre (' + plan.map(([p]) => p).join(', ') + ')');
    return state;
  })();
  return state;
}

module.exports = { available, names, ensure, certInfo, serve, lanIps };
