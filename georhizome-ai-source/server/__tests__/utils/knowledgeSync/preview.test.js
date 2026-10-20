const fs = require("fs");
const os = require("os");
const path = require("path");
const tar = require("tar");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "ks-stg-init");

const mockStore = new Map();
let mockWs = async ({ slug }) =>
  slug === "ws1" ? { id: 1, name: "WS One", slug: "ws1" } : null;
const mockPrisma = {
  workspace_documents: {
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    deleteMany: jest.fn(),
  },
  document_vectors: { findMany: jest.fn() },
  workspaces: { create: jest.fn(), update: jest.fn() },
  $transaction: jest.fn(),
  system_settings: {
    findFirst: jest.fn(async ({ where }) =>
      mockStore.has(where.label) ? { value: mockStore.get(where.label) } : null
    ),
    upsert: jest.fn(async ({ where, create }) => {
      mockStore.set(where.label, create.value);
    }),
  },
};
jest.mock("../../../utils/prisma", () => mockPrisma);
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(async (c) => mockWs(c)),
  },
}));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    get: jest.fn(async ({ label }) =>
      mockStore.has(label) ? { value: mockStore.get(label) } : null
    ),
    _updateSettings: jest.fn(async (o) => {
      for (const [k, v] of Object.entries(o)) mockStore.set(k, v);
    }),
  },
}));

const lancedb = require("@lancedb/lancedb");
const { exportWorkspace } = require("../../../utils/knowledgeSync/exporter");
const preview = require("../../../utils/knowledgeSync/preview");
const locks = require("../../../utils/knowledgeSync/locks");
const {
  getKnowledgeSyncConfig,
} = require("../../../utils/knowledgeSync/config");
const {
  decryptFile,
  encryptFile,
} = require("../../../utils/knowledgeSync/crypto");
const {
  extractArchive,
  packDirectory,
} = require("../../../utils/knowledgeSync/archive");
const paths = require("../../../utils/knowledgeSync/paths");

const PW = "correct horse battery";
const base = getKnowledgeSyncConfig();
const config = {
  ...base,
  chunk_size_bytes: 1024,
  scrypt: { ...base.scrypt, N: 1024 },
  allowedScryptParams: [{ N: 1024, r: base.scrypt.r, p: base.scrypt.p }],
  allowedChunkSizes: [1024],
};
let root;
let archivePath;
const OLD_ENV = { ...process.env };

beforeEach(async () => {
  mockWs = async ({ slug }) =>
    slug === "ws1" ? { id: 1, name: "WS One", slug: "ws1" } : null;
  mockStore.clear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-stg-"));
  process.env.STORAGE_DIR = root;
  process.env.NODE_ENV = "test";
  process.env.EMBEDDING_DIMENSION = "2";
  locks._resetForTests();
  const conn = await lancedb.connect(path.join(root, "lancedb"));
  await conn.createTable("ws1", [
    { id: "v1", vector: [0.1, 0.2], text: "a" },
    { id: "v2", vector: [0.3, 0.4], text: "b" },
  ]);
  fs.mkdirSync(path.join(root, "documents", "custom-documents"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "documents", "custom-documents", "doc1.json"),
    JSON.stringify({ title: "t" })
  );
  mockPrisma.workspace_documents.findMany.mockResolvedValue([
    {
      docId: "d1",
      filename: "doc1.json",
      docpath: "custom-documents/doc1.json",
      metadata: null,
      pinned: false,
      watched: false,
      createdAt: new Date(),
    },
  ]);
  mockPrisma.document_vectors.findMany.mockResolvedValue([
    { docId: "d1", vectorId: "v1" },
    { docId: "d1", vectorId: "v2" },
  ]);
  const res = await exportWorkspace({ slug: "ws1", passphrase: PW, config });
  archivePath = res.archivePath;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  fs.rmSync(root, { recursive: true, force: true });
});

const staging = () => paths.stagingRoot({ config });
const leftovers = () =>
  fs.existsSync(staging())
    ? fs.readdirSync(staging()).filter((n) => n !== "exports")
    : [];
const NAME = () => path.basename(archivePath);
const writeCalls = () =>
  [
    mockPrisma.workspace_documents.create,
    mockPrisma.workspace_documents.update,
    mockPrisma.workspace_documents.delete,
    mockPrisma.workspace_documents.deleteMany,
    mockPrisma.workspaces.create,
    mockPrisma.workspaces.update,
    mockPrisma.$transaction,
  ].reduce((n, f) => n + f.mock.calls.length, 0) +
  mockPrisma.system_settings.upsert.mock.calls.length;

// workspace_documents.findMany: export-time call returns d1; for preview
// it's driven per-test via mockImplementation.
function setLocal(docs) {
  mockPrisma.workspace_documents.findMany.mockImplementation(
    async ({ where }) => {
      if (where.docId)
        return docs.filter((d) => where.docId.in.includes(d.docId));
      return docs.filter((d) => d.workspaceId === where.workspaceId);
    }
  );
}
const D = (docId, docpath, workspaceId = 1) => ({
  docId,
  filename: docpath,
  docpath,
  workspaceId,
});
const run = (o = {}) =>
  preview.previewImport({
    archiveName: NAME(),
    passphrase: PW,
    userId: 7,
    config,
    ...o,
  });

