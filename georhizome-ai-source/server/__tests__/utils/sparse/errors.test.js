const fs = require("fs");
const {
  SparseError,
  toClientError,
  SPARSE_CODES,
} = require("../../../utils/sparse/errors");
const {
  CONFIG_PATHS,
  loadSparseConfig,
  resolveBaseUrl,
  resolveHubUrl,
} = require("../../../utils/sparse/config");

describe("SparseError", () => {
  test("UNAVAILABLE is bilingual with port", () => {
    const e = new SparseError("SPARSE_E_UNAVAILABLE", { port: 8004 });
    expect(e.code).toBe("SPARSE_E_UNAVAILABLE");
    expect(e.message).toContain("ポート8004");
    expect(e.message).toContain("port 8004");
    expect(e.message.indexOf(e.ja)).toBe(0);
  });
  test("unknown code maps to UNKNOWN", () => {
    expect(new SparseError("nope").code).toBe("SPARSE_E_UNKNOWN");
  });
  test("all codes have ja and en", () => {
    for (const c of SPARSE_CODES) {
      const e = new SparseError(c, { port: 1 });
      expect(e.ja.length).toBeGreaterThan(0);
      expect(e.en.length).toBeGreaterThan(0);
    }
  });
  test("toClientError shape", () => {
    const r = toClientError(new SparseError("SPARSE_E_BUSY"));
    expect(Object.keys(r).sort()).toEqual(["code", "en", "ja", "message"]);
    expect(toClientError(new Error("x")).code).toBe("SPARSE_E_UNKNOWN");
  });
});

describe("sparse config", () => {
  const OLD = process.env.SPARSE_BASE_PATH;
  afterEach(() => {
    if (OLD === undefined) delete process.env.SPARSE_BASE_PATH;
    else process.env.SPARSE_BASE_PATH = OLD;
  });
  test("host config path exists", () => {
    expect(fs.existsSync(CONFIG_PATHS[1])).toBe(true);
  });
  test("loadSparseConfig coerces numerics", () => {
    const c = loadSparseConfig();
    expect(typeof c.port).toBe("number");
    expect(c.max_inputs_per_request).toBeGreaterThanOrEqual(1);
  });
  test("resolveBaseUrl env then host.docker.internal", () => {
    delete process.env.SPARSE_BASE_PATH;
    expect(resolveBaseUrl({ port: 8004 })).toBe(
      "http://host.docker.internal:8004/v1"
    );
    process.env.SPARSE_BASE_PATH = "http://x:1/v1/";
    expect(resolveBaseUrl({ port: 8004 })).toBe("http://x:1/v1");
    expect(resolveHubUrl()).toMatch(/^http/);
  });
});
