const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "ks-swap-init");

jest.mock("../../../utils/prisma", () =>
  require("../../../__testhelpers__/memdb").db
);

const lancedb = require("@lancedb/lancedb");
const memdb = require("../../../__testhelpers__/memdb");
const swap = require("../../../utils/knowledgeSync/swap");
const journalLib = require("../../../utils/knowledgeSync/journal");
const marker = require("../../../utils/knowledgeSync/marker");
const locks = require("../../../utils/knowledgeSync/locks");
const paths = require("../../../utils/knowledgeSync/paths");
const { KnowledgeSyncError } = require("../../../utils/knowledgeSync/errors");
const {
  getKnowledgeSyncConfig,
} = require("../../../utils/knowledgeSync/config");

const SLUG = "loc";
const OLD_ENV = { ...process.env };
let root;

function hashDir(dir) {
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d).sort()) {
      const p = path.join(d, e);
      const r = rel ? `${rel}/${e}` : e;
      if (fs.statSync(p).isDirectory()) walk(p, r);
      else
        out.push(
          r + ":" + crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex")
        );
    }
  };
  walk(dir, "");
  return out.join("|");
}
const liveLance = () => paths.lanceTablePath(SLUG);
const liveDocs = () => paths.ksDocsDir(SLUG);
const bk = () => paths.backupRoot(SLUG);
const pend = () => swap._testOnly.pendingRoot(SLUG);
const countRows = async (dir) => {
  const conn = await lancedb.connect(path.dirname(dir));
  return (await conn.openTable(path.basename(dir, ".lance"))).countRows();
};

async function makeLance(dir, name, n, tag) {
  const conn = await lancedb.connect(dir);
  await conn.createTable(
    name,
    Array.from({ length: n }, (_, i) => ({
      id: `${tag}${i}`,
      vector: [0.1, 0.2],
      text: tag,
    }))
  );
}
function seedLive(tag = "old") {
  fs.mkdirSync(liveDocs(), { recursive: true });
  fs.writeFileSync(path.join(liveDocs(), `${tag}.json`), `{"t":"${tag}"}`);
}
async function seedLiveFull() {
  await makeLance(paths.lancedbRoot(), SLUG, 2, "o");
  seedLive("old");
  memdb.state.docs.push({
    id: 1,
    docId: "old1",
    filename: "old.json",
    docpath: "custom-documents/ks-loc/old.json",
    workspaceId: 1,
    metadata: null,
    pinned: false,
    watched: false,
    createdAt: new Date(0),
    lastUpdatedAt: new Date(0),
  });
  memdb.state.nextId = 2;
  memdb.state.vecs.push({ docId: "old1", vectorId: "o0" });
  memdb.state.settings.set(
    marker.markerLabel(SLUG),
    JSON.stringify({ jobId: "x", versionId: 1, sourceRandomId: "r" })
  );
}

async function makeSource(tag, nRows = 3) {
  const jobId = uuidv4();
  const x = path.join(journalLib.jobDir(jobId), "x");
  await makeLance(path.join(x, "lancedb"), "src", nRows, tag);
  fs.mkdirSync(path.join(x, "documents"), { recursive: true });
  fs.writeFileSync(path.join(x, "documents", `${tag}.json`), `{"t":"${tag}"}`);
  return {
    jobId,
    source: {
      lance: path.join(x, "lancedb", "src.lance"),
      docs: path.join(x, "documents"),
      rows: {
        docs: [
          {
            docId: `${tag}1`,
            filename: `${tag}.json`,
            docpath: `custom-documents/ks-loc/${tag}.json`,
            metadata: null,
            pinned: false,
            watched: false,
            createdAt: "2024-01-01T00:00:00.000Z",
          },
        ],
        vectors: [{ docId: `${tag}1`, vectorId: `${tag}0` }],
      },
      marker: { versionId: 2, sourceRandomId: "r", syncedAt: "t" },
    },
  };
}

const run = (jobId, source, kind = "import") =>
  locks.withWorkspaceLock(SLUG, kind, () =>
    swap.runSwap({ jobId, kind, slug: SLUG, workspaceId: 1, source })
  );
const snap = () => ({
  lance: hashDir(liveLance()),
  docs: hashDir(liveDocs()),
  db: memdb.snapshot(),
});

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-swap-"));
  process.env.STORAGE_DIR = root;
  process.env.NODE_ENV = "test";
  locks._resetForTests();
  memdb.reset();
  swap.setFailpoint(null);
  jest.restoreAllMocks();
});
afterEach(() => {
  swap.setFailpoint(null);
  process.env = { ...OLD_ENV };
  fs.rmSync(root, { recursive: true, force: true });
});