test("matched by slug; shape and no live writes", async () => {
  setLocal([D("d1", "custom-documents/doc1.json")]);
  mockStore.clear();
  const writesBefore = writeCalls();
  const lanceBefore = fs.readdirSync(path.join(root, "lancedb"));
  const r = await run();
  expect(r.target).toEqual({ matched: true, slug: "ws1", name: "WS One" });
  expect(Object.keys(r)).toEqual(
    expect.arrayContaining([
      "previewId",
      "versionId",
      "sizeBytes",
      "docCount",
      "compatibility",
      "localOnlyDocs",
    ])
  );
  expect(Object.keys(r).indexOf("localOnlyDocs")).toBe(
    Object.keys(r).indexOf("target") + 1
  );
  expect(r.docCount).toBe(1);
  expect(r.compatibility.ok).toBe(true);
  expect(r.blocking).toEqual([]);
  expect(Array.isArray(r.localOnlyDocs)).toBe(true);
  expect(writeCalls()).toBe(writesBefore);
  expect(fs.readdirSync(path.join(root, "lancedb"))).toEqual(lanceBefore);
  const meta = JSON.parse(
    fs.readFileSync(path.join(staging(), r.previewId, "preview.json"), "utf-8")
  );
  expect(meta.ownerUserId).toBe(7);
  expect(JSON.stringify(meta)).not.toContain(PW);
});

test("matched by name", async () => {
  mockWs = async (c) =>
    c.name === "WS One" ? { id: 1, name: "WS One", slug: "other" } : null;
  setLocal([D("d1", "custom-documents/doc1.json")]);
  const r = await run();
  expect(r.target).toMatchObject({ matched: true, slug: "other" });
});

test("no match: will create, localOnlyDocs empty array", async () => {
  mockWs = async () => null;
  setLocal([]);
  const r = await run();
  expect(r.target).toEqual({ matched: false, slug: null, name: "WS One" });
  expect(r.localOnlyDocs).toEqual([]);
  expect(r.blocking).toEqual([]);
});

test("localOnlyDocs sorted, excludes archive docs", async () => {
  setLocal([
    D("z2", "b/x.json"),
    D("d1", "custom-documents/doc1.json"),
    D("a9", "b/x.json"),
    D("m1", "a/y.json"),
  ]);
  const r = await run();
  expect(r.localOnlyDocs.map((d) => d.docId)).toEqual(["m1", "a9", "z2"]);
});

test("incompatible embedder: ok=false, both ids shown, blocking", async () => {
  setLocal([D("d1", "custom-documents/doc1.json")]);
  process.env.EMBEDDING_MODEL_PREF = "other/model";
  const r = await run();
  expect(r.compatibility.ok).toBe(false);
  expect(r.compatibility.reasons[0]).toMatchObject({
    field: "modelId",
    expected: "other/model",
  });
  expect(r.compatibility.reasons[0].actual).toBeTruthy();
  expect(r.blocking).toContain("KS_E_EMBEDDER_MISMATCH");
});

async function ridOf() {
  const r = await run();
  const st = await require("../../../utils/knowledgeSync/stage").loadStaged(
    r.previewId,
    { config }
  );
  return { rid: st.manifest.workspace.randomId, v: r.versionId };
}
const setMarker = (value) =>
  mockStore.set("ks_synced_ws1", JSON.stringify(value));

test("stale version blocks (same id, v <= marker)", async () => {
  setLocal([D("d1", "custom-documents/doc1.json")]);
  const { rid, v } = await ridOf();
  setMarker({ sourceRandomId: rid, versionId: v });
  expect((await run()).blocking).toContain("KS_E_VERSION_STALE");
  setMarker({ sourceRandomId: rid, versionId: v - 1 });
  expect((await run()).blocking).not.toContain("KS_E_VERSION_STALE");
});

test("different sourceRandomId on marked workspace blocks", async () => {
  setLocal([D("d1", "custom-documents/doc1.json")]);
  setMarker({ sourceRandomId: "ffffffff", versionId: 0 });
  expect((await run()).blocking).toContain("KS_E_VERSION_STALE");
});

test("docId owned by another workspace blocks (matched and unmatched)", async () => {
  setLocal([D("d1", "custom-documents/doc1.json", 99)]);
  expect((await run()).blocking).toContain("KS_E_DOCID_CONFLICT");
  mockWs = async () => null;
  expect((await run()).blocking).toContain("KS_E_DOCID_CONFLICT");
});

test("validateConfirmable recomputes blocking", async () => {
  setLocal([D("d1", "custom-documents/doc1.json")]);
  const r = await run();
  const st = await require("../../../utils/knowledgeSync/stage").loadStaged(
    r.previewId,
    { config }
  );
  expect((await preview.validateConfirmable(st)).ok).toBe(true);
  setLocal([D("d1", "custom-documents/doc1.json", 99)]);
  const v = await preview.validateConfirmable(st);
  expect(v.ok).toBe(false);
  expect(v.blocking).toContain("KS_E_DOCID_CONFLICT");
});

test("stage failure leaves nothing", async () => {
  await expect(run({ passphrase: "wrong wrong wrong" })).rejects.toMatchObject({
    code: "KS_E_PASSPHRASE",
  });
  expect(leftovers()).toEqual([]);
});
