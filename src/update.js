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
    for (const p of [path.join(appDir, 'package.json'), path.join(appDir, '..', 'package.json')]) {
      try { v.version = require(p).version; v.repo = v.repo || path.dirname(p); break; } catch (_) { /* sem package.json */ }
    }
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

// Resultado da última atualização pelo botão: update.json (código de saída) e o fim do update.log
function lastUpdate(appDir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(appDir, 'update.json'), 'utf8'));
    let tail = [];
    try { tail = fs.readFileSync(path.join(appDir, 'update.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-15); } catch (_) { /* sem registro */ }
    return { rc: Number(j.rc), at: j.at || null, ok: Number(j.rc) === 0, tail };
  } catch (_) { return null; }
}

async function status(appDir) {
  const info = versionInfo(appDir);
  const latest = await latestRelease();
  const can = canUpdate(info);
  return { ...info, latest, updateAvailable: !!(latest && info.version && newer(latest, info.version)), canUpdate: can.ok, reason: can.reason || null, lastUpdate: lastUpdate(appDir) };
}

function runUpdate(appDir, env = process.env) {
  const info = versionInfo(appDir);
  const can = canUpdate(info, env);
  if (!can.ok) return { ok: false, error: can.reason };
  // grava o registro e o código de saída, para a tela mostrar se deu certo ou o motivo da falha
  try { fs.rmSync(path.join(appDir, 'update.json'), { force: true }); } catch (_) { /* segue */ }
  const work = env.UPDATE_CMD ? env.UPDATE_CMD : 'cd "$0" && git pull --ff-only && bash install.sh';
  const wrapped = '( echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ)"; ' + work + ' ) > "$1/update.log" 2>&1; rc=$?; printf \'{"rc":%s,"at":"%s"}\\n\' "$rc" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$1/update.json"';
  let child;
  if (env.UPDATE_CMD) {
    child = spawn('/bin/sh', ['-c', wrapped, info.repo || '/', appDir], { detached: true, stdio: 'ignore' });   // testes / instalações próprias
  } else {
    const unit = 'homeminer-update-' + Date.now().toString(36);
    child = spawn('systemd-run', ['--unit', unit, '--collect', '--setenv=HOMEMINER_UNATTENDED=1', '/bin/bash', '-c', wrapped, info.repo, appDir], { detached: true, stdio: 'ignore' });
  }
  child.on('error', () => {});
  child.unref();
  return { ok: true };
}

function parseChangelogItems(block) {
  const items = [];
  let cur = null;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (/^- /.test(line)) {
      if (cur !== null) items.push(cur.replace(/\s+/g, ' ').trim());
      cur = line.slice(2).trim();
    } else if (cur !== null && /^\s+\S/.test(rawLine)) {
      cur += ' ' + line.trim();
    } else if (cur !== null && !line.trim()) {
      items.push(cur.replace(/\s+/g, ' ').trim());
      cur = null;
    }
  }
  if (cur !== null) items.push(cur.replace(/\s+/g, ' ').trim());
  return items.filter(Boolean);
}

function changelog(appDir = __dirname, lang = 'pt') {
  let raw = '';
  for (const p of [path.join(appDir, 'CHANGELOG.md'), path.join(appDir, '..', 'CHANGELOG.md')]) {
    try { raw = fs.readFileSync(p, 'utf8'); break; } catch (_) { /* sem CHANGELOG.md */ }
  }
  if (!raw) return [];
  const text = raw.replace(/\r\n/g, '\n');
  const sections = text.split(/^## /m).slice(1);
  const wantPt = String(lang || 'pt').toLowerCase().startsWith('pt');
  const out = [];
  for (const sec of sections) {
    const nl = sec.indexOf('\n');
    const version = (nl >= 0 ? sec.slice(0, nl) : sec).trim();
    const body = nl >= 0 ? sec.slice(nl + 1) : '';
    const langParts = body.split(/^### /m);
    let targetBody = body;
    if (langParts.length > 1) {
      const wantHeading = wantPt ? /^Portugu[êe]s\b/i : /^English\b/i;
      const found = langParts.slice(1).find((p) => wantHeading.test(p.split('\n')[0].trim()));
      targetBody = found ? found.slice(found.indexOf('\n') + 1) : langParts[1].slice(langParts[1].indexOf('\n') + 1);
    }
    const items = parseChangelogItems(targetBody);
    if (version && items.length) out.push({ version, items });
  }
  return out;
}

module.exports = { lastUpdate, versionInfo, newer, latestRelease, canUpdate, status, runUpdate, changelog };