describe("normal failures restore exactly", () => {
  test.each(["after:S1", "after:S2", "after:S3", "after:S4", "in:S5"])(
    "%s",
    async (fpName) => {
      await seedLiveFull();
      const before = snap();
      const { jobId, source } = await makeSource("new");
      swap.setFailpoint(fpName);
      await expect(run(jobId, source)).rejects.toBeInstanceOf(
        KnowledgeSyncError
      );
      expect(snap()).toEqual(before);
      expect(fs.existsSync(pend())).toBe(false);
      expect(fs.existsSync(journalLib.jobDir(jobId))).toBe(false);
      expect(await journalLib.readJournal(jobId)).toBeNull();
      expect(locks.heldCount()).toBe(0);
    }
  );

  test("first import (no live lance/docs) works and rolls back", async () => {
    const a = await makeSource("new");
    await run(a.jobId, a.source);
    expect(await countRows(liveLance())).toBe(3);

    // fresh workspace, failure
    fs.rmSync(paths.lancedbRoot(), { recursive: true, force: true });
    fs.rmSync(path.join(root, "documents"), { recursive: true, force: true });
    fs.rmSync(bk(), { recursive: true, force: true });
    memdb.reset();
    const before = snap();
    const b = await makeSource("n2");
    swap.setFailpoint("after:S4");
    await expect(run(b.jobId, b.source)).rejects.toThrow();
    expect(snap()).toEqual(before);
    expect(fs.existsSync(liveLance())).toBe(false);
  });
});

describe("success path and backup slot", () => {
  test("live = new, backup = old (lance, docs, rows, marker)", async () => {
    await seedLiveFull();
    const oldLance = hashDir(liveLance());
    const oldDocs = hashDir(liveDocs());
    const { jobId, source } = await makeSource("new", 4);
    await run(jobId, source);
    expect(await countRows(liveLance())).toBe(4);
    expect(fs.existsSync(path.join(liveDocs(), "new.json"))).toBe(true);
    expect(fs.existsSync(path.join(liveDocs(), "old.json"))).toBe(false);
    expect(hashDir(path.join(bk(), "lance"))).toBe(oldLance);
    expect(hashDir(path.join(bk(), "docs"))).toBe(oldDocs);
    const rows = JSON.parse(fs.readFileSync(path.join(bk(), "rows.json")));
    expect(rows.docs.map((d) => d.docId)).toEqual(["old1"]);
    expect(
      JSON.parse(fs.readFileSync(path.join(bk(), "marker.json"))).versionId
    ).toBe(1);
    expect(fs.existsSync(pend())).toBe(false);
    expect(memdb.state.docs.map((d) => d.docId)).toEqual(["new1"]);
    expect((await marker.readMarker(SLUG)).versionId).toBe(2);
    expect(memdb.calls.workspaces).toBe(0);
    expect(fs.existsSync(journalLib.jobDir(jobId))).toBe(false);
  });

  test("backup replaced only after the next import commits", async () => {
    await seedLiveFull();
    const oldLance = hashDir(liveLance());
    const a = await makeSource("one");
    await run(a.jobId, a.source);
    const oneLance = hashDir(liveLance());
    const b = await makeSource("two");
    swap.setFailpoint("in:S5");
    await expect(run(b.jobId, b.source)).rejects.toThrow();
    swap.setFailpoint(null);
    expect(hashDir(path.join(bk(), "lance"))).toBe(oldLance);
    const c = await makeSource("two");
    await run(c.jobId, c.source);
    expect(hashDir(path.join(bk(), "lance"))).toBe(oneLance);
  });

  test("rollback kind swaps live and backup back", async () => {
    await seedLiveFull();
    const oldLance = hashDir(liveLance());
    const a = await makeSource("one");
    await run(a.jobId, a.source);
    const newLance = hashDir(liveLance());
    const rows = JSON.parse(fs.readFileSync(path.join(bk(), "rows.json")));
    const mk = JSON.parse(fs.readFileSync(path.join(bk(), "marker.json")));
    const jobId = uuidv4();
    fs.mkdirSync(journalLib.jobDir(jobId), { recursive: true });
    await run(
      jobId,
      {
        lance: path.join(bk(), "lance"),
        docs: path.join(bk(), "docs"),
        rows,
        marker: mk,
      },
      "rollback"
    );
    expect(hashDir(liveLance())).toBe(oldLance);
    expect(memdb.state.docs.map((d) => d.docId)).toEqual(["old1"]);
    expect(hashDir(path.join(bk(), "lance"))).toBe(newLance);
  });

  test("lance table readable after S2 (fresh connect)", async () => {
    await seedLiveFull();
    const { jobId, source } = await makeSource("new", 5);
    await run(jobId, source);
    expect(await countRows(liveLance())).toBe(5);
  });
});

