/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lance-guard-"));
process.env.STORAGE_DIR = TMP;

jest.mock("../../../utils/files", () => ({}));
jest.mock("../../../models/systemSettings", () => ({ SystemSettings: {} }));
jest.mock("../../../utils/knowledgeSync/marker", () => ({
  isSynced: jest.fn(),
}));

const marker = require("../../../utils/knowledgeSync/marker");
const locks = require("../../../utils/knowledgeSync/locks");
const { LanceDb: LanceDbClass } = require("../../../utils/vectorDbProviders/lance");
const LanceDb = new LanceDbClass();

const row = (id, dim) => ({
  id,
  text: "t",
  vector: Array.from({ length: dim }, () => 0.1),
});

function hashTree(dir) {
  const h = crypto.createHash("sha256");
  const walk = (d) => {
    for (const n of fs.readdirSync(d).sort()) {
      const p = path.join(d, n);
      const rel = path.relative(dir, p);
      if (fs.statSync(p).isDirectory()) {
        h.update("D:" + rel);
        walk(p);
      } else {
        h.update("F:" + rel);
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}

afterEach(() => {
  locks._resetForTests();
  marker.isSynced.mockReset();
});
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe("lance guards", () => {
  test("synced + dim mismatch throws KS_E_DIM_MISMATCH, table dir unchanged (table dir is <STORAGE_DIR>/lancedb/<ns>.lance, A6)", async () => {
    const ns = "synced-ns";
    const { client } = await LanceDb.connect();
    await client.createTable(ns, [row("a", 4)]);
    const dir = path.join(TMP, "lancedb", `${ns}.lance`);
    expect(fs.existsSync(dir)).toBe(true);
    marker.isSynced.mockResolvedValue(true);

    const before = hashTree(dir);
    const rowsBefore = await (await client.openTable(ns)).countRows();
    await expect(
      LanceDb.updateOrCreateCollection(client, [row("b", 5)], ns)
    ).rejects.toMatchObject({ code: "KS_E_DIM_MISMATCH" });

    const t = await client.openTable(ns);
    expect(await t.countRows()).toBe(rowsBefore);
    const dim = (await t.schema()).fields.find((f) => f.name === "vector")
      .type.listSize;
    expect(dim).toBe(4);
    expect(hashTree(dir)).toBe(before);
  });

  test("unsynced + dim mismatch keeps legacy heal", async () => {
    const ns = "unsynced-ns";
    const { client } = await LanceDb.connect();
    await client.createTable(ns, [row("a", 4)]);
    marker.isSynced.mockResolvedValue(false);
    await LanceDb.updateOrCreateCollection(client, [row("b", 5)], ns);
    const t = await client.openTable(ns);
    const dim = (await t.schema()).fields.find((f) => f.name === "vector")
      .type.listSize;
    expect(dim).toBe(5);
  });

  test("query during import rejects KS_E_SYNCING", async () => {
    locks.acquire("busy-ns", "import");
    await expect(
      LanceDb.performSimilaritySearch({
        namespace: "busy-ns",
        input: "q",
        LLMConnector: {},
      })
    ).rejects.toMatchObject({ code: "KS_E_SYNCING" });
  });

  test("reset with any lock held rejects KS_E_BUSY", async () => {
    locks.acquire("any-ns", "export");
    await expect(LanceDb.reset()).rejects.toMatchObject({
      code: "KS_E_BUSY",
    });
  });
});
