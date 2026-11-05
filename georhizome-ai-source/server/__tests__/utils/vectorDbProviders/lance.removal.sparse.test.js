/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lance-sparse-extra-"));
process.env.STORAGE_DIR = TMP;

const DIM = 8;
const settings = (global.__sparseTestSettings = { size: 100, overlap: 0 });

jest.mock("../../../utils/files", () => ({
  storeVectorResult: jest.fn(async () => {}),
  cachedVectorInformation: jest.fn(async () => ({ exists: false, chunks: [] })),
}));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    getValueOrFallback: jest.fn(async ({ label }) =>
      label === "text_splitter_chunk_size"
        ? global.__sparseTestSettings.size
        : global.__sparseTestSettings.overlap
    ),
  },
}));
jest.mock("../../../models/vectors", () => {
  const store = [];
  global.__dvStore = store;
  return {
    DocumentVectors: {
      bulkInsert: jest.fn(async (recs) => {
        store.push(...recs);
        return true;
      }),
      delete: jest.fn(async () => true),
      where: jest.fn(async ({ docId }) =>
        store.filter((r) => r.docId === docId)
      ),
    },
  };
});
jest.mock("../../../utils/knowledgeSync/marker", () => ({
  isSynced: jest.fn(async () => false),
}));
jest.mock("../../../utils/sparse/autostart", () => ({
  ensureSparseServer: jest.fn(async () => false),
  getLastStartReason: jest.fn(() => "unreachable"),
}));
jest.mock("../../../utils/rerankerClient", () => {
  const actual = jest.requireActual("../../../utils/rerankerClient");
  return {
    ...actual,
    loadRerankerConfig: jest.fn(() => ({
      ...actual.DEFAULTS,
      enabled: false,
      wide_candidate_count: 10,
      final_top_k: 5,
    })),
  };
});
jest.mock("../../../utils/helpers", () => ({
  ...jest.requireActual("../../../utils/helpers"),
  getEmbeddingEngineSelection: jest.fn(),
}));

const { getEmbeddingEngineSelection } = require("../../../utils/helpers");
const files = require("../../../utils/files");
const { DocumentVectors } = require("../../../models/vectors");
const autostart = require("../../../utils/sparse/autostart");
const sparseClient = require("../../../utils/sparse/client");
const { loadSparseConfig } = require("../../../utils/sparse/config");
const fake = require("../../__testhelpers__/fakeSparseServer");
const {
  LanceDb: LanceDbClass,
} = require("../../../utils/vectorDbProviders/lance");
const LanceDb = new LanceDbClass();

const vecOf = (text) => {
  const h = crypto.createHash("sha256").update(String(text)).digest();
  return Array.from({ length: DIM }, (_, i) => (h[i] + 1) / 256);
};
const embedder = {
  embeddingMaxChunkLength: 8000,
  embedChunks: jest.fn(async (texts) => texts.map(vecOf)),
};

const para = (c, n = 80) => `${c}`.repeat(n);
const doc3 = (a = "A", b = "B", c = "C") =>
  [para(a), para(b), para(c)].join("\n\n");

let server;
let sent; // bodies POSTed to /sparse/encode
let realFetch;
let nsCounter = 0;
const nextNs = () => `ns-${++nsCounter}`;

beforeAll(async () => {
  server = await fake.start({ maxChars: 1024 });
  process.env.SPARSE_BASE_PATH = `${server.url}/v1`;
  realFetch = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    if (String(url).endsWith("/sparse/encode")) {
      sent.push(...JSON.parse(init.body).input);
    }
    return realFetch(url, init);
  });
});
afterAll(async () => {
  global.fetch = realFetch;
  await server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  sent = [];
  settings.size = 100;
  settings.overlap = 0;
  server.setMode("ok");
  sparseClient._resetWarmState();
  getEmbeddingEngineSelection.mockReturnValue(embedder);
  embedder.embedChunks.mockClear();
  files.storeVectorResult.mockClear();
  files.cachedVectorInformation.mockReset();
  files.cachedVectorInformation.mockResolvedValue({
    exists: false,
    chunks: [],
  });
  DocumentVectors.bulkInsert.mockClear();
  DocumentVectors.delete.mockClear();
  autostart.ensureSparseServer.mockClear();
  autostart.ensureSparseServer.mockResolvedValue(false);
});

async function upload(ns, pageContent, extra = {}, fullPath = "/x/doc.json") {
  return LanceDb.addDocumentToNamespace(
    ns,
    { pageContent, docId: extra.docId || "doc-1", ...(extra.meta || {}) },
    fullPath,
    extra.skipCache ?? true
  );
}
const open = async (ns) => {
  const { client } = await LanceDb.connect();
  return client.openTable(ns);
};
const rowsOf = async (ns) => {
  const t = await open(ns);
  return t
    .query()
    .limit(await t.countRows())
    .toArray();
};
const typeOf = async (ns, name) =>
  String(
    (await (await open(ns)).schema()).fields.find((f) => f.name === name).type
  );
