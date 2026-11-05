/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "lance-hybrid-"));
process.env.STORAGE_DIR = TMP;

const DIM = 8;
const G = (global.__hyb = {
  sparseEnabled: true,
  statusOverride: null,
  hybridCfg: null,
});

jest.mock("../../../utils/files", () => ({
  storeVectorResult: jest.fn(async () => {}),
  cachedVectorInformation: jest.fn(async () => ({ exists: false, chunks: [] })),
}));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    getValueOrFallback: jest.fn(async ({ label }) =>
      label === "text_splitter_chunk_size" ? 100 : 0
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
jest.mock("../../../utils/sparse/config", () => {
  const actual = jest.requireActual("../../../utils/sparse/config");
  return {
    ...actual,
    loadSparseConfig: jest.fn(() => ({
      ...actual.loadSparseConfig(),
      enabled: global.__hyb.sparseEnabled,
    })),
  };
});
jest.mock("../../../utils/sparse/status", () => {
  const actual = jest.requireActual("../../../utils/sparse/status");
  return {
    sparseStatus: jest.fn(async (t) =>
      global.__hyb.statusOverride
        ? global.__hyb.statusOverride
        : actual.sparseStatus(t)
    ),
  };
});
jest.mock("../../../utils/hybrid/config", () => ({
  loadHybridConfig: jest.fn(() => global.__hyb.hybridCfg),
}));
jest.mock("../../../utils/hybrid/queryEncoder", () => ({
  encodeQuery: jest.fn(),
}));
jest.mock("../../../utils/hybrid/sparseScan", () => ({
  scoreTable: jest.fn(),
}));
jest.mock("../../../utils/rerankerClient", () => {
  const actual = jest.requireActual("../../../utils/rerankerClient");
  return {
    ...actual,
    loadRerankerConfig: jest.fn(() => ({
      ...actual.DEFAULTS,
      enabled: true,
      wide_candidate_count: 4,
      final_top_k: 2,
      min_reranker_score: 5,
    })),
    rerank: jest.fn(),
  };
});
jest.mock("../../../utils/helpers", () => ({
  ...jest.requireActual("../../../utils/helpers"),
  getEmbeddingEngineSelection: jest.fn(),
}));

const { getEmbeddingEngineSelection } = require("../../../utils/helpers");
const fake = require("../../__testhelpers__/fakeSparseServer");
const sparseClient = require("../../../utils/sparse/client");
const rerankerClient = require("../../../utils/rerankerClient");
const { encodeQuery } = require("../../../utils/hybrid/queryEncoder");
const { scoreTable } = require("../../../utils/hybrid/sparseScan");
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
  embedTextInput: jest.fn(async (t) => vecOf(t)),
};
const para = (c, n = 80) => `${c}`.repeat(n);

let server;
let realFetch;
let ns;
let rows;
let logSpy;
const cfgOf = (o = {}) => ({
  enabled: true,
  rrf_k: 60,
  dense_top_n: 50,
  sparse_top_n: 50,
  leg_timeout_ms: 400,
  sparse_query_timeout_ms: 400,
  ...o,
});
const retrievalLines = () =>
  logSpy.mock.calls
    .map((c) => String(c[0]))
    .filter((l) => l.startsWith("[Retrieval]"));

