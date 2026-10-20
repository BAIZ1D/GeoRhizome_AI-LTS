const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Transform } = require("stream");
const { pipeline } = require("stream/promises");
const { promisify } = require("util");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const { registerSecret, unregisterSecret } = require("./redact");
const { assertWithin } = require("./paths");
const {
  writeHeader,
  readHeader,
  HEADER_LEN,
  MAGIC_ARCHIVE,
  MAGIC_CATALOG,
  NONCE_PREFIX_LEN,
  KEYCHECK_LEN,
} = require("./header");

const scrypt = promisify(crypto.scrypt);
const TAG_LEN = 16;
const NONCE_LEN = 12;
const REC_HEAD = 5; // flag u8 + len u32BE
const KEYCHECK_LABEL = "knowledge-sync-keycheck";
const MAX_COUNTER = 0xffffffff;

const fail = (code, phase) => new KnowledgeSyncError(code, { phase });
const cfgOf = (opts) => (opts && opts.config) || getKnowledgeSyncConfig();
const magicOf = (kind) => (kind === "catalog" ? MAGIC_CATALOG : MAGIC_ARCHIVE);

/** Async scrypt; maxmem always comes from config (N=2^17 needs > default 32 MiB). */
async function deriveKey(passphrase, salt, params, config) {
  const cfg = config || getKnowledgeSyncConfig();
  return scrypt(passphrase, salt, 32, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: cfg.scrypt.maxmem_bytes,
  });
}

const keyCheckOf = (key) =>
  crypto
    .createHmac("sha256", key)
    .update(KEYCHECK_LABEL)
    .digest()
    .subarray(0, KEYCHECK_LEN);

function nonceFor(prefix, counter) {
  const n = Buffer.alloc(NONCE_LEN);
  prefix.copy(n, 0);
  n.writeUInt32BE(counter, NONCE_PREFIX_LEN);
  return n;
}

function aadFor(headerRaw, flag, counter) {
  const tail = Buffer.alloc(5);
  tail.writeUInt8(flag, 0);
  tail.writeUInt32BE(counter, 1);
  return Buffer.concat([headerRaw, tail]);
}

function sealRecord(key, headerRaw, prefix, counter, flag, plain) {
  if (counter > MAX_COUNTER) throw fail("KS_E_PARAMS", "encrypt");
  const c = crypto.createCipheriv(
    "aes-256-gcm",
    key,
    nonceFor(prefix, counter),
    {
      authTagLength: TAG_LEN,
    }
  );
  c.setAAD(aadFor(headerRaw, flag, counter));
  const ct = Buffer.concat([c.update(plain), c.final()]);
  const head = Buffer.alloc(REC_HEAD);
  head.writeUInt8(flag, 0);
  head.writeUInt32BE(ct.length, 1);
  return Buffer.concat([head, ct, c.getAuthTag()]);
}

function encryptStream(passphrase, opts = {}) {
  const cfg = cfgOf(opts);
  const kind = opts.kind || "archive";
  const chunk = cfg.chunk_size_bytes;
  registerSecret(passphrase);
  let key = null;
  let headerRaw = null;
  let prefix = null;
  let counter = 0;
  let buf = Buffer.alloc(0);

  const init = async () => {
    const salt = crypto.randomBytes(cfg.scrypt.salt_bytes);
    prefix = crypto.randomBytes(NONCE_PREFIX_LEN);
    key = await deriveKey(passphrase, salt, cfg.scrypt, cfg);
    headerRaw = writeHeader({
      magic: magicOf(kind),
      N: cfg.scrypt.N,
      r: cfg.scrypt.r,
      p: cfg.scrypt.p,
      salt,
      chunkSize: chunk,
      noncePrefix: prefix,
      keyCheck: keyCheckOf(key),
    });
    return headerRaw;
  };

  return new Transform({
    async transform(data, _enc, cb) {
      try {
        if (!key) this.push(await init());
        buf = buf.length ? Buffer.concat([buf, data]) : data;
        // hold back at least one byte so the last record can carry final=1
        while (buf.length > chunk) {
          this.push(
            sealRecord(
              key,
              headerRaw,
              prefix,
              counter++,
              0,
              buf.subarray(0, chunk)
            )
          );
          buf = buf.subarray(chunk);
        }
        cb();
      } catch (e) {
        cb(e);
      }
    },
    async flush(cb) {
      try {
        if (!key) this.push(await init());
        this.push(sealRecord(key, headerRaw, prefix, counter++, 1, buf));
        buf = Buffer.alloc(0);
        cb();
      } catch (e) {
        cb(e);
      }
    },
    destroy(e, cb) {
      unregisterSecret(passphrase);
      if (key) key.fill(0);
      cb(e);
    },
  });
}

