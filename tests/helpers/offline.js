// Pré-carregado nos testes do painel (node -r): nenhuma chamada HTTPS sai para a internet.
const https = require('https');
const { PassThrough } = require('stream');
https.get = (url, opts, cb) => {
  const res = new PassThrough();
  res.statusCode = 503;
  setImmediate(() => { (typeof opts === 'function' ? opts : cb)(res); res.end('{}'); });
  return { on() { return this; }, destroy() {} };
};
