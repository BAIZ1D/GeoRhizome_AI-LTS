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

describe("LanceDb.sparseStatus + counts (IDX-05)", () => {
  test("missing table -> missing", async () => {
    expect(await LanceDb.sparseStatus("nope")).toBe("missing");
  });

  test("fresh upload -> ready; counts equal chunks, not doubled", async () => {
    const ns = nextNs();
    await upload(ns, doc3());
    expect(await LanceDb.sparseStatus(ns)).toBe("ready");
    expect(await LanceDb.namespaceCount(ns)).toBe(3);
    expect((await open(ns)).countRows).toBeDefined();
    expect(await LanceDb.totalVectors()).toBeGreaterThanOrEqual(3);
  });

  test("legacy dense-only -> missing; after one upload -> partial", async () => {
    const ns = nextNs();
    const { client } = await LanceDb.connect();
    await client.createTable(ns, [
      legacyRow("l1", "legacy one"),
      legacyRow("l2", "legacy two"),
    ]);
    expect(await LanceDb.sparseStatus(ns)).toBe("missing");
    await upload(ns, doc3("X", "Y", "Z"), { docId: "d-new" });
    expect(await LanceDb.sparseStatus(ns)).toBe("partial");
    expect(await LanceDb.namespaceCount(ns)).toBe(5);
  });
});
