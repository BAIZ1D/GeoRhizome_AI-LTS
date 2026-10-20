const {
  writeHeader,
  readHeader,
  HEADER_LEN,
  MAGIC_ARCHIVE,
  MAGIC_CATALOG,
} = require("../../../utils/knowledgeSync/header");
const {
  getKnowledgeSyncConfig,
} = require("../../../utils/knowledgeSync/config");

const cfg = getKnowledgeSyncConfig();
const base = () => ({
  magic: MAGIC_ARCHIVE,
  N: cfg.scrypt.N,
  r: cfg.scrypt.r,
  p: cfg.scrypt.p,
  salt: Buffer.alloc(16, 1),
  chunkSize: cfg.chunk_size_bytes,
  noncePrefix: Buffer.alloc(8, 2),
  keyCheck: Buffer.alloc(16, 3),
});
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
};

describe("header", () => {
  test("is 64 bytes (56 fields + 8 checksum) and round-trips", () => {
    const b = writeHeader(base());
    expect(b.length).toBe(HEADER_LEN);
    expect(HEADER_LEN).toBe(64);
    const h = readHeader(b, { config: cfg });
    expect(h.N).toBe(cfg.scrypt.N);
    expect(h.salt.equals(Buffer.alloc(16, 1))).toBe(true);
    expect(h.noncePrefix.equals(Buffer.alloc(8, 2))).toBe(true);
    expect(h.keyCheck.equals(Buffer.alloc(16, 3))).toBe(true);
    expect(h.chunkSize).toBe(cfg.chunk_size_bytes);
  });
  test("any flipped field or checksum byte -> KS_E_AUTH_TAG", () => {
    // bytes 6..63: N, r, p, salt, chunk, noncePrefix, keyCheck, checksum
    for (let i = 6; i < HEADER_LEN; i++) {
      const b = writeHeader(base());
      b[i] ^= 1;
      expect([i, code(() => readHeader(b, { config: cfg }))]).toEqual([
        i,
        "KS_E_AUTH_TAG",
      ]);
    }
  });
  test("catalog magic round-trips with kind", () => {
    const b = writeHeader({ ...base(), magic: MAGIC_CATALOG });
    expect(readHeader(b, { kind: "catalog", config: cfg }).magic).toBe("GRKC");
  });
  test("wrong magic for kind -> KS_E_MANIFEST", () => {
    const b = writeHeader({ ...base(), magic: MAGIC_CATALOG });
    expect(code(() => readHeader(b, { config: cfg }))).toBe("KS_E_MANIFEST");
  });
  test("unknown version / kdf -> KS_E_PARAMS", () => {
    const b = writeHeader(base());
    b[4] = 9;
    expect(code(() => readHeader(b, { config: cfg }))).toBe("KS_E_PARAMS");
    const c = writeHeader(base());
    c[5] = 9;
    expect(code(() => readHeader(c, { config: cfg }))).toBe("KS_E_PARAMS");
  });
  test("non-whitelisted N or chunk size -> KS_E_PARAMS", () => {
    const a = writeHeader({ ...base(), N: 2 ** 20 });
    expect(code(() => readHeader(a, { config: cfg }))).toBe("KS_E_PARAMS");
    const b = writeHeader({ ...base(), chunkSize: 65536 });
    expect(code(() => readHeader(b, { config: cfg }))).toBe("KS_E_PARAMS");
  });
  test("short buffer -> KS_E_TRUNCATED", () => {
    expect(code(() => readHeader(Buffer.alloc(55), { config: cfg }))).toBe(
      "KS_E_TRUNCATED"
    );
  });
});
