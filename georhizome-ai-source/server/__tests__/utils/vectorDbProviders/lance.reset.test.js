/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lance-reset-"));
process.env.STORAGE_DIR = TMP;

jest.mock("../../../utils/files", () => ({}));
jest.mock("../../../models/systemSettings", () => ({ SystemSettings: {} }));

const locks = require("../../../utils/knowledgeSync/locks");
const {
  LanceDb: LanceDbClass,
} = require("../../../utils/vectorDbProviders/lance");
const LanceDb = new LanceDbClass();

afterEach(() => locks._resetForTests());
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("lance reset (W1)", () => {
  test("refuses while any lock held and leaves data", async () => {
    await LanceDb.connect();
    locks.acquire("x", "export");
    await expect(LanceDb.reset()).rejects.toMatchObject({ code: "KS_E_BUSY" });
    expect(fs.existsSync(path.join(TMP, "lancedb"))).toBe(true);
  });

  test("lock taken during connect() await is still honoured", async () => {
    const orig = LanceDb.connect.bind(LanceDb);
    LanceDb.connect = async () => {
      const r = await orig();
      locks.acquire("late", "export");
      return r;
    };
    await expect(LanceDb.reset()).rejects.toMatchObject({ code: "KS_E_BUSY" });
    LanceDb.connect = orig;
    expect(fs.existsSync(path.join(TMP, "lancedb"))).toBe(true);
  });

  test("removal is awaited (dir gone when reset resolves) and ENOENT tolerated", async () => {
    await LanceDb.reset();
    expect(fs.existsSync(path.join(TMP, "lancedb"))).toBe(false);
    await expect(LanceDb.reset()).resolves.toEqual({ reset: true });
  });
});
