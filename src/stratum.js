// Matemática do Stratum V1: remonta o cabeçalho do bloco a partir de um share e calcula a dificuldade atingida.
const crypto = require('crypto');

const DIFF1 = 0x00000000ffff0000000000000000000000000000000000000000000000000000n;
const SCALE = 10n ** 12n;

const sha256d = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest();
const rev = (b) => Buffer.from(b).reverse();
const hex = (s) => Buffer.from(s, 'hex');

function swap32(b) {
  const out = Buffer.alloc(b.length);
  for (let i = 0; i < b.length; i += 4) for (let j = 0; j < 4; j++) out[i + j] = b[i + 3 - j];
  return out;
}

// Monta o cabeçalho de 80 bytes do share e devolve a dificuldade do hash dele.
function shareDifficulty(job, en1, submit, versionMask) {
  const [, , en2, ntime, nonce, vbits] = submit;
  const coinbase = Buffer.concat([hex(job.coinb1), hex(en1), hex(en2), hex(job.coinb2)]);
  let root = sha256d(coinbase);
  for (const br of job.branches) root = sha256d(Buffer.concat([root, hex(br)]));
  let version = parseInt(job.version, 16) >>> 0;
  if (vbits && versionMask) {
    const mask = parseInt(versionMask, 16) >>> 0;
    version = ((version & ~mask) | (parseInt(vbits, 16) & mask)) >>> 0;
  }
  const v = Buffer.alloc(4); v.writeUInt32LE(version);
  const header = Buffer.concat([v, swap32(hex(job.prevhash)), root, rev(hex(ntime)), rev(hex(job.nbits)), rev(hex(nonce))]);
  if (header.length !== 80) return null;
  const hash = rev(sha256d(header)).toString('hex');
  const value = BigInt('0x' + hash);
  if (value === 0n) return { diff: Infinity, hash };
  return { diff: Number((DIFF1 * SCALE) / value) / Number(SCALE), hash };
}


// Dificuldade que um hash (hex, no formato dos exploradores) atingiu
function hashDifficulty(hashHex) {
  const v = BigInt('0x' + hashHex);
  return v === 0n ? Infinity : Number((DIFF1 * SCALE) / v) / Number(SCALE);
}

module.exports = { shareDifficulty, hashDifficulty, swap32, sha256d, DIFF1 };
