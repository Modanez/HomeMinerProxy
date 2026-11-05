// Minerador local opcional: o próprio servidor minera com o cpuminer (minerd), apontado para o proxy.
// Ligado pela opção LOCAL_MINER (assistente de primeira configuração ou ⚙️ Configurações).
// O painel escreve APP_DIR/minerador.env (usuário e núcleos) e liga ou desliga o serviço
// mineracao-minerador, que o install.sh cria desligado quando o minerd existe (imagens prontas).
// Um serviço "minerd" criado pela própria pessoa nunca é mexido aqui.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const UNIT = 'mineracao-minerador';
const UNIT_FILE = process.env.LOCAL_MINER_UNIT_FILE || `/etc/systemd/system/${UNIT}.service`;
const BINARIES = ['/usr/local/bin/minerd', '/usr/bin/minerd'];
const NAME_RE = /^[\w.\-]{1,64}$/;

const minerdPath = () => (process.env.MINERD_PATH ? [process.env.MINERD_PATH] : BINARIES).find((b) => fs.existsSync(b)) || null;
const cores = () => Math.max(1, (os.cpus() || []).length || 1);
const defaultThreads = () => Math.max(1, cores() - 1);   // deixa um núcleo para o proxy e o painel

// Dá para ligar a mineração por aqui? Precisa do minerd e do serviço criado pelo install.sh.
function available() {
  return !!minerdPath() && fs.existsSync(UNIT_FILE);
}

function threadsOf(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= cores() ? n : defaultThreads();
}

function workerOf(v) {
  const w = String(v || '').trim();
  if (NAME_RE.test(w)) return w;
  const h = os.hostname().split('.')[0].replace(/[^\w.\-]/g, '');
  return NAME_RE.test(h) ? h : 'servidor';
}

function systemctl(args) {
  return new Promise((resolve) => {
    execFile(process.env.LOCAL_MINER_SYSTEMCTL || 'systemctl', args, { timeout: 20000 }, (err, out, errOut) => resolve({ ok: !err, out: String(out || '') + String(errOut || '') }));
  });
}

// Aplica a opção ao subir o painel. Devolve o nome do worker local (ou null se não minera).
async function sync({ enabled, address, worker, threads, appDir, port = 3333 }) {
  if (!available()) return null;
  if (enabled && address) {
    const w = workerOf(worker);
    const env = `# gerado pelo painel (opção "Minerar também com este servidor")\nMINER_USER=${address}.${w}\nMINER_THREADS=${threadsOf(threads)}\nMINER_PORT=${Number(port) || 3333}\n`;
    const file = path.join(appDir, 'minerador.env');
    let changed = true;
    try { changed = fs.readFileSync(file, 'utf8') !== env; } catch (_) { /* primeira vez */ }
    if (changed) fs.writeFileSync(file, env, { mode: 0o644 });
    await systemctl(['enable', UNIT]);
    // reinicia só se a configuração mudou ou se ele não está rodando
    const active = await systemctl(['is-active', '--quiet', UNIT]);
    if (changed || !active.ok) await systemctl(['restart', UNIT]);
    return w;
  }
  const active = await systemctl(['is-active', '--quiet', UNIT]);
  const enabledNow = await systemctl(['is-enabled', '--quiet', UNIT]);
  if (active.ok || enabledNow.ok) await systemctl(['disable', '--now', UNIT]);
  return null;
}

module.exports = { UNIT, available, cores, defaultThreads, threadsOf, workerOf, sync, minerdPath };