test("scale: 5000 rows in 500-row batches, one transaction", async () => {
  await seedLiveFull();
  const { jobId, source } = await makeSource("big");
  source.rows.docs = Array.from({ length: 5000 }, (_, i) => ({
    docId: `d${i}`,
    filename: `f${i}.json`,
    docpath: `custom-documents/ks-loc/f${i}.json`,
    metadata: null,
    pinned: false,
    watched: false,
    createdAt: "2024-01-01T00:00:00.000Z",
  }));
  source.rows.vectors = source.rows.docs.map((d, i) => ({
    docId: d.docId,
    vectorId: `v${i}`,
  }));
  const t0 = Date.now();
  await run(jobId, source);
  const ms = Date.now() - t0;
  console.log(`scale swap 5000 rows: ${ms}ms`);
  expect(ms).toBeLessThan(getKnowledgeSyncConfig().import_tx_timeout_ms);
  expect(memdb.state.docs).toHaveLength(5000);
  expect(memdb.state.vecs).toHaveLength(5000);
  expect(memdb.calls.tx).toBe(1);
});

describe("crash (kill) states are recoverable", () => {
  const flags = {
    "after:S1": { S1: true, S2: false, S3: false, S4: false },
    "after:S2": { S1: true, S2: true, S3: false, S4: false },
    "after:S3": { S1: true, S2: true, S3: true, S4: false },
    "after:S4": { S1: true, S2: true, S3: true, S4: true },
    "in:S5": { S1: true, S2: true, S3: true, S4: true },
  };
  test.each(Object.keys(flags))("crash:%s", async (name) => {
    await seedLiveFull();
    const before = snap();
    const { jobId, source } = await makeSource("new");
    swap.setFailpoint("crash:" + name);
    await expect(run(jobId, source)).rejects.toBeInstanceOf(swap.CrashSignal);
    swap.setFailpoint(null);
    locks._resetForTests();
    const j = await journalLib.readJournal(jobId);
    expect(j.state).toBe("swapping");
    expect(j.steps).toEqual(flags[name]);
    // DB untouched (tx did not commit)
    expect(memdb.snapshot()).toBe(before.db);
    // recovery from the journal alone restores the original state
    await swap.rollbackSwap(j);
    expect(snap()).toEqual(before);
    expect(fs.existsSync(pend())).toBe(false);
  });

  test("crash:after:S5 leaves marker present; finishSwap completes", async () => {
    await seedLiveFull();
    const { jobId, source } = await makeSource("new");
    swap.setFailpoint("crash:after:S5");
    await expect(run(jobId, source)).rejects.toBeInstanceOf(swap.CrashSignal);
    swap.setFailpoint(null);
    locks._resetForTests();
    const j = await journalLib.readJournal(jobId);
    expect(j.state).toBe("swapping");
    expect((await marker.readMarker(SLUG)).jobId).toBe(jobId);
    await swap.finishSwap(j);
    expect(await countRows(liveLance())).toBe(3);
    expect(fs.existsSync(path.join(bk(), "lance"))).toBe(true);
    expect(fs.existsSync(pend())).toBe(false);
  });

  test("crash:after:S6 leaves committed journal", async () => {
    await seedLiveFull();
    const { jobId, source } = await makeSource("new");
    swap.setFailpoint("crash:after:S6");
    await expect(run(jobId, source)).rejects.toBeInstanceOf(swap.CrashSignal);
    swap.setFailpoint(null);
    locks._resetForTests();
    const j = await journalLib.readJournal(jobId);
    expect(j.state).toBe("committed");
    await swap.finishSwap(j);
    await swap.finishSwap(j); // idempotent
    expect(fs.existsSync(pend())).toBe(false);
  });
});

test("post-commit normal failure does not roll back", async () => {
  await seedLiveFull();
  const { jobId, source } = await makeSource("new");
  swap.setFailpoint("after:S5");
  await expect(run(jobId, source)).rejects.toThrow();
  expect(memdb.state.docs.map((d) => d.docId)).toEqual(["new1"]);
  expect(await countRows(liveLance())).toBe(3);
});

test("EXDEV guard throws before any rename", async () => {
  await seedLiveFull();
  const before = snap();
  const { jobId, source } = await makeSource("new");
  jest.spyOn(paths, "assertSameFilesystem").mockImplementation(() => {
    throw new KnowledgeSyncError("KS_E_UNSAFE_ENTRY", { phase: "filesystem" });
  });
  await expect(run(jobId, source)).rejects.toThrow();
  expect(snap()).toEqual(before);
  expect(await journalLib.readJournal(jobId)).toBeNull();
  expect(fs.existsSync(source.lance)).toBe(true);
});

test("requires matching held lock", async () => {
  await seedLiveFull();
  const { jobId, source } = await makeSource("new");
  await expect(
    swap.runSwap({ jobId, kind: "import", slug: SLUG, workspaceId: 1, source })
  ).rejects.toThrow();
});
