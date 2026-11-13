// Porta 80 além da 3000: o painel também atende em http://IP-DA-PLACA (sem ":3000"), e os links antigos
// com :3000 continuam valendo. Só tenta onde dá para abrir porta baixa (root, como nos serviços do install.sh).
// HTTP80=0 desliga. Se a 80 estiver ocupada (outro servidor web, ou a rede de configuração sem cabo, que usa
// a 80 no próprio IP dela), tenta de novo a cada minuto e segue só na 3000.

const http = require('http');

function wanted(port) {
  if (process.env.HTTP80 === '0') return false;
  if (Number(port) === 80) return false;   // já está na 80
  return typeof process.getuid !== 'function' || process.getuid() === 0;
}

// Liga uma segunda porta que entrega as requisições ao mesmo servidor. Devolve { close() }.
function mirror(server, { port = Number(process.env.HTTP80_PORT || 80), host = '0.0.0.0', mainPort, log = console.log, retryMs = 60e3 } = {}) {
  if (!wanted(mainPort)) return { close() {} };
  let s = null, timer = null, closed = false, warned = false;
  const open = () => {
    if (closed) return;
    s = http.createServer((req, res) => server.emit('request', req, res));
    s.on('error', (e) => {
      if (!warned) { log(`porta ${port} indisponível (${e.code || e.message}); o painel segue só na ${mainPort}`); warned = true; }
      s = null;
      timer = setTimeout(open, retryMs);
      if (timer.unref) timer.unref();
    });
    s.listen(port, host, () => { log(`também em http://${host}:${port}`); warned = false; });
  };
  open();
  return { close() { closed = true; clearTimeout(timer); if (s) s.close(); } };
}

module.exports = { mirror, wanted };
