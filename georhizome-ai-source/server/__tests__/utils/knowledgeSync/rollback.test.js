const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "ks-rb-init");

jest.mock("../../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(async ({ slug }) => (slug === "loc" ? { id: 1, slug } : null)),
  },
}));
jest.mock(
  "../../../utils/prisma",
  () => require("../../../__testhelpers__/memdb").db
);

const lancedb = require("@lancedb/lancedb");
const memdb = require("../../../__testhelpers__/memdb");
const { rollbackWorkspace } = require("../../../utils/knowledgeSync/rollback");
const {
  recoverKnowledgeSync,
} = require("../../../utils/knowledgeSync/recovery");
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
          r +
            ":" +
            crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex")
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

const bkSnap = () => ({
  lance: hashDir(path.join(bk(), "lance")),
  docs: hashDir(path.join(bk(), "docs")),
  rows: fs.existsSync(path.join(bk(), "rows.json"))
    ? fs.readFileSync(path.join(bk(), "rows.json"), "utf-8")
    : null,
});
const readIds = async (dir) => {
  const conn = await lancedb.connect(path.dirname(dir));
  const t = await conn.openTable(path.basename(dir, ".lance"));
  return (await t.query().toArray()).map((r) => r.id).sort();
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-rb-"));
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

async function twoVersions() {
  await seedLiveFull();
  const v1 = snap();
  const a = await makeSource("two", 3);
  await run(a.jobId, a.source);
  return v1;
}

test("restores v1 (lance, docs, rows, marker) and is reversible once", async () => {
  const v1 = await twoVersions();
  const v2 = snap();
  const r = await rollbackWorkspace({ slug: SLUG, userId: 1 });
  expect(r).toEqual({ slug: SLUG, restoredVersionId: 1 });
  expect(snap().lance).toBe(v1.lance);
  expect(snap().docs).toBe(v1.docs);
  expect(memdb.state.docs.map((d) => d.docId)).toEqual(["old1"]);
  expect((await marker.readMarker(SLUG)).versionId).toBe(1);
  expect(await readIds(liveLance())).toEqual(["o0", "o1"]);
  expect(memdb.calls.workspaces).toBe(0);
  expect(locks.heldCount()).toBe(0);
  // backup now holds v2
  expect(bkSnap().lance).toBe(v2.lance);
  await rollbackWorkspace({ slug: SLUG, userId: 1 });
  expect(snap().lance).toBe(v2.lance);
  expect(memdb.state.docs.map((d) => d.docId)).toEqual(["two1"]);
  expect((await marker.readMarker(SLUG)).versionId).toBe(2);
  expect(await readIds(liveLance())).toEqual(["two0", "two1", "two2"]);
});

test("no backup: KS_E_NO_BACKUP and nothing changed", async () => {
  await seedLiveFull();
  const before = snap();
  await expect(
    rollbackWorkspace({ slug: SLUG, userId: 1 })
  ).rejects.toMatchObject({ code: "KS_E_NO_BACKUP" });
  expect(snap()).toEqual(before);
  expect(locks.heldCount()).toBe(0);
});

test("unknown workspace: KS_E_NOT_FOUND", async () => {
  await expect(
    rollbackWorkspace({ slug: "nope", userId: 1 })
  ).rejects.toMatchObject({ code: "KS_E_NOT_FOUND" });
});

test("first-ever import then rollback restores empty state and deletes marker", async () => {
  const a = await makeSource("new");
  await run(a.jobId, a.source);
  expect(await marker.readMarker(SLUG)).not.toBeNull();
  const r = await rollbackWorkspace({ slug: SLUG, userId: 1 });
  expect(r.restoredVersionId).toBeNull();
  expect(fs.existsSync(liveLance())).toBe(false);
  expect(fs.existsSync(liveDocs())).toBe(false);
  expect(memdb.state.docs).toEqual([]);
  expect(await marker.readMarker(SLUG)).toBeNull();
  // reversible: rolling back again restores the imported version
  await rollbackWorkspace({ slug: SLUG, userId: 1 });
  expect(await countRows(liveLance())).toBe(3);
  expect((await marker.readMarker(SLUG)).versionId).toBe(2);
});

test.each(["after:S1", "after:S2", "after:S3", "after:S4", "in:S5"])(
  "failpoint %s restores the post-v2 state",
  async (fpName) => {
    await twoVersions();
    const before = snap();
    const bb = bkSnap();
    swap.setFailpoint(fpName);
    await expect(
      rollbackWorkspace({ slug: SLUG, userId: 1 })
    ).rejects.toBeInstanceOf(KnowledgeSyncError);
    swap.setFailpoint(null);
    expect(snap()).toEqual(before);
    expect(bkSnap()).toEqual(bb);
    expect(fs.existsSync(pend())).toBe(false);
    expect(locks.heldCount()).toBe(0);
  }
);

test.each(["after:S2", "after:S4", "after:S5", "after:S6"])(
  "crash %s then recovery gives a consistent state",
  async (name) => {
    const v1 = await twoVersions();
    const v2 = snap();
    swap.setFailpoint("crash:" + name);
    await expect(
      rollbackWorkspace({ slug: SLUG, userId: 1 })
    ).rejects.toBeInstanceOf(swap.CrashSignal);
    swap.setFailpoint(null);
    locks._resetForTests();
    await recoverKnowledgeSync();
    const after = snap();
    const committed = name === "after:S5" || name === "after:S6";
    const want = committed ? v1 : v2;
    expect(after.lance).toBe(want.lance);
    expect(after.docs).toBe(want.docs);
    expect(memdb.state.docs.map((d) => d.docId)).toEqual(
      committed ? ["old1"] : ["two1"]
    );
    expect((await marker.readMarker(SLUG)).versionId).toBe(committed ? 1 : 2);
    expect(fs.existsSync(pend())).toBe(false);
  }
);

test("busy lock: KS_E_BUSY", async () => {
  await twoVersions();
  locks.acquire(SLUG, "export");
  await expect(
    rollbackWorkspace({ slug: SLUG, userId: 1 })
  ).rejects.toMatchObject({ code: "KS_E_BUSY" });
});
