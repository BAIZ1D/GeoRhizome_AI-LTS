const {
  logRetrieval,
  rerankerReason,
  PATHS,
  REASONS,
} = require("../../../utils/hybrid/log");

afterEach(() => jest.restoreAllMocks());

describe("logRetrieval", () => {
  test("one line with path and reason, no query text", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    logRetrieval({
      namespace: "ws1",
      retrievalPath: PATHS.HYBRID_RRF,
      reason: REASONS.OK,
      dense: 5,
      sparse: 4,
      fused: 7,
      ms: 12,
      query: "SECRET-QUERY",
      text: "CHUNK-TEXT",
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = spy.mock.calls[0][0];
    expect(line.startsWith("[Retrieval]")).toBe(true);
    expect(line).toContain("retrievalPath=hybrid_rrf");
    expect(line).toContain("reason=ok");
    expect(line).not.toContain("SECRET-QUERY");
    expect(line).not.toContain("CHUNK-TEXT");
  });
  test("unknown path coerced, never throws", () => {
    const spy = jest.spyOn(console, "log").mockImplementation(() => {});
    expect(() =>
      logRetrieval({ retrievalPath: "bogus", reason: "x" })
    ).not.toThrow();
    const line = spy.mock.calls[0][0];
    expect(line).toContain("retrievalPath=dense_only");
    expect(line).toContain("reason=invalid_path_x");
  });
  test("rerankerReason sanitizes", () => {
    expect(rerankerReason("Timed Out")).toBe("reranker_timed_out");
  });
});
