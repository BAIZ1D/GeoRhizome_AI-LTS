/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lance-sparse-"));
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
jest.mock("../../../models/vectors", () => ({
  DocumentVectors: {
    bulkInsert: jest.fn(async () => {}),
    delete: jest.fn(async () => true),
    where: jest.fn(async () => []),
  },
}));
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

describe("lance sparse write path", () => {
  test("one add: dense+sparse for every chunk, ids match DocumentVectors, typed schema", async () => {
    const ns = nextNs();
    const spy = jest.spyOn(LanceDb, "updateOrCreateCollection");
    const res = await upload(ns, doc3());
    expect(res).toEqual({ vectorized: true, error: null });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toHaveLength(3);
    spy.mockRestore();

    const rows = await rowsOf(ns);
    expect(rows).toHaveLength(3);
    rows.forEach((r) => {
      expect(r.sparse_idx).toBeTruthy();
      expect(r.sparse_val).toBeTruthy();
    });
    const linked = DocumentVectors.bulkInsert.mock.calls[0][0].map(
      (d) => d.vectorId
    );
    expect(rows.map((r) => r.id).sort()).toEqual([...linked].sort());
    expect(await typeOf(ns, "sparse_idx")).toMatch(/List<Uint16>/);
    expect(await typeOf(ns, "sparse_val")).toMatch(/List<Float32>/);

    await upload(ns, doc3("D", "E", "F"), { docId: "doc-2" });
    expect(await typeOf(ns, "sparse_idx")).toMatch(/List<Uint16>/);
    expect(await typeOf(ns, "sparse_val")).toMatch(/List<Float32>/);
    expect(files.storeVectorResult).toHaveBeenCalledTimes(2);
  });

  test("body only: sparse input has no <document_metadata>, stored text does", async () => {
    const ns = nextNs();
    await upload(ns, doc3(), { meta: { title: "Policy Doc" } });
    expect(sent.length).toBe(3);
    sent.forEach((s) => expect(s).not.toContain("<document_metadata>"));
    const rows = await rowsOf(ns);
    rows.forEach((r) => expect(r.text).toContain("<document_metadata>"));
  });

  test("unavailable: nothing written, bilingual error", async () => {
    const ns = nextNs();
    await upload(ns, doc3());
    const before = (await open(ns)).countRows();
    const beforeRows = await before;
    const bulkBefore = DocumentVectors.bulkInsert.mock.calls.length;
    const storeBefore = files.storeVectorResult.mock.calls.length;

    await server.close();
    const dead = await fake.start({ port: 0 });
    const deadUrl = dead.url;
    await dead.close();
    process.env.SPARSE_BASE_PATH = `${deadUrl}/v1`;
    try {
      const res = await upload(ns, doc3("X", "Y", "Z"), { docId: "doc-9" });
      expect(res.vectorized).toBe(false);
      expect(res.error).toContain("スパース");
      expect(res.error).toContain("sparse search server");
      expect((await open(ns)).countRows()).resolves.toBe(beforeRows);
      expect(DocumentVectors.bulkInsert.mock.calls.length).toBe(bulkBefore);
      expect(files.storeVectorResult.mock.calls.length).toBe(storeBefore);

      // fresh namespace: table must not be created
      const fresh = nextNs();
      const r2 = await upload(fresh, doc3("Q", "R", "S"));
      expect(r2.vectorized).toBe(false);
      const { client } = await LanceDb.connect();
      expect(await client.tableNames()).not.toContain(fresh);

      // fail fast: hub called once only across both attempts
      expect(autostart.ensureSparseServer).toHaveBeenCalledTimes(1);
    } finally {
      server = await fake.start({ maxChars: 1024 });
      process.env.SPARSE_BASE_PATH = `${server.url}/v1`;
    }
  });

  test("hybrid off / sparse.enabled false: upload still encodes sparse (D3)", async () => {
    expect(loadSparseConfig().enabled).toBe(false);
    const ns = nextNs();
    const res = await upload(ns, doc3());
    expect(res.vectorized).toBe(true);
    expect(sent.length).toBe(3);
  });

  test("dedupe complete: identical chunks skipped, only new chunk encoded", async () => {
    const ns = nextNs();
    await upload(ns, doc3("A", "B", "C"));
    sent = [];
    await upload(ns, doc3("A", "B", "D"), { docId: "doc-2" });
    expect(sent).toHaveLength(1);
    expect(await (await open(ns)).countRows()).toBe(4);
  });

  test("dedupe re-upload: same body with a new published header is skipped", async () => {
    const ns = nextNs();
    const meta = (published) => ({ title: "doc1.txt", published });
    await upload(ns, doc3("A", "B", "C"), { meta: meta("11/5/2026, 9:36:10 AM") });
    const before = await (await open(ns)).countRows();
    sent = [];
    await upload(ns, doc3("A", "B", "C"), {
      docId: "doc-2",
      meta: meta("11/5/2026, 9:36:43 AM"),
    });
    expect(sent).toHaveLength(0);
    expect(await (await open(ns)).countRows()).toBe(before);
  });

  test("dedupe dense-only: stale row replaced by dense+sparse row, old id deleted", async () => {
    const ns = nextNs();
    const { client } = await LanceDb.connect();
    await client.createTable(ns, [legacyRow("old-B", para("B"))]);
    const res = await upload(ns, doc3("A", "B", "C"), { docId: "doc-new" });
    expect(res.vectorized).toBe(true);
    const rows = await rowsOf(ns);
    expect(rows.find((r) => r.id === "old-B")).toBeUndefined();
    const hashB = legacyRow("x", para("B")).content_hash;
    const withB = rows.filter((r) => r.content_hash === hashB);
    expect(withB).toHaveLength(1);
    expect(withB[0].sparse_idx).toBeTruthy();
    expect(rows).toHaveLength(3);
    expect(DocumentVectors.delete).toHaveBeenCalledWith({
      vectorId: { in: ["old-B"] },
    });
  });

  test("legacy upgrade: >10 dense-only rows keep null sparse, schema typed", async () => {
    const ns = nextNs();
    const { client } = await LanceDb.connect();
    await client.createTable(
      ns,
      Array.from({ length: 12 }, (_, i) =>
        legacyRow(`old-${i}`, `legacy chunk number ${i} ${"z".repeat(i + 1)}`)
      )
    );
    const res = await upload(ns, doc3());
    expect(res.vectorized).toBe(true);
    const t = await open(ns);
    expect(await t.countRows()).toBe(15);
    expect(await t.countRows("sparse_idx IS NULL")).toBe(12);
    expect(await t.countRows("sparse_idx IS NOT NULL")).toBe(3);
    expect(await typeOf(ns, "sparse_idx")).toMatch(/List<Uint16>/);
    expect(await typeOf(ns, "sparse_val")).toMatch(/List<Float32>/);
  });

  test("no sparse in sources: search outputs and curateSources strip sparse keys", async () => {
    const ns = nextNs();
    await upload(ns, doc3());
    const { client } = await LanceDb.connect();
    const qv = vecOf("query");
    const a = await LanceDb.similarityResponse({
      client,
      namespace: ns,
      queryVector: qv,
      similarityThreshold: -1,
      topN: 3,
    });
    const b = await LanceDb.rerankedSimilarityResponse({
      client,
      namespace: ns,
      query: "q",
      queryVector: qv,
      similarityThreshold: -1,
      topN: 3,
    });
    for (const r of [a, b]) {
      expect(r.sourceDocuments.length).toBeGreaterThan(0);
      r.sourceDocuments.forEach((s) => {
        expect(s).not.toHaveProperty("sparse_idx");
        expect(s).not.toHaveProperty("sparse_val");
      });
    }
    const cur = LanceDb.curateSources([
      { metadata: { id: "1", sparse_idx: [1], sparse_val: [1], text: "t" } },
      { id: "2", sparse_idx: [1], sparse_val: [1], text: "t" },
    ]);
    cur.forEach((s) => {
      expect(s).not.toHaveProperty("sparse_idx");
      expect(s).not.toHaveProperty("sparse_val");
    });
  });

  test("clamp: splitter chunk size and bodies never exceed sparse.max_input_chars", async () => {
    const max = loadSparseConfig().max_input_chars;
    settings.size = 5000;
    const ns = nextNs();
    const words = Array.from({ length: 800 }, (_, i) => `w${i}`).join(" ");
    const res = await upload(ns, words);
    expect(res.vectorized).toBe(true);
    expect(sent.length).toBeGreaterThan(1);
    sent.forEach((s) => expect([...s].length).toBeLessThanOrEqual(max));
  });

  test("fail fast: second document after failed auto-start does not call hub again", async () => {
    const dead = await fake.start({});
    const deadUrl = dead.url;
    await dead.close();
    const prev = process.env.SPARSE_BASE_PATH;
    process.env.SPARSE_BASE_PATH = `${deadUrl}/v1`;
    try {
      const t0 = Date.now();
      const r1 = await upload(nextNs(), doc3());
      const r2 = await upload(nextNs(), doc3("K", "L", "M"));
      expect(r1.vectorized).toBe(false);
      expect(r2.error).toBe(r1.error);
      expect(autostart.ensureSparseServer).toHaveBeenCalledTimes(1);
      expect(Date.now() - t0).toBeLessThan(5000);
    } finally {
      process.env.SPARSE_BASE_PATH = prev;
    }
  });

  test("real cache is dead: skipCache=false with real cachedVectorInformation still embeds fresh", async () => {
    const actual = jest.requireActual("../../../utils/files");
    files.cachedVectorInformation.mockImplementation(
      actual.cachedVectorInformation
    );
    const ns = nextNs();
    const res = await upload(ns, doc3(), { skipCache: false });
    expect(res.vectorized).toBe(true);
    expect(embedder.embedChunks).toHaveBeenCalled();
    const rows = await rowsOf(ns);
    expect(rows).toHaveLength(3);
    rows.forEach((r) => expect(r.sparse_idx).toBeTruthy());
  });

  test("cache branch (unit only): re-encodes from stored body; records without body fall through", async () => {
    const rec = (i, withBody) => ({
      id: `c${i}`,
      values: vecOf(`c${i}`),
      metadata: { text: `cached text ${i}`, content_hash: `h${i}` },
      ...(withBody ? { body: `cached body ${i}` } : {}),
    });
    files.cachedVectorInformation.mockResolvedValue({
      exists: true,
      chunks: [[rec(1, true), rec(2, true)]],
    });
    const ns = nextNs();
    const res = await upload(ns, doc3(), { skipCache: false });
    expect(res.vectorized).toBe(true);
    expect(sent).toEqual(["cached body 1", "cached body 2"]);
    expect(embedder.embedChunks).not.toHaveBeenCalled();
    const rows = await rowsOf(ns);
    expect(rows).toHaveLength(2);
    rows.forEach((r) => expect(r.sparse_idx).toBeTruthy());

    sent = [];
    files.cachedVectorInformation.mockResolvedValue({
      exists: true,
      chunks: [[rec(3, true), rec(4, false)]],
    });
    const ns2 = nextNs();
    const res2 = await upload(ns2, doc3(), { skipCache: false });
    expect(res2.vectorized).toBe(true);
    expect(embedder.embedChunks).toHaveBeenCalled();
    expect(await (await open(ns2)).countRows()).toBe(3);
  });
});
