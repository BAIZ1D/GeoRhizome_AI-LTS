const fs = require("fs");
const os = require("os");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-compat-"));
process.env.STORAGE_DIR = root;
process.env.NODE_ENV = "test";

const {
  checkCompatibility,
  assertCompatible,
} = require("../../../utils/knowledgeSync/compat");
const journal = require("../../../utils/knowledgeSync/journal");

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const local = {
  modelId: "m",
  dimension: 4,
  normalization: true,
  prefixes: { query: "q:", document: "d:" },
};
const man = (o = {}) => ({
  embedder: { ...local, prefixes: { ...local.prefixes }, ...o },
});

test("identical is ok", () => {
  expect(checkCompatibility(man(), local)).toEqual({ ok: true, reasons: [] });
});
test.each([
  [{ modelId: "x" }, "KS_E_EMBEDDER_MISMATCH", "modelId"],
  [{ dimension: 8 }, "KS_E_DIM_MISMATCH", "dimension"],
  [
    { prefixes: { query: "z", document: "d:" } },
    "KS_E_EMBEDDER_MISMATCH",
    "prefixes.query",
  ],
  [
    { prefixes: { query: "q:", document: "z" } },
    "KS_E_EMBEDDER_MISMATCH",
    "prefixes.document",
  ],
  [{ normalization: false }, "KS_E_EMBEDDER_MISMATCH", "normalization"],
])("mismatch %j", (o, c, field) => {
  const r = checkCompatibility(man(o), local);
  expect(r.ok).toBe(false);
  expect(r.reasons[0]).toMatchObject({ code: c, field });
  expect(() => assertCompatible(man(o), local)).toThrow(
    expect.objectContaining({ code: c, phase: "compat" })
  );
});

describe("journal", () => {
  test("round trip, no paths or secrets", async () => {
    const id = uuidv4();
    await journal.createJournal(id, { kind: "import", slug: "ws1" });
    await journal.updateJournal(id, { state: "swapping", steps: { S1: true } });
    const j = await journal.readJournal(id);
    expect(j.state).toBe("swapping");
    expect(j.steps.S1).toBe(true);
    const raw = fs.readFileSync(journal.journalPath(id), "utf-8");
    expect(Object.keys(JSON.parse(raw)).join()).not.toMatch(/path|passphrase/i);
    expect((await journal.listJournals()).map((x) => x.jobId)).toContain(id);
    await journal.removeJournalDir(id);
    expect(await journal.readJournal(id)).toBeNull();
  });
  test("path-like jobId rejected", async () => {
    await expect(
      journal.createJournal("../x", { kind: "import", slug: "ws1" })
    ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
    expect(await journal.readJournal("../x")).toBeNull();
  });
  test("extra keys / unknown state rejected on read", async () => {
    const id = uuidv4();
    const j = await journal.createJournal(id, { kind: "import", slug: "ws1" });
    const f = journal.journalPath(id);
    fs.writeFileSync(f, JSON.stringify({ ...j, path: "/etc" }));
    expect(await journal.readJournal(id)).toBeNull();
    fs.writeFileSync(f, JSON.stringify({ ...j, state: "weird" }));
    expect(await journal.readJournal(id)).toBeNull();
    fs.writeFileSync(f, "{bad");
    expect(await journal.readJournal(id)).toBeNull();
  });
});