beforeAll(async () => {
  server = await fake.start({ maxChars: 1024 });
  process.env.SPARSE_BASE_PATH = `${server.url}/v1`;
  realFetch = global.fetch;
  getEmbeddingEngineSelection.mockReturnValue(embedder);
  ns = "hyb-ns";
  const res = await LanceDb.addDocumentToNamespace(
    ns,
    {
      pageContent: [para("A"), para("B"), para("C"), para("D")].join("\n\n"),
      docId: "doc-1",
    },
    "/x/doc.json",
    true
  );
  expect(res.vectorized).toBe(true);
  const { client } = await LanceDb.connect();
  const t = await client.openTable(ns);
  rows = await t.query().limit(await t.countRows()).toArray();
}, 20000);
afterAll(async () => {
  global.fetch = realFetch;
  await server.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  G.sparseEnabled = true;
  G.statusOverride = null;
  G.hybridCfg = cfgOf();
  sparseClient._resetWarmState();
  encodeQuery.mockReset();
  scoreTable.mockReset();
  rerankerClient.rerank.mockReset();
  encodeQuery.mockResolvedValue({
    vec: { indices: [1], values: [1] },
    reason: null,
  });
  scoreTable.mockImplementation(async () =>
    rows.map((r, i) => ({ id: r.id, score: 10 - i }))
  );
  rerankerClient.rerank.mockImplementation(async ({ candidates }) => ({
    results: candidates.map((c, i) => ({ id: c.id, score: 10 - i })),
    reason: null,
  }));
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

const search = (extra = {}) =>
  LanceDb.performSimilaritySearch({
    namespace: ns,
    input: "query",
    LLMConnector: {},
    similarityThreshold: 0.25,
    topN: 4,
    hybrid: true,
    ...extra,
  });
const lastLine = () => retrievalLines()[0] || "";

describe("lance hybrid retrieval", () => {
  jest.setTimeout(20000);

  test("gating hybrid_rerank: candidates only, capped", async () => {
    const res = await search();
    expect(lastLine()).toMatch(/retrievalPath=hybrid_rerank/);
    const arg = rerankerClient.rerank.mock.calls[0][0];
    expect(arg.candidates).toBeDefined();
    expect(arg.documents).toBeUndefined();
    expect(arg.candidates.length).toBeLessThanOrEqual(4);
    expect(res.contextTexts.length).toBeLessThanOrEqual(2);
    expect(retrievalLines()).toHaveLength(1);
  });

  test("reranker null -> hybrid_rrf, low RRF scores survive thresholds", async () => {
    rerankerClient.rerank.mockResolvedValue({
      results: null,
      reason: "timeout",
    });
    const res = await search({ similarityThreshold: 0.25 });
    expect(lastLine()).toMatch(/retrievalPath=hybrid_rrf/);
    expect(lastLine()).toMatch(/reason=reranker_timeout/);
    expect(res.sources.length).toBeGreaterThan(0);
    const m = res.sources[0];
    expect(m.scoreType).toBe("rrf");
    expect(m.score).toBeLessThan(0.05);
    expect(retrievalLines()).toHaveLength(1);
  });

  test("sparse_unavailable -> dense path", async () => {
    encodeQuery.mockResolvedValue({ vec: null, reason: "sparse_unavailable" });
    await search();
    expect(lastLine()).toMatch(/retrievalPath=dense_(rerank|only)/);
    expect(lastLine()).toMatch(/reason=sparse_unavailable/);
    expect(retrievalLines()).toHaveLength(1);
  });

  test("sparse_timeout when sparse leg is slow", async () => {
    G.hybridCfg = cfgOf({ leg_timeout_ms: 150 });
    encodeQuery.mockImplementation(
      () =>
        new Promise((r) =>
          setTimeout(() => r({ vec: { indices: [1], values: [1] } }), 3000)
        )
    );
    const t0 = Date.now();
    await search();
    expect(Date.now() - t0).toBeLessThan(150 + 1000);
    expect(lastLine()).toMatch(/reason=sparse_timeout/);
    expect(lastLine()).toMatch(/retrievalPath=dense_/);
  });

  test.each([
    ["partial", "sparse_partial"],
    ["missing", "sparse_missing"],
  ])("status %s -> dense, no scan", async (status, reason) => {
    G.statusOverride = status;
    await search();
    expect(lastLine()).toMatch(new RegExp(`reason=${reason}`));
    expect(lastLine()).toMatch(/retrievalPath=dense_/);
    expect(scoreTable).not.toHaveBeenCalled();
  });

  test("hybrid disabled workspace / global / sparse", async () => {
    await search({ hybrid: false });
    expect(lastLine()).toMatch(/reason=hybrid_disabled_workspace/);
    logSpy.mockClear();
    G.hybridCfg = cfgOf({ enabled: false });
    await search({ hybrid: null });
    expect(lastLine()).toMatch(/reason=hybrid_disabled_global/);
    logSpy.mockClear();
    G.sparseEnabled = false;
    await search({ hybrid: true });
    expect(lastLine()).toMatch(/reason=sparse_disabled/);
    expect(retrievalLines()).toHaveLength(1);
  });

  test("sparse-only row is hydrated, no vector/sparse keys (HYB-06)", async () => {
    G.hybridCfg = cfgOf({ dense_top_n: 1 });
    const target = rows[3];
    scoreTable.mockResolvedValue([{ id: target.id, score: 9 }]);
    rerankerClient.rerank.mockResolvedValue({ results: null, reason: "x" });
    const res = await search();
    const hit = res.sources.find((s) => s.id === target.id);
    expect(hit).toBeDefined();
    expect(hit.text).toBe(target.text);
    expect(hit.vector).toBeUndefined();
    expect(hit.sparse_idx).toBeUndefined();
    expect(hit.sparse_val).toBeUndefined();
  });

  test("scoreTable throw -> hybrid_error dense; syncing propagates", async () => {
    scoreTable.mockRejectedValue(new Error("boom"));
    await search();
    expect(lastLine()).toMatch(/reason=hybrid_error/);
    expect(lastLine()).toMatch(/retrievalPath=dense_/);
    expect(retrievalLines()).toHaveLength(1);

    const locks = require("../../../utils/knowledgeSync/locks");
    const spy = jest
      .spyOn(locks, "assertNotSyncing")
      .mockImplementation(() => {
        const e = new Error("syncing");
        e.code = "KS_E_SYNCING";
        throw e;
      });
    await expect(search()).rejects.toMatchObject({ code: "KS_E_SYNCING" });
    spy.mockRestore();
  });
});
