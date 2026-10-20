const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "ks-rec-init");

jest.mock("../../../models/workspace", () => ({
  Workspace: { delete: jest.fn(async () => {}) },
}));
jest.mock(
  "../../../utils/prisma",
  () => require("../../../__testhelpers__/memdb").db
);

const lancedb = require("@lancedb/lancedb");
const memdb = require("../../../__testhelpers__/memdb");
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

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-rec-"));
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

const crash = async (name, { seed = true } = {}) => {
  if (seed) await seedLiveFull();
  const before = snap();
  const { jobId, source } = await makeSource("new");
  swap.setFailpoint("crash:" + name);
  await expect(run(jobId, source)).rejects.toBeInstanceOf(swap.CrashSignal);
  swap.setFailpoint(null);
  locks._resetForTests();
  return { before, jobId };
};
const noResidue = (jobId) => {
  expect(fs.existsSync(pend())).toBe(false);
  expect(fs.existsSync(journalLib.jobDir(jobId))).toBe(false);
};

describe("kill at every step", () => {
  test.each(["after:S1", "after:S2", "after:S3", "after:S4", "in:S5"])(
    "rolls back after crash:%s",
    async (name) => {
      const { before, jobId } = await crash(name);
      const r = await recoverKnowledgeSync();
      expect(r.rolledBack).toBe(1);
      expect(r.finished).toBe(0);
      expect(snap()).toEqual(before);
      noResidue(jobId);
      const r2 = await recoverKnowledgeSync();
      expect(r2).toEqual({
        recovered: 0,
        rolledBack: 0,
        finished: 0,
        cleaned: 0,
        interrupted: 0,
      });
      expect(snap()).toEqual(before);
    }
  );

  test.each(["after:S5", "after:S6"])(
    "finishes after crash:%s",
    async (name) => {
      await seedLiveFull();
      const oldLance = hashDir(liveLance());
      const { jobId } = await crash(name, { seed: false });
      const r = await recoverKnowledgeSync();
      expect(r.finished).toBe(1);
      expect(await countRows(liveLance())).toBe(3);
      expect(fs.existsSync(path.join(liveDocs(), "new.json"))).toBe(true);
      expect(hashDir(path.join(bk(), "lance"))).toBe(oldLance);
      expect(memdb.state.docs.map((d) => d.docId)).toEqual(["new1"]);
      noResidue(jobId);
      const again = await recoverKnowledgeSync();
      expect(again.recovered).toBe(0);
      expect(await countRows(liveLance())).toBe(3);
    }
  );
});

test("created workspace crash removes the created workspace", async () => {
  const { Workspace } = require("../../../models/workspace");
  const before = snap();
  const jobId = uuidv4();
  const { source } = await makeSource("new");
  swap.setFailpoint("crash:after:S2");
  await expect(
    locks.withWorkspaceLock(SLUG, "import", () =>
      swap.runSwap({
        jobId,
        kind: "import",
        slug: SLUG,
        workspaceId: 1,
        createdWorkspaceId: 7,
        source,
      })
    )
  ).rejects.toBeInstanceOf(swap.CrashSignal);
  swap.setFailpoint(null);
  await recoverKnowledgeSync();
  expect(Workspace.delete).toHaveBeenCalledWith({ id: 7 });
  expect(snap()).toEqual(before);
});

test("rollback kind committed with restored-null marker is finished", async () => {
  await seedLiveFull();
  const a = await makeSource("one");
  await run(a.jobId, a.source);
  const rows = JSON.parse(fs.readFileSync(path.join(bk(), "rows.json")));
  const jobId = uuidv4();
  fs.mkdirSync(journalLib.jobDir(jobId), { recursive: true });
  swap.setFailpoint("crash:after:S5");
  await expect(
    run(
      jobId,
      {
        lance: path.join(bk(), "lance"),
        docs: path.join(bk(), "docs"),
        rows,
        marker: null,
      },
      "rollback"
    )
  ).rejects.toBeInstanceOf(swap.CrashSignal);
  swap.setFailpoint(null);
  locks._resetForTests();
  expect(await marker.readMarker(SLUG)).toBeNull();
  const r = await recoverKnowledgeSync();
  expect(r.finished).toBe(1);
  expect(r.rolledBack).toBe(0);
  expect(memdb.state.docs.map((d) => d.docId)).toEqual(["old1"]);
  expect(await marker.readMarker(SLUG)).toBeNull();
  expect(fs.existsSync(journalLib.jobDir(jobId))).toBe(false);
});

describe("quarantine and stale cleanup", () => {
  const stagingDir = () => paths.stagingRoot();
  const mk = (id, files = { "x.txt": "x" }) => {
    const d = path.join(stagingDir(), id);
    fs.mkdirSync(d, { recursive: true });
    for (const [k, v] of Object.entries(files))
      fs.writeFileSync(path.join(d, k), v);
    return d;
  };
  const age = (d, hours) => {
    const t = new Date(Date.now() - hours * 3600 * 1000);
    fs.utimesSync(d, t, t);
  };

  test("unsafe slug journal quarantined without renames", async () => {
    await seedLiveFull();
    const before = snap();
    const id = uuidv4();
    const d = mk(id, {
      "journal.json": JSON.stringify({
        v: 1,
        jobId: id,
        kind: "import",
        slug: "../x",
        state: "swapping",
        steps: { S1: true, S2: true, S3: true, S4: true },
        hadLance: true,
        hadDocs: true,
        createdWorkspaceId: null,
        createdAt: "t",
      }),
    });
    await recoverKnowledgeSync();
    expect(fs.existsSync(d)).toBe(false);
    expect(snap()).toEqual(before);
  });

  test("old orphan removed, fresh orphan kept, corrupt journal handled", async () => {
    const old = mk(uuidv4());
    age(old, 100);
    const fresh = mk(uuidv4());
    const corrupt = mk(uuidv4(), { "journal.json": "{not json" });
    age(corrupt, 100);
    const corruptFresh = mk(uuidv4(), { "journal.json": "{not json" });
    const r = await recoverKnowledgeSync();
    expect(r.cleaned).toBe(2);
    expect(fs.existsSync(old)).toBe(false);
    expect(fs.existsSync(corrupt)).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(corruptFresh)).toBe(true);
  });
});

