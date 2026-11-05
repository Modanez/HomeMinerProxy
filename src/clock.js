// Relógio das placas sem bateria (Odroid, Orange Pi, Raspberry Pi): elas ligam com a hora errada
// (a da imagem ou a do último desligamento) e só acertam quando o NTP sincroniza pela internet.
// Com a hora errada, recordes, histórico, campeonato e resumos ficariam com datas estranhas, então o
// painel espera o relógio antes de começar a coletar. A hora é tida como certa quando passa do "piso":
// a data da instalação (version.json, gravado na montagem da imagem) ou o arquivo de dados mais novo.
// Sem rede, depois de CLOCK_WAIT_MIN minutos (padrão 10) o painel segue assim mesmo, com um aviso.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const DATA_FILES = ['workers.json', 'records.json', 'history.json', 'achievements.json', 'proxy-stats.json', 'telegram.json', 'settings.json'];
const SLACK_MS = 3600e3;   // tolerância: a hora pode estar até 1 h antes do piso

// A data mais recente que sabemos que já passou
function floor({ appDir, dataDir } = {}) {
  let f = 0;
  for (const dir of [appDir, dataDir].filter(Boolean)) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, 'version.json'), 'utf8'));
      const t = Date.parse(v.installedAt || '');
      if (t > f) f = t;
    } catch (_) { /* sem version.json (rodando do repositório) */ }
  }
  if (dataDir) {
    for (const n of DATA_FILES) {
      try { const t = fs.statSync(path.join(dataDir, n)).mtimeMs; if (t > f) f = t; } catch (_) { /* ainda não existe */ }
    }
  }
  return f;
}

const ok = (fl, now = Date.now()) => !fl || now >= fl - SLACK_MS;

// O systemd diz se o NTP já sincronizou (só informativo: sem timedatectl, vale só o piso)
function ntpSynced() {
  return new Promise((resolve) => {
    execFile(process.env.TIMEDATECTL || 'timedatectl', ['show', '-p', 'NTPSynchronized', '--value'], { timeout: 5000 }, (err, out) =>
      resolve(err ? null : String(out).trim() === 'yes'));
  });
}

// Espera a hora passar do piso. Devolve { ok, waitedMs, floor }; ok = false se desistiu pelo tempo.
async function waitOk({ appDir, dataDir, timeoutMs, stepMs = 5000, onWait } = {}) {
  const fl = floor({ appDir, dataDir });
  const limit = timeoutMs != null ? timeoutMs : Number(process.env.CLOCK_WAIT_MIN ?? 10) * 60e3;
  const start = Date.now();
  if (process.env.CLOCK_WAIT === '0' || ok(fl)) return { ok: true, waitedMs: 0, floor: fl };
  if (onWait) onWait(fl);
  // Date.now() pula para frente quando o NTP acerta: o tempo esperado é contado em voltas, não pelo relógio
  for (let waited = 0; waited < limit; waited += stepMs) {
    await new Promise((r) => setTimeout(r, stepMs));
    if (ok(fl)) return { ok: true, waitedMs: waited + stepMs, floor: fl };
  }
  return { ok: ok(fl), waitedMs: limit, floor: fl, start };
}

module.exports = { floor, ok, waitOk, ntpSynced, SLACK_MS };
