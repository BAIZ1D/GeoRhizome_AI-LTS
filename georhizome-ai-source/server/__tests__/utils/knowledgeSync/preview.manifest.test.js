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
let exported;
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
  exported = res;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  fs.rmSync(root, { recursive: true, force: true });
});

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
const both = async () => {
  const full = await preview.previewImport({
    archiveName: path.basename(archivePath),
    passphrase: PW,
    userId: 7,
    config,
  });
  const fromManifest = await preview.previewFromManifest({
    manifest: exported.manifest,
    docs: exported.docs,
    indexTotalSize: 123,
  });
  return { full, fromManifest };
};
const strip = ({ previewId: _p, archiveBytes: _a, ...rest }) => rest;

test("previewFromManifest equals previewImport (matched, local-only docs)", async () => {
  setLocal([D("d1", "custom-documents/doc1.json"), D("m1", "a/y.json")]);
  const { full, fromManifest } = await both();
  expect(strip(fromManifest)).toEqual(strip(full));
  expect(fromManifest.previewId).toBeNull();
  expect(fromManifest.archiveBytes).toBe(123);
  expect(fromManifest.localOnlyDocs.map((d) => d.docId)).toEqual(["m1"]);
});

test("previewFromManifest equals previewImport (unmatched target)", async () => {
  mockWs = async () => null;
  setLocal([]);
  const { full, fromManifest } = await both();
  expect(strip(fromManifest)).toEqual(strip(full));
  expect(fromManifest.target.matched).toBe(false);
});

test("previewFromManifest reports incompatible embedder as blocking", async () => {
  setLocal([D("d1", "custom-documents/doc1.json")]);
  process.env.EMBEDDING_MODEL_PREF = "other/model";
  const { full, fromManifest } = await both();
  expect(fromManifest.compatibility.ok).toBe(false);
  expect(fromManifest.blocking).toContain("KS_E_EMBEDDER_MISMATCH");
  expect(strip(fromManifest)).toEqual(strip(full));
});
