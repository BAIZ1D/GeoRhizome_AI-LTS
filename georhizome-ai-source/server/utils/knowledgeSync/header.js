const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");

const MAGIC_ARCHIVE = "GRKS";
const MAGIC_CATALOG = "GRKC";
const FORMAT_VERSION = 1;
const KDF_SCRYPT = 1;
const SALT_LEN = 16;
const NONCE_PREFIX_LEN = 8;
const KEYCHECK_LEN = 16;
// magic4 ver1 kdf1 N4 r1 p1 salt16 chunk4 noncePrefix8 keycheck16
const HEADER_LEN = 56;

const err = (code, phase = "header") => new KnowledgeSyncError(code, { phase });

function writeHeader({
  magic,
  N,
  r,
  p,
  salt,
  chunkSize,
  noncePrefix,
  keyCheck,
}) {
  if (
    salt.length !== SALT_LEN ||
    noncePrefix.length !== NONCE_PREFIX_LEN ||
    keyCheck.length !== KEYCHECK_LEN ||
    Buffer.byteLength(magic) !== 4
  ) {
    throw err("KS_E_PARAMS");
  }
  const b = Buffer.alloc(HEADER_LEN);
  let o = 0;
  b.write(magic, o, "ascii");
  o += 4;
  b.writeUInt8(FORMAT_VERSION, o++);
  b.writeUInt8(KDF_SCRYPT, o++);
  b.writeUInt32BE(N, o);
  o += 4;
  b.writeUInt8(r, o++);
  b.writeUInt8(p, o++);
  salt.copy(b, o);
  o += SALT_LEN;
  b.writeUInt32BE(chunkSize, o);
  o += 4;
  noncePrefix.copy(b, o);
  o += NONCE_PREFIX_LEN;
  keyCheck.copy(b, o);
  return b;
}

/**
 * Parses and validates a header. Whitelist is enforced here, before any
 * scrypt work can be triggered by attacker-controlled parameters.
 */
function readHeader(buf, { kind = "archive", config } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN)
    throw err("KS_E_TRUNCATED");
  const cfg = config || getKnowledgeSyncConfig();
  const expected = kind === "catalog" ? MAGIC_CATALOG : MAGIC_ARCHIVE;
  if (buf.toString("ascii", 0, 4) !== expected) throw err("KS_E_MANIFEST");
  if (buf.readUInt8(4) !== FORMAT_VERSION || buf.readUInt8(5) !== KDF_SCRYPT)
    throw err("KS_E_PARAMS");
  const N = buf.readUInt32BE(6);
  const r = buf.readUInt8(10);
  const p = buf.readUInt8(11);
  const chunkSize = buf.readUInt32BE(28);
  const okScrypt = cfg.allowedScryptParams.some(
    (a) => a.N === N && a.r === r && a.p === p
  );
  if (!okScrypt || !cfg.allowedChunkSizes.includes(chunkSize))
    throw err("KS_E_PARAMS");
  return {
    magic: expected,
    N,
    r,
    p,
    salt: Buffer.from(buf.subarray(12, 28)),
    chunkSize,
    noncePrefix: Buffer.from(buf.subarray(32, 40)),
    keyCheck: Buffer.from(buf.subarray(40, 56)),
    raw: Buffer.from(buf.subarray(0, HEADER_LEN)),
  };
}

module.exports = {
  writeHeader,
  readHeader,
  HEADER_LEN,
  MAGIC_ARCHIVE,
  MAGIC_CATALOG,
  SALT_LEN,
  NONCE_PREFIX_LEN,
  KEYCHECK_LEN,
};
