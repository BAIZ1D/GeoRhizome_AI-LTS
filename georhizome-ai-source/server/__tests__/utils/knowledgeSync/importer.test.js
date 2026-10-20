const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "ks-imp-init");

let mockWsList = [];
const mockW = {
  get: jest.fn(
    async (c) =>
      mockWsList.find((w) =>
        c.slug ? w.slug === c.slug : w.name === c.name
      ) || null
  ),
  new: jest.fn(async (name) => {
    const w = {
      id: 5,
      name,
      slug: name.toLowerCase().replace(/\s+/g, "-"),
      openAiTemp: null,
    };
    mockWsList.push(w);
    return { workspace: w, message: null };
  }),
  delete: jest.fn(async ({ id }) => {
    mockWsList = mockWsList.filter((w) => w.id !== id);
    return true;
  }),
  update: jest.fn(),
};
const mockSettings = new Map();
jest.mock(
  "../../../utils/prisma",
  () => require("../../../__testhelpers__/memdb").db
);
jest.mock("../../../models/workspace", () => ({ Workspace: mockW }));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    get: jest.fn(async ({ label }) =>
      mockSettings.has(label) ? { value: mockSettings.get(label) } : null
    ),
    _updateSettings: jest.fn(async (o) => {
      for (const [k, v] of Object.entries(o)) mockSettings.set(k, v);
    }),
  },
}));

const lancedb = require("@lancedb/lancedb");
const memdb = require("../../../__testhelpers__/memdb");
const {
  PW,
  testConfig,
  buildArchive,
} = require("../../../__testhelpers__/ksfixture");
const preview = require("../../../utils/knowledgeSync/preview");
const { confirmImport } = require("../../../utils/knowledgeSync/importer");
const swap = require("../../../utils/knowledgeSync/swap");
const locks = require("../../../utils/knowledgeSync/locks");
const marker = require("../../../utils/knowledgeSync/marker");
const paths = require("../../../utils/knowledgeSync/paths");

const config = testConfig();
const OLD_ENV = { ...process.env };
let root;
let archiveName;

const W1 = () => ({ id: 1, name: "WS One", slug: "ws1", openAiTemp: 0.3 });
async function seedLocalWs1() {
  mockWsList = [W1()];
  const conn = await lancedb.connect(path.join(root, "lancedb"));
  await conn.createTable("ws1", [{ id: "z", vector: [1, 1], text: "z" }]);
  const d = paths.ksDocsDir("ws1");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "localold.json"), "{}");
  const mk = (docId, pinned) => ({
    id: memdb.state.nextId++,
    docId,
    filename: docId + ".json",
    docpath: `custom-documents/ks-ws1/${docId}.json`,
    workspaceId: 1,
    metadata: null,
    pinned,
    watched: false,
    createdAt: new Date(),
    lastUpdatedAt: new Date(),
  });
  memdb.state.docs.push(mk("loc1", true), mk("d1", true));
  memdb.state.vecs.push({ docId: "loc1", vectorId: "z" });
}
const prev = (userId = 7) =>
  preview.previewImport({ archiveName, passphrase: PW, userId, config });
const rowCount = async (slug) =>
  (
    await (await lancedb.connect(paths.lancedbRoot())).openTable(slug)
  ).countRows();
const dirs = () =>
  JSON.stringify([
    fs.existsSync(paths.lancedbRoot())
      ? fs.readdirSync(paths.lancedbRoot())
      : [],
    fs.existsSync(paths.documentsRoot())
      ? fs.readdirSync(paths.documentsRoot())
      : [],
  ]);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-imp-"));
  locks._resetForTests();
  mockSettings.clear();
  mockWsList = [W1()];
  archiveName = await buildArchive(root, config);
  Object.values(mockW).forEach((f) => f.mockClear());
  jest.restoreAllMocks();
});
afterEach(() => {
  swap.setFailpoint(null);
  process.env = { ...OLD_ENV };
  fs.rmSync(root, { recursive: true, force: true });
});

test("matched by slug: workspaces row untouched, local-only removed, flags kept", async () => {
  await seedLocalWs1();
  const p = await prev();
  const r = await confirmImport({
    previewId: p.previewId,
    userId: 7,
    passphrase: PW,
    config,
  });
  expect(r).toMatchObject({ slug: "ws1", docCount: 1, created: false });
  expect(mockW.new).not.toHaveBeenCalled();
  expect(mockW.update).not.toHaveBeenCalled();
  expect(memdb.calls.workspaces).toBe(0);
  expect(mockWsList[0]).toEqual(W1());
  expect(await rowCount("ws1")).toBe(2);
  expect(memdb.state.docs.map((d) => d.docId)).toEqual(["d1"]);
  expect(memdb.state.docs[0]).toMatchObject({
    docpath: "custom-documents/ks-ws1/doc1.json",
    filename: "doc1.json",
    pinned: true,
  });
  expect(memdb.state.vecs.map((v) => v.vectorId).sort()).toEqual(["v1", "v2"]);
  expect((await marker.readMarker("ws1")).versionId).toBe(p.versionId);
  expect(locks.heldCount()).toBe(0);
  expect(
    fs.existsSync(path.join(paths.documentsRoot(), memdb.state.docs[0].docpath))
  ).toBe(true);
});