function decryptStream(passphrase, opts = {}) {
  const cfg = cfgOf(opts);
  const kind = opts.kind || "archive";
  registerSecret(passphrase);
  let key = null;
  let header = null;
  let counter = 0;
  let sawFinal = false;
  let buf = Buffer.alloc(0);

  const parseHeader = async () => {
    if (buf.length < HEADER_LEN) return false;
    header = readHeader(buf.subarray(0, HEADER_LEN), { kind, config: cfg });
    buf = buf.subarray(HEADER_LEN);
    key = await deriveKey(passphrase, header.salt, header, cfg);
    const expect = keyCheckOf(key);
    if (!crypto.timingSafeEqual(expect, header.keyCheck))
      throw fail("KS_E_PASSPHRASE", "decrypt");
    return true;
  };

  const drain = (self) => {
    for (;;) {
      if (sawFinal) {
        if (buf.length) throw fail("KS_E_AUTH_TAG", "decrypt");
        return;
      }
      if (buf.length < REC_HEAD) return;
      const flag = buf.readUInt8(0);
      const len = buf.readUInt32BE(1);
      if ((flag !== 0 && flag !== 1) || len > header.chunkSize)
        throw fail("KS_E_AUTH_TAG", "decrypt");
      const total = REC_HEAD + len + TAG_LEN;
      if (buf.length < total) return;
      if (counter > MAX_COUNTER) throw fail("KS_E_AUTH_TAG", "decrypt");
      const d = crypto.createDecipheriv(
        "aes-256-gcm",
        key,
        nonceFor(header.noncePrefix, counter),
        { authTagLength: TAG_LEN }
      );
      d.setAAD(aadFor(header.raw, flag, counter));
      d.setAuthTag(buf.subarray(REC_HEAD + len, total));
      let plain;
      try {
        plain = Buffer.concat([
          d.update(buf.subarray(REC_HEAD, REC_HEAD + len)),
          d.final(),
        ]);
      } catch {
        throw fail("KS_E_AUTH_TAG", "decrypt");
      }
      self.push(plain); // only after authentication
      counter++;
      buf = buf.subarray(total);
      if (flag === 1) sawFinal = true;
    }
  };

  return new Transform({
    async transform(data, _enc, cb) {
      try {
        buf = buf.length ? Buffer.concat([buf, data]) : data;
        if (!header && !(await parseHeader())) return cb();
        drain(this);
        cb();
      } catch (e) {
        cb(e);
      }
    },
    flush(cb) {
      try {
        if (!header) throw fail("KS_E_TRUNCATED", "decrypt");
        if (!sawFinal) {
          throw fail(
            buf.length ? "KS_E_TRUNCATED" : "KS_E_MISSING_FINAL",
            "decrypt"
          );
        }
        cb();
      } catch (e) {
        cb(e);
      }
    },
    destroy(e, cb) {
      unregisterSecret(passphrase);
      if (key) key.fill(0);
      cb(e);
    },
  });
}

async function runToFile(src, dest, transform) {
  const part = dest + ".part";
  try {
    await pipeline(
      fs.createReadStream(src),
      transform,
      fs.createWriteStream(part)
    );
    await fs.promises.rename(part, dest);
  } catch (e) {
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw e;
  }
}

async function encryptFile(src, dest, passphrase, opts = {}) {
  return runToFile(src, dest, encryptStream(passphrase, opts));
}

async function decryptFile(src, dest, passphrase, opts = {}) {
  const { stagingDir } = opts;
  if (!stagingDir) throw fail("KS_E_UNSAFE_ENTRY", "decrypt");
  try {
    assertWithin(stagingDir, dest);
  } catch {
    throw fail("KS_E_UNSAFE_ENTRY", "decrypt");
  }
  if (path.resolve(dest) === path.resolve(stagingDir))
    throw fail("KS_E_UNSAFE_ENTRY", "decrypt");
  return runToFile(src, dest, decryptStream(passphrase, opts));
}

async function encryptBuffer(plain, passphrase, opts = {}) {
  const s = encryptStream(passphrase, opts);
  const out = [];
  s.on("data", (d) => out.push(d));
  await new Promise((res, rej) => {
    s.on("end", res);
    s.on("error", rej);
    s.end(plain);
  });
  return Buffer.concat(out);
}

async function decryptBuffer(enc, passphrase, opts = {}) {
  const s = decryptStream(passphrase, opts);
  const out = [];
  s.on("data", (d) => out.push(d));
  await new Promise((res, rej) => {
    s.on("end", res);
    s.on("error", rej);
    s.end(enc);
  });
  return Buffer.concat(out);
}

module.exports = {
  deriveKey,
  encryptStream,
  decryptStream,
  encryptFile,
  decryptFile,
  encryptBuffer,
  decryptBuffer,
};
