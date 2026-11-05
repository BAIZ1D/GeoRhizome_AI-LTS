const fs = require("fs");
const { loadHybridConfig, DEFAULTS } = require("../../../utils/hybrid/config");

function mockFile(obj) {
  jest.spyOn(fs, "existsSync").mockReturnValue(obj !== null);
  jest.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(obj));
}

afterEach(() => jest.restoreAllMocks());

describe("loadHybridConfig", () => {
  test("no file -> defaults", () => {
    mockFile(null);
    expect(loadHybridConfig()).toEqual({ ...DEFAULTS });
  });
  test("empty hybrid section -> defaults", () => {
    mockFile({ hybrid: {} });
    expect(loadHybridConfig()).toEqual({ ...DEFAULTS });
  });
  test("enabled strictly true", () => {
    mockFile({ hybrid: { enabled: "true" } });
    expect(loadHybridConfig().enabled).toBe(false);
    mockFile({ hybrid: { enabled: true } });
    expect(loadHybridConfig().enabled).toBe(true);
  });
  test("invalid numerics fall back", () => {
    mockFile({
      hybrid: {
        rrf_k: "x",
        dense_top_n: -1,
        sparse_top_n: 0,
        leg_timeout_ms: null,
      },
    });
    const c = loadHybridConfig();
    expect(c.rrf_k).toBe(60);
    expect(c.dense_top_n).toBe(50);
    expect(c.sparse_top_n).toBe(50);
    expect(c.leg_timeout_ms).toBe(3000);
  });
  test("valid values returned", () => {
    mockFile({ hybrid: { rrf_k: 10, sparse_query_timeout_ms: 500 } });
    const c = loadHybridConfig();
    expect(c.rrf_k).toBe(10);
    expect(c.sparse_query_timeout_ms).toBe(500);
  });
});
