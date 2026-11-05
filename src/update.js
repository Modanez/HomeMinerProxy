// Versão instalada, versão mais nova no GitHub e atualização pelo botão da tela de configurações.
// O install.sh grava APP_DIR/version.json com a versão, o commit e a pasta do repositório.
// A atualização roda fora do painel (systemd-run), porque o install.sh reinicia o próprio painel:
//   cd <repositório> && git pull --ff-only && bash install.sh
// Sem systemd (Docker) não há botão: a tela mostra o comando do Docker.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn, execFileSync } = require('child_process');

const REPO_API = 'https://api.github.com/repos/Modanez/HomeMinerProxy/releases/latest';
const SAFE_PATH = /^\/[\w./-]{1,200}$/;

function versionInfo(appDir = __dirname) {
  let v = {};
  try { v = JSON.parse(fs.readFileSync(path.join(appDir, 'version.json'), 'utf8')) || {}; } catch (_) { /* rodando do repositório */ }
  if (!v.version) {
    try { v.version = require(path.join(appDir, '..', 'package.json')).version; v.repo = v.repo || path.join(appDir, '..'); } catch (_) { /* sem package.json */ }
  }
  if (!v.commit && v.repo) {
    try { v.commit = execFileSync('git', ['-C', v.repo, 'rev-parse', '--short', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(); } catch (_) { /* sem git */ }
  }
  return { version: v.version || null, commit: v.commit || null, repo: v.repo || null, installedAt: v.installedAt || null };
}

// "0.10.1" > "0.9.3"
function newer(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map(Number), pb = String(b || '').replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y; }
  return false;
}

let cache = { at: 0, tag: null };
function latestRelease(timeoutMs = 6000) {
  if (process.env.UPDATE_CHECK === '0') return Promise.resolve(null);
  if (Date.now() - cache.at < 6 * 3600e3) return Promise.resolve(cache.tag);
  return new Promise((resolve) => {
    const req = https.get(REPO_API, { headers: { 'User-Agent': 'HomeMinerProxy', Accept: 'application/vnd.github+json' }, timeout: timeoutMs }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; if (b.length > 512e3) req.destroy(); });
      res.on('end', () => {
        let tag = null;
        try { const j = JSON.parse(b); tag = typeof j.tag_name === 'string' && /^v?\d+\.\d+\.\d+$/.test(j.tag_name) ? j.tag_name.replace(/^v/, '') : null; } catch (_) { /* resposta inválida */ }
        cache = { at: Date.now(), tag };
        resolve(tag);
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(cache.tag));
  });
}

// Dá para atualizar por aqui? Precisa do repositório com git, do systemd e de rodar como root.
function canUpdate(info, env = process.env) {
  if (env.UPDATE_CMD) return { ok: true };
  if (fs.existsSync('/.dockerenv') || env.container) return { ok: false, reason: 'docker' };
  if (!info.repo || !SAFE_PATH.test(info.repo) || !fs.existsSync(path.join(info.repo, '.git'))) return { ok: false, reason: 'norepo' };
  if (!env.INVOCATION_ID || (process.getuid && process.getuid() !== 0)) return { ok: false, reason: 'nosystemd' };
  return { ok: true };
}

async function status(appDir) {
  const info = versionInfo(appDir);
  const latest = await latestRelease();
  const can = canUpdate(info);
  return { ...info, latest, updateAvailable: !!(latest && info.version && newer(latest, info.version)), canUpdate: can.ok, reason: can.reason || null };
}

function runUpdate(appDir, env = process.env) {
  const info = versionInfo(appDir);
  const can = canUpdate(info, env);
  if (!can.ok) return { ok: false, error: can.reason };
  let child;
  if (env.UPDATE_CMD) {
    child = spawn('/bin/sh', ['-c', env.UPDATE_CMD], { detached: true, stdio: 'ignore' });   // testes / instalações próprias
  } else {
    const unit = 'homeminer-update-' + Date.now().toString(36);
    child = spawn('systemd-run', ['--unit', unit, '--collect', '--setenv=HOMEMINER_UNATTENDED=1', '/bin/bash', '-c', 'cd "$0" && git pull --ff-only && bash install.sh', info.repo], { detached: true, stdio: 'ignore' });
  }
  child.on('error', () => {});
  child.unref();
  return { ok: true };
}

module.exports = { versionInfo, newer, latestRelease, canUpdate, status, runUpdate };