test("unmatched archive creates workspace with defaults then imports", async () => {
  mockWsList = [];
  const p = await prev();
  const r = await confirmImport({
    previewId: p.previewId,
    userId: 7,
    passphrase: PW,
    config,
  });
  expect(mockW.new).toHaveBeenCalledWith("WS One", 7);
  expect(r).toMatchObject({ slug: "ws-one", created: true });
  expect(await rowCount("ws-one")).toBe(2);
  expect(memdb.state.docs[0].workspaceId).toBe(5);
  expect(memdb.state.docs[0].docpath).toBe(
    "custom-documents/ks-ws-one/doc1.json"
  );
  expect(mockW.update).not.toHaveBeenCalled();
});

test("failed swap deletes the created workspace", async () => {
  mockWsList = [];
  const p = await prev();
  swap.setFailpoint("after:S2");
  await expect(
    confirmImport({ previewId: p.previewId, userId: 7, passphrase: PW, config })
  ).rejects.toThrow();
  expect(mockW.delete).toHaveBeenCalledWith({ id: 5 });
  expect(mockWsList).toEqual([]);
  expect(memdb.state.docs).toEqual([]);
  expect(locks.heldCount()).toBe(0);
});

test("incompatible at confirm: refused with zero fs/DB changes", async () => {
  await seedLocalWs1();
  const p = await prev();
  process.env.EMBEDDING_DIMENSION = "3";
  const fsBefore = dirs();
  const dbBefore = memdb.snapshot();
  const txBefore = memdb.calls.tx;
  await expect(
    confirmImport({ previewId: p.previewId, userId: 7, passphrase: PW, config })
  ).rejects.toMatchObject({ code: "KS_E_DIM_MISMATCH" });
  expect(dirs()).toBe(fsBefore);
  expect(memdb.snapshot()).toBe(dbBefore);
  expect(memdb.calls.tx).toBe(txBefore);
  expect(memdb.calls.workspaces).toBe(0);
  expect(mockW.new).not.toHaveBeenCalled();
  expect(mockW.delete).not.toHaveBeenCalled();
  expect(fs.existsSync(path.join(paths.backupRoot("ws1")))).toBe(false);
});

test("stale version refused", async () => {
  await seedLocalWs1();
  memdb.state.settings.set(
    marker.markerLabel("ws1"),
    JSON.stringify({ jobId: "x", versionId: 99, sourceRandomId: "zzz" })
  );
  const p = await prev();
  await expect(
    confirmImport({ previewId: p.previewId, userId: 7, passphrase: PW, config })
  ).rejects.toMatchObject({ code: "KS_E_VERSION_STALE" });
});

test("busy lock refused and created workspace removed", async () => {
  mockWsList = [];
  const p = await prev();
  locks.acquire("ws-one", "export");
  await expect(
    confirmImport({ previewId: p.previewId, userId: 7, passphrase: PW, config })
  ).rejects.toMatchObject({ code: "KS_E_BUSY" });
  expect(mockWsList).toEqual([]);
  expect(memdb.state.docs).toEqual([]);
});

test("other user's preview refused", async () => {
  await seedLocalWs1();
  const p = await prev(7);
  const before = memdb.snapshot();
  await expect(
    confirmImport({ previewId: p.previewId, userId: 8, passphrase: PW, config })
  ).rejects.toMatchObject({ code: "KS_E_PREVIEW_INVALID" });
  expect(memdb.snapshot()).toBe(before);
});

test("workspace is syncing during the swap", async () => {
  await seedLocalWs1();
  const p = await prev();
  const orig = swap.runSwap;
  let seen = null;
  jest.spyOn(swap, "runSwap").mockImplementation(async (c, o) => {
    seen = locks.syncing("ws1");
    return orig(c, o);
  });
  await confirmImport({
    previewId: p.previewId,
    userId: 7,
    passphrase: PW,
    config,
  });
  expect(seen).toBe(true);
  expect(locks.syncing("ws1")).toBe(false);
});

test("CR-03: concurrent confirm of the same preview is refused, one workspace created", async () => {
  mockWsList = [];
  let n = 0;
  mockW.new.mockImplementation(async (name) => {
    n += 1;
    const w = { id: 4 + n, name, slug: `ws-one-${n}`, openAiTemp: null };
    mockWsList.push(w);
    return { workspace: w, message: null };
  });
  const p = await prev();
  const args = { previewId: p.previewId, userId: 7, passphrase: PW, config };
  const res = await Promise.allSettled([
    confirmImport(args),
    confirmImport(args),
  ]);
  expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  const rej = res.find((r) => r.status === "rejected");
  expect(rej.reason).toMatchObject({ code: "KS_E_BUSY", phase: "claim" });
  expect(mockW.new).toHaveBeenCalledTimes(1);
  expect(mockWsList).toHaveLength(1);
  expect(locks.heldCount()).toBe(0);
});