const legacyRow = (id, text, dim = DIM) => ({
  id,
  text,
  content_hash: crypto
    .createHash("sha256")
    .update(LanceDb.normalizeChunkForHash(text))
    .digest("hex"),
  source_document_id: "old-doc",
  source_filename: "unknown",
  workspace_id: "w",
  page_reference: 1,
  ocr_quality: "pass",
  block_type: "prose",
  upload_timestamp: "2026-01-01T00:00:00.000Z",
  vector: Array.from({ length: dim }, () => 0.1),
});

const fsx = require("fs");
const lanceDir = () => path.join(TMP, "lancedb");
const tables = async () => (await (await LanceDb.connect()).client).tableNames();
const idsOf = async (ns) => (await rowsOf(ns)).map((r) => r.id);

describe("removal paths leave no sparse data (IDX-04)", () => {
  test("delete doc: only the other document's rows remain", async () => {
    const ns = nextNs();
    await upload(ns, doc3("A", "B", "C"), { docId: "docA" });
    await upload(ns, doc3("D", "E", "F"), { docId: "docB" });
    const idsA = global.__dvStore
      .filter((r) => r.docId === "docA")
      .map((r) => r.vectorId);
    expect(idsA).toHaveLength(3);
    expect(await LanceDb.deleteDocumentFromNamespace(ns, "docA")).toBe(true);
    const ids = await idsOf(ns);
    expect(ids).toHaveLength(3);
    for (const id of idsA) expect(ids).not.toContain(id);
    const t = await open(ns);
    expect(await t.countRows("sparse_idx IS NOT NULL")).toBe(3);
  });

  test("drop workspace: table dir gone, status missing", async () => {
    const ns = nextNs();
    await upload(ns, doc3());
    expect(fsx.existsSync(path.join(lanceDir(), `${ns}.lance`))).toBe(true);
    await LanceDb["delete-namespace"]({ namespace: ns });
    expect(fsx.existsSync(path.join(lanceDir(), `${ns}.lance`))).toBe(false);
    expect(await LanceDb.sparseStatus(ns)).toBe("missing");
    expect(await tables()).not.toContain(ns);
  });

  test("reset-vector-db: delete then re-upload holds only new chunks", async () => {
    const ns = nextNs();
    await upload(ns, doc3("A", "B", "C"), { docId: "old" });
    await LanceDb["delete-namespace"]({ namespace: ns });
    await upload(ns, doc3("P", "Q", "R"), { docId: "new" });
    const rows = await rowsOf(ns);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !/^[ABC]+$/.test(String(r.text).trim()))).toBe(
      true
    );
    expect(await LanceDb.sparseStatus(ns)).toBe("ready");
  });

  test("LanceDb.reset removes the whole lancedb dir incl. sparse tables", async () => {
    const ns = nextNs();
    await upload(ns, doc3());
    expect(fsx.existsSync(lanceDir())).toBe(true);
    await LanceDb.reset();
    expect(fsx.existsSync(lanceDir())).toBe(false);
  });

  test("resetAllVectorStores (lance) removes every namespace and purges cache", async () => {
    const a = nextNs();
    const b = nextNs();
    await upload(a, doc3());
    await upload(b, doc3("M", "N", "O"));
    jest.resetModules();
    const purge = jest.fn();
    jest.doMock("../../../models/workspace", () => ({
      Workspace: { where: jest.fn(async () => [{ slug: a }, { slug: b }]) },
    }));
    jest.doMock("../../../models/documents", () => ({
      Document: { delete: jest.fn(async () => true) },
    }));
    jest.doMock("../../../models/eventLogs", () => ({
      EventLogs: { logEvent: jest.fn(async () => true) },
    }));
    jest.doMock("../../../utils/files", () => ({
      purgeEntireVectorCache: purge,
    }));
    jest.doMock("../../../utils/helpers", () => ({
      getVectorDbClass: () => LanceDb,
    }));
    const {
      resetAllVectorStores,
    } = require("../../../utils/vectorStore/resetAllVectorStores");
    expect(await resetAllVectorStores({ vectorDbKey: "lancedb" })).toBe(true);
    expect(purge).toHaveBeenCalled();
    const names = await tables();
    expect(names).not.toContain(a);
    expect(names).not.toContain(b);
    jest.dontMock("../../../models/workspace");
  });

  test("knowledge-sync wipe leaves no <slug>.lance directory", async () => {
    const slug = nextNs();
    await upload(slug, doc3());
    jest.resetModules();
    jest.doMock("../../../models/workspace", () => ({
      Workspace: { get: jest.fn(async () => ({ id: 9, slug })) },
    }));
    jest.doMock("../../../utils/prisma", () => ({
      $transaction: async (fn) =>
        fn({
          workspace_documents: {
            findMany: async () => [],
            deleteMany: async () => {},
          },
          document_vectors: { deleteMany: async () => {} },
        }),
    }));
    jest.doMock("../../../utils/knowledgeSync/marker", () => ({
      deleteMarker: jest.fn(async () => {}),
    }));
    jest.doMock("../../../utils/knowledgeSync/access", () => ({
      assertWorkspaceAccess: jest.fn(async () => {}),
    }));
    const {
      wipeWorkspace,
    } = require("../../../utils/knowledgeSync/wipe");
    await wipeWorkspace({ slug, userId: 1, multiUser: false });
    expect(fsx.existsSync(path.join(lanceDir(), `${slug}.lance`))).toBe(false);
  });

  test("vector-cache payload carries no sparse keys", async () => {
    const ns = nextNs();
    await upload(ns, doc3(), { skipCache: false });
    expect(files.storeVectorResult).toHaveBeenCalled();
    const serialized = JSON.stringify(
      files.storeVectorResult.mock.calls.map((c) => c[0])
    );
    expect(serialized).not.toMatch(/sparse_idx|sparse_val/);
  });

  test("crash-window staging: delete-namespace removes stage table + marker; re-upload not promoted", async () => {
    const ns = nextNs();
    const stage = `${ns}__sparse_stage`;
    const { client } = await LanceDb.connect();
    await client.createTable(stage, [legacyRow("stale", "stale row")]);
    const markerFile = path.join(lanceDir(), `${stage}.json`);
    fsx.writeFileSync(markerFile, "{}");
    await expect(LanceDb["delete-namespace"]({ namespace: ns })).rejects.toThrow(
      /does not exist/
    );
    expect(await tables()).not.toContain(stage);
    expect(fsx.existsSync(markerFile)).toBe(false);
    await upload(ns, doc3());
    const rows = await rowsOf(ns);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).not.toContain("stale");
  });

  test("crash-window staging with existing table: drop removes both", async () => {
    const ns = nextNs();
    await upload(ns, doc3());
    const stage = `${ns}__sparse_stage`;
    const { client } = await LanceDb.connect();
    await client.createTable(stage, [legacyRow("stale", "stale row")]);
    const markerFile = path.join(lanceDir(), `${stage}.json`);
    fsx.writeFileSync(markerFile, "{}");
    await LanceDb["delete-namespace"]({ namespace: ns });
    expect(await tables()).not.toContain(stage);
    expect(await tables()).not.toContain(ns);
    expect(fsx.existsSync(markerFile)).toBe(false);
  });

  test("wipe removes staging table dir and marker", async () => {
    const slug = nextNs();
    const stage = `${slug}__sparse_stage`;
    const { client } = await LanceDb.connect();
    await client.createTable(stage, [legacyRow("stale", "stale row")]);
    const markerFile = path.join(lanceDir(), `${stage}.json`);
    fsx.writeFileSync(markerFile, "{}");
    jest.resetModules();
    jest.doMock("../../../models/workspace", () => ({
      Workspace: { get: jest.fn(async () => ({ id: 9, slug })) },
    }));
    jest.doMock("../../../utils/prisma", () => ({
      $transaction: async (fn) =>
        fn({
          workspace_documents: {
            findMany: async () => [],
            deleteMany: async () => {},
          },
        }),
    }));
    jest.doMock("../../../utils/knowledgeSync/marker", () => ({
      deleteMarker: jest.fn(async () => {}),
    }));
    jest.doMock("../../../utils/knowledgeSync/access", () => ({
      assertWorkspaceAccess: jest.fn(async () => {}),
    }));
    const {
      wipeWorkspace,
    } = require("../../../utils/knowledgeSync/wipe");
    await wipeWorkspace({ slug, userId: 1, multiUser: false });
    expect(fsx.existsSync(path.join(lanceDir(), `${stage}.lance`))).toBe(false);
    expect(fsx.existsSync(markerFile)).toBe(false);
  });

  test("dropTable failure surfaces as error (not swallowed by provider)", async () => {
    const ns = nextNs();
    await upload(ns, doc3());
    const orig = LanceDb.deleteVectorsInNamespace;
    LanceDb.deleteVectorsInNamespace = jest.fn(async () => {
      throw new Error("drop failed");
    });
    await expect(LanceDb["delete-namespace"]({ namespace: ns })).rejects.toThrow(
      "drop failed"
    );
    LanceDb.deleteVectorsInNamespace = orig;
    expect(await tables()).toContain(ns);
    await LanceDb["delete-namespace"]({ namespace: ns });
  });
});