test("never throws when the DB throws", async () => {
  const { jobId } = await crash("after:S4");
  jest
    .spyOn(memdb.db.system_settings, "findFirst")
    .mockRejectedValue(new Error("db down"));
  const r = await recoverKnowledgeSync();
  expect(r.recovered).toBe(0);
  expect(typeof r.cleaned).toBe("number");
  // journal retained so a later boot can retry
  expect(await journalLib.readJournal(jobId)).not.toBeNull();
});

describe("explicit commit token (W3), pre-swap and target markers both null", () => {
  const seedUnsynced = async () => {
    await seedLiveFull();
    memdb.state.settings.delete(marker.markerLabel(SLUG));
  };
  const crashBothNull = async (name) => {
    await seedUnsynced();
    const before = snap();
    const { jobId, source } = await makeSource("new");
    source.marker = null;
    swap.setFailpoint("crash:" + name);
    await expect(run(jobId, source, "rollback")).rejects.toBeInstanceOf(
      swap.CrashSignal
    );
    swap.setFailpoint(null);
    locks._resetForTests();
    expect(await marker.readMarker(SLUG)).toBeNull();
    return { before, jobId };
  };

  test("DB committed -> finishSwap", async () => {
    const { jobId } = await crashBothNull("after:S5");
    const fin = jest.spyOn(swap, "finishSwap");
    const rb = jest.spyOn(swap, "rollbackSwap");
    const r = await recoverKnowledgeSync();
    expect(r.finished).toBe(1);
    expect(r.rolledBack).toBe(0);
    expect(fin).toHaveBeenCalled();
    expect(rb).not.toHaveBeenCalled();
    expect(await countRows(liveLance())).toBe(3);
    expect(memdb.state.docs.map((d) => d.docId)).toEqual(["new1"]);
    noResidue(jobId);
    expect(await marker.hasCommitToken(jobId)).toBe(false);
  });

  test("DB not committed -> rollbackSwap", async () => {
    const { before, jobId } = await crashBothNull("in:S5");
    const fin = jest.spyOn(swap, "finishSwap");
    const rb = jest.spyOn(swap, "rollbackSwap");
    const r = await recoverKnowledgeSync();
    expect(r.rolledBack).toBe(1);
    expect(r.finished).toBe(0);
    expect(rb).toHaveBeenCalled();
    expect(fin).not.toHaveBeenCalled();
    expect(snap()).toEqual(before);
    noResidue(jobId);
  });

  test("token is authority and cleaned by finishSwap", async () => {
    const { jobId, source } = await makeSource("tok");
    await seedLiveFull();
    swap.setFailpoint("crash:after:S5");
    await expect(run(jobId, source)).rejects.toBeInstanceOf(swap.CrashSignal);
    swap.setFailpoint(null);
    locks._resetForTests();
    expect(await marker.hasCommitToken(jobId)).toBe(true);
    await recoverKnowledgeSync();
    expect(await marker.hasCommitToken(jobId)).toBe(false);
  });
});

test("WR-04: failed recovery fences the slug (syncing, other locks refused)", async () => {
  const jobId = uuidv4();
  await journalLib.createJournal(jobId, { kind: "import", slug: SLUG });
  await journalLib.updateJournal(jobId, { state: "committed" });
  const spy = jest
    .spyOn(swap, "finishSwap")
    .mockRejectedValue(Object.assign(new Error("x"), { code: "EXDEV" }));
  try {
    await recoverKnowledgeSync();
  } finally {
    spy.mockRestore();
  }
  expect(locks.syncing(SLUG)).toBe(true);
  expect(() => locks.assertNotSyncing(SLUG)).toThrow(
    expect.objectContaining({ code: "KS_E_SYNCING" })
  );
  expect(() => locks.acquire(SLUG, "import")).toThrow(
    expect.objectContaining({ code: "KS_E_BUSY" })
  );
  locks._resetForTests();
  await journalLib.removeJournalDir(jobId);
});

test("D-07: boot sweep marks non-terminal job breadcrumbs interrupted", async () => {
  const mk = (slug, state) =>
    marker.writeJobBreadcrumb(slug, {
      jobId: uuidv4(),
      userId: 3,
      kind: "publish",
      state,
      phase: "upload",
    });
  await mk("jrun", "running");
  await mk("jawait", "awaiting_confirm");
  await mk("jdone", "succeeded");
  const r = await recoverKnowledgeSync();
  expect(r.interrupted).toBe(2);
  expect((await marker.readJobBreadcrumb("jrun")).state).toBe("interrupted");
  expect((await marker.readJobBreadcrumb("jawait")).state).toBe("interrupted");
  expect((await marker.readJobBreadcrumb("jdone")).state).toBe("succeeded");
  expect((await marker.readJobBreadcrumb("jrun")).userId).toBe(3);
});
