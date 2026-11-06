// Gravação segura dos arquivos de estado (recordes, histórico, conquistas, estatísticas do proxy, bot).
// As placas caem de energia (tomada inteligente, reinício pelo Telegram): gravar direto por cima deixaria
// o arquivo cortado e o histórico perdido. Aqui a gravação é atômica:
//   1. escreve num arquivo temporário na mesma pasta e força a ida para o disco (fsync);
//   2. a versão anterior vira .bak (renomeação, sem regravar);
//   3. renomeia o temporário por cima (rename é atômico: o arquivo é sempre a versão inteira, nova ou antiga).
// Na leitura, se o arquivo faltar ou estiver corrompido, vale o .bak.

const fs = require('fs');
const path = require('path');

function fsyncDir(dir) {
  // garante que a troca de nomes também foi para o disco (nem todo sistema deixa abrir pasta: segue sem)
  let fd;
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd); } catch (_) { /* segue */ } finally { if (fd != null) try { fs.closeSync(fd); } catch (_) { /* segue */ } }
}

function writeJson(file, value, { mode = 0o644, backup = true, pretty = false } = {}) {
  const data = JSON.stringify(value, null, pretty ? 2 : 0);
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const fd = fs.openSync(tmp, 'w', mode);
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  try {
    // a versão anterior vira .bak por renomeação (sem regravar dados: poupa o cartão SD). Se a energia cair entre as
    // duas renomeações, o arquivo falta por um instante e a leitura usa o .bak, que é a versão anterior inteira.
    if (backup) { try { fs.renameSync(file, file + '.bak'); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* segue */ }
    throw e;
  }
  fsyncDir(dir);
}

// Lê o JSON; se faltar ou estiver corrompido, tenta o .bak; senão devolve o padrão
function readJson(file, fallback, { onRecover } = {}) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    try {
      const v = JSON.parse(fs.readFileSync(file + '.bak', 'utf8'));
      if (onRecover) onRecover(e.code === 'ENOENT' ? 'missing' : 'corrupt');
      return v;
    } catch (_) { return fallback; }
  }
}

module.exports = { writeJson, readJson };
