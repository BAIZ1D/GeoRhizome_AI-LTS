const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const {
  encryptBuffer,
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
const PW = "correct horse battery";
const rec = (n) => 5 + n + 16;
const snapshot = (dir) => fs.readdirSync(dir).sort();

let tmp;
let enc;
beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ks-trunc-"));
  enc = await encryptBuffer(crypto.randomBytes(CH * 3 + 100), PW, { config });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function decryptCut(buf) {
  const stage = path.join(tmp, "stage");
  fs.mkdirSync(stage, { recursive: true });
  const src = path.join(tmp, "in.enc");
  fs.writeFileSync(src, buf);
  const before = snapshot(tmp);
  const out = path.join(stage, "out.bin");
  let c = "NO_ERROR";
  try {
    await decryptFile(src, out, PW, { config, stagingDir: stage });
  } catch (e) {
    c = e.code;
  }
  expect(fs.existsSync(out)).toBe(false);
  expect(fs.existsSync(out + ".part")).toBe(false);
  expect(snapshot(stage)).toEqual([]);
  expect(snapshot(tmp)).toEqual(before);
  return c;
}

test("mid-chunk cut and missing final chunk yield distinct codes, no writes", async () => {
  const midChunk = await decryptCut(enc.subarray(0, HEADER_LEN + rec(CH) + 50));
  const noFinal = await decryptCut(enc.subarray(0, HEADER_LEN + 2 * rec(CH)));
  expect(midChunk).toBe("KS_E_TRUNCATED");
  expect(noFinal).toBe("KS_E_MISSING_FINAL");
  expect(midChunk).not.toBe(noFinal);
});

test("wrong passphrase is distinct from truncation codes", async () => {
  const src = path.join(tmp, "ok.enc");
  fs.writeFileSync(src, enc);
  const stage = path.join(tmp, "stage");
  fs.mkdirSync(stage);
  let c;
  try {
    await decryptFile(src, path.join(stage, "o"), "other passphrase!!", {
      config,
      stagingDir: stage,
    });
  } catch (e) {
    c = e.code;
  }
  expect(c).toBe("KS_E_PASSPHRASE");
  expect(snapshot(stage)).toEqual([]);
});
