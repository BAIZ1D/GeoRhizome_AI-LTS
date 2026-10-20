const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  deriveKey,
  encryptBuffer,
  decryptBuffer,
  encryptFile,
  decryptFile,
} = require("../../../utils/knowledgeSync/crypto");
const { HEADER_LEN } = require("../../../utils/knowledgeSync/header");
const {
  getKnowledgeSyncConfig,
} = require("../../../utils/knowledgeSync/config");

const CH = 1024;
const base = getKnowledgeSyncConfig();
const config = {
  ...base,
  chunk_size_bytes: CH,
  scrypt: { ...base.scrypt, N: 1024 },
  allowedScryptParams: [{ N: 1024, r: base.scrypt.r, p: base.scrypt.p }],
  allowedChunkSizes: [CH],
};
const opts = { config };
const PW = "correct horse battery";
const rec = (n) => 5 + n + 16;
const code = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return "NO_ERROR";
};

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ks-crypto-"));
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("roundtrip", () => {
  test.each([0, 1, CH, CH * 3 + 512])("%i bytes", async (n) => {
    const plain = crypto.randomBytes(n);
    const enc = await encryptBuffer(plain, PW, opts);
    const dec = await decryptBuffer(enc, PW, opts);
    expect(dec.equals(plain)).toBe(true);
  });
  test("file helpers round-trip and leave no .part", async () => {
    const plain = crypto.randomBytes(CH * 2 + 7);
    const src = path.join(tmp, "a.bin");
    const encP = path.join(tmp, "a.enc");
    const out = path.join(tmp, "a.out");
    fs.writeFileSync(src, plain);
    await encryptFile(src, encP, PW, opts);
    await decryptFile(encP, out, PW, { ...opts, stagingDir: tmp });
    expect(fs.readFileSync(out).equals(plain)).toBe(true);
    expect(fs.existsSync(out + ".part")).toBe(false);
  });
  test("fresh salt/nonce per encryption", async () => {
    const a = await encryptBuffer(Buffer.from("x"), PW, opts);
    const b = await encryptBuffer(Buffer.from("x"), PW, opts);
    expect(a.subarray(12, 28).equals(b.subarray(12, 28))).toBe(false);
    expect(a.subarray(32, 40).equals(b.subarray(32, 40))).toBe(false);
  });
  test("catalog kind round-trips and archive kind rejects it", async () => {
    const enc = await encryptBuffer(Buffer.from("cat"), PW, {
      ...opts,
      kind: "catalog",
    });
    expect(
      (await decryptBuffer(enc, PW, { ...opts, kind: "catalog" })).toString()
    ).toBe("cat");
    expect(await code(decryptBuffer(enc, PW, opts))).toBe("KS_E_MANIFEST");
  });
  test("production params derive (maxmem from config)", async () => {
    const k = await deriveKey(PW, Buffer.alloc(16), base.scrypt, base);
    expect(k.length).toBe(32);
  }, 20000);
});

describe("tamper", () => {
  let enc;
  const H = HEADER_LEN;
  beforeEach(async () => {
    enc = await encryptBuffer(crypto.randomBytes(CH * 3 + 100), PW, opts);
  });
  const dec = (b, pw = PW) => code(decryptBuffer(b, pw, opts));

  test("wrong passphrase -> KS_E_PASSPHRASE", async () => {
    expect(await dec(enc, "wrong passphrase!!")).toBe("KS_E_PASSPHRASE");
  });
  test("flipped ciphertext byte -> KS_E_AUTH_TAG", async () => {
    const b = Buffer.from(enc);
    b[H + 5 + 10] ^= 1;
    expect(await dec(b)).toBe("KS_E_AUTH_TAG");
  });
  test("flipped flag on non-final -> KS_E_AUTH_TAG", async () => {
    const b = Buffer.from(enc);
    b[H] = 1;
    expect(await dec(b)).toBe("KS_E_AUTH_TAG");
  });
  test("swapped chunks -> KS_E_AUTH_TAG", async () => {
    const r = rec(CH);
    const b = Buffer.from(enc);
    const c0 = Buffer.from(b.subarray(H, H + r));
    const c1 = Buffer.from(b.subarray(H + r, H + 2 * r));
    c1.copy(b, H);
    c0.copy(b, H + r);
    expect(await dec(b)).toBe("KS_E_AUTH_TAG");
  });
  test("cut mid-record -> KS_E_TRUNCATED", async () => {
    expect(await dec(enc.subarray(0, H + rec(CH) + 50))).toBe("KS_E_TRUNCATED");
  });
  test("cut mid-header -> KS_E_TRUNCATED", async () => {
    expect(await dec(enc.subarray(0, 20))).toBe("KS_E_TRUNCATED");
  });
  test("cut at record boundary before final -> KS_E_MISSING_FINAL", async () => {
    expect(await dec(enc.subarray(0, H + 2 * rec(CH)))).toBe(
      "KS_E_MISSING_FINAL"
    );
  });
  test("data after final -> KS_E_AUTH_TAG", async () => {
    expect(await dec(Buffer.concat([enc, Buffer.from([1, 2, 3])]))).toBe(
      "KS_E_AUTH_TAG"
    );
  });
  test("non-whitelisted header params -> KS_E_PARAMS", async () => {
    const b = Buffer.from(enc);
    b.writeUInt32BE(2 ** 20, 6);
    expect(await dec(b)).toBe("KS_E_PARAMS");
  });
  test("decryptFile failure removes partial output", async () => {
    const b = Buffer.from(enc);
    b[b.length - 20] ^= 1; // corrupt final record after earlier chunks were written
    const src = path.join(tmp, "bad.enc");
    const out = path.join(tmp, "bad.out");
    fs.writeFileSync(src, b);
    expect(
      await code(decryptFile(src, out, PW, { ...opts, stagingDir: tmp }))
    ).toBe("KS_E_AUTH_TAG");
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(out + ".part")).toBe(false);
  });
  test("output outside stagingDir -> KS_E_UNSAFE_ENTRY, nothing written", async () => {
    const src = path.join(tmp, "ok.enc");
    fs.writeFileSync(src, enc);
    const stage = path.join(tmp, "stage");
    fs.mkdirSync(stage);
    const out = path.join(tmp, "escape.out");
    expect(
      await code(decryptFile(src, out, PW, { ...opts, stagingDir: stage }))
    ).toBe("KS_E_UNSAFE_ENTRY");
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(out + ".part")).toBe(false);
  });
});
