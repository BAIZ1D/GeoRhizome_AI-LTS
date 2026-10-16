/* eslint-env jest */
process.env.STORAGE_DIR = process.env.STORAGE_DIR || require("os").tmpdir();
jest.mock("../../../../utils/files", () => ({}));
jest.mock("../../../../models/systemSettings", () => ({ SystemSettings: {} }));
jest.mock("../../../../utils/rerankerClient", () => {
  const actual = jest.requireActual("../../../../utils/rerankerClient");
  return { ...actual, loadRerankerConfig: jest.fn(), rerank: jest.fn() };
});

const rerankerClient = require("../../../../utils/rerankerClient");
const { LanceDb: LanceDbClass } = require("../../../../utils/vectorDbProviders/lance");
const LanceDb = new LanceDbClass();

const CFG = {
  ...rerankerClient.DEFAULTS,
  enabled: true,
  wide_candidate_count: 6,
  final_top_k: 3,
  min_reranker_score: -1.6,
};

// Stage 1 rows in cosine order (distance ascending).
const ROWS = [0, 1, 2, 3, 4, 5].map((i) => ({
  id: `row-${i}`,
  text: `chunk ${i}`,
  title: `doc${i}.pdf`,
  published: "2026-01-01",
  vector: [0.1, 0.2],
  _distance: 0.1 + i * 0.05,
}));

function fakeClient(rows = ROWS) {
  const limit = jest.fn(() => ({ toArray: async () => rows }));
  const query = { distanceType: () => ({ limit }) };
  return {
    limit,
    client: {
      openTable: async () => ({ vectorSearch: () => query }),
    },
  };
}

function run(extra = {}) {
  const { client, limit } = fakeClient();
  return {
    limit,
    promise: LanceDb.rerankedSimilarityResponse({
      client,
      namespace: "ws",
      query: "what is x",
      queryVector: [0.1, 0.2],
      topN: 4,
      similarityThreshold: 0.25,
      ...extra,
    }),
  };
}

describe("LanceDb.rerankedSimilarityResponse (Stage 2 wiring)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    rerankerClient.loadRerankerConfig.mockReturnValue({ ...CFG });
  });

  it("RET-01: reranks even when rerank=false (vectorSearchMode ignored)", async () => {
    rerankerClient.rerank.mockResolvedValue({ results: [], reason: null });
    await run({ rerank: false }).promise;
    await run({ rerank: true }).promise;
    expect(rerankerClient.rerank).toHaveBeenCalledTimes(2);
  });

  it("RET-01: skips Stage 2 only when app_config reranker.enabled is false", async () => {
    rerankerClient.loadRerankerConfig.mockReturnValue({ ...CFG, enabled: false });
    const out = await run({ rerank: true }).promise;
    expect(rerankerClient.rerank).not.toHaveBeenCalled();
    expect(out.contextTexts).toEqual(["chunk 0", "chunk 1", "chunk 2"]);
  });

  it("RET-02: uses wide_candidate_count for Stage 1 and sends slim candidates", async () => {
    rerankerClient.rerank.mockResolvedValue({ results: [], reason: null });
    const { limit, promise } = run();
    await promise;
    expect(limit).toHaveBeenCalledWith(6);
    const { candidates } = rerankerClient.rerank.mock.calls[0][0];
    expect(candidates).toHaveLength(6);
    expect(Object.keys(candidates[0]).sort()).toEqual(["id", "text"]);
  });

  it("RET-02/RET-07: filters by min_reranker_score, keeps final_top_k in reranked order; context and sources match", async () => {
    rerankerClient.rerank.mockResolvedValue({
      reason: null,
      results: [
        { id: "4", score: 3.1 },
        { id: "2", score: 2.5 },
        { id: "5", score: 0.4 },
        { id: "0", score: -0.9 },
        { id: "1", score: -2.0 },
      ],
    });
    const out = await run().promise;
    expect(out.contextTexts).toEqual(["chunk 4", "chunk 2", "chunk 5"]);
    expect(out.sourceDocuments.map((d) => d.text)).toEqual(out.contextTexts);
    expect(out.sourceDocuments.map((d) => d.id)).toEqual(["row-4", "row-2", "row-5"]);
    expect(out.scores).toEqual([3.1, 2.5, 0.4]);
    expect(out.sourceDocuments[0].vector).toBeUndefined();

    // performSimilaritySearch builds citations with curateSources from the same list.
    const sources = LanceDb.curateSources(
      out.sourceDocuments.map((m, i) => ({ metadata: { ...m, text: out.contextTexts[i] } }))
    );
    expect(sources.map((s) => s.text)).toEqual(out.contextTexts);
  });

  it("RET-02: final_top_k falls back to workspace topN when unset", async () => {
    rerankerClient.loadRerankerConfig.mockReturnValue({ ...CFG, final_top_k: null });
    rerankerClient.rerank.mockResolvedValue({
      reason: null,
      results: [5, 4, 3, 2, 1, 0].map((i) => ({ id: String(i), score: 1 })),
    });
    const out = await run({ topN: 2 }).promise;
    expect(out.contextTexts).toEqual(["chunk 5", "chunk 4"]);
  });

  it("drops pinned documents before slicing to final_top_k", async () => {
    rerankerClient.rerank.mockResolvedValue({
      reason: null,
      results: [4, 3, 2, 1].map((i) => ({ id: String(i), score: 2 })),
    });
    const { sourceIdentifier } = require("../../../../utils/chats");
    const pinned = sourceIdentifier(ROWS[4]);
    const out = await run({ filterIdentifiers: [pinned] }).promise;
    expect(out.contextTexts).toEqual(["chunk 3", "chunk 2", "chunk 1"]);
  });

  it("RET-04: falls back to Stage-1 cosine order with cosine scores (no mixing)", async () => {
    rerankerClient.rerank.mockResolvedValue({ results: null, reason: "timeout after 12000ms" });
    const out = await run().promise;
    expect(out.contextTexts).toEqual(["chunk 0", "chunk 1", "chunk 2"]);
    out.scores.forEach((s) => {
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThanOrEqual(1);
    });
  });
});
