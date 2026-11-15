// HTTPS na rede de casa: CA própria + certificado do servidor (precisa do openssl do sistema).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');
const tls = require('../src/tlslocal');

test('cria a CA e o certificado com os nomes e IPs; refaz só quando muda algo', { skip: !tls.available() && 'sem openssl' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const logs = [];
  const want = { dns: ['homeminer', 'homeminer.local'], ips: ['127.0.0.1', '192.168.0.134'] };
  const a = tls.ensure(dir, { want, log: (l) => logs.push(l) });
  assert.ok(a && a.cert.length && a.key.length);
  const info = tls.certInfo(path.join(dir, 'tls', 'server.crt'));
  for (const n of ['homeminer', 'homeminer.local', '127.0.0.1', '192.168.0.134']) assert.ok(info.san.includes(n), n);
  assert.ok(info.end > Date.now() + 800 * 86400e3);
  execFileSync('openssl', ['verify', '-CAfile', path.join(dir, 'tls', 'ca.crt'), path.join(dir, 'tls', 'server.crt')]);   // a corrente fecha
  assert.strictEqual((fs.statSync(path.join(dir, 'tls', 'ca.key')).mode & 0o777), 0o600);
  const n = logs.length;
  tls.ensure(dir, { want, log: (l) => logs.push(l) });
  assert.strictEqual(logs.length, n, 'sem mudança: não refaz');
  const ca1 = fs.readFileSync(path.join(dir, 'tls', 'ca.crt'), 'utf8');
  tls.ensure(dir, { want: { dns: want.dns, ips: [...want.ips, '10.42.0.1'] }, log: (l) => logs.push(l) });
  assert.ok(tls.certInfo(path.join(dir, 'tls', 'server.crt')).san.includes('10.42.0.1'), 'IP novo: refaz o do servidor');
  assert.strictEqual(fs.readFileSync(path.join(dir, 'tls', 'ca.crt'), 'utf8'), ca1, 'a CA continua a mesma (aparelhos não precisam reinstalar)');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('serve: o mesmo servidor responde por HTTPS e o certificado é aceito com a CA', { skip: !tls.available() && 'sem openssl' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-'));
  const app = http.createServer((req, res) => res.end('painel ' + req.url));
  Object.assign(process.env, { HTTPS: '1', HTTPS_PORT: '39443' });
  t.after(() => { delete process.env.HTTPS; delete process.env.HTTPS_PORT; fs.rmSync(dir, { recursive: true, force: true }); });
  const srv = tls.serve(app, { dataDir: dir, host: '127.0.0.1', log: () => {}, ensureFn: (d, o) => tls.ensure(d, { ...o, want: { dns: ['localhost'], ips: ['127.0.0.1'] } }) });
  t.after(() => srv.close());
  await new Promise((r) => setTimeout(r, 300));
  const ca = fs.readFileSync(path.join(dir, 'tls', 'ca.crt'));
  const body = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: 39443, path: '/x', ca, servername: 'localhost' }, (r) => { let d = ''; r.on('data', (c) => { d += c; }); r.on('end', () => resolve(d)); }).on('error', reject));
  assert.strictEqual(body, 'painel /x');
  process.env.HTTPS = '0';
  assert.strictEqual(tls.serve(app, { dataDir: dir, log: () => {} }), null);
});
