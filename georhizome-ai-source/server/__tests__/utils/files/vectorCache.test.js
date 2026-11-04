const fs = require("fs");
const os = require("os");
const path = require("path");
const { v5: uuidv5 } = require("uuid");

jest.mock("../../../models/documents", () => ({ Document: {} }));
jest.mock("../../../models/documentSyncQueue", () => ({
  DocumentSyncQueue: {},
}));

describe("versioned vector cache", () => {
  let tmp, files;
  const cacheFile = (name) =>
    path.join(tmp, "vector-cache", `${uuidv5(name, uuidv5.URL)}.json`);

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vc-"));
    process.env.STORAGE_DIR = tmp;
    delete process.env.NODE_ENV;
    fs.mkdirSync(path.join(tmp, "vector-cache"));
    jest.resetModules();
    jest.isolateModules(() => {
      files = require("../../../utils/files");
    });
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test("exports VECTOR_CACHE_VERSION", () => {
    expect(files.VECTOR_CACHE_VERSION).toBe(2);
  });

  test("store writes versioned dense-only wrapper; checkOnly true with bodies", async () => {
    const chunks = [[{ id: "a", values: [0.1], metadata: {}, body: "x" }]];
    await files.storeVectorResult(chunks, "doc1");
    const raw = fs.readFileSync(cacheFile("doc1"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.cache_version).toBe(files.VECTOR_CACHE_VERSION);
    expect(parsed.sparse).toBe(false);
    expect(parsed.chunks).toEqual(chunks);
    expect(raw).not.toMatch(/sparse_idx|sparse_val/);
    expect(await files.cachedVectorInformation("doc1", true)).toBe(true);
  });

  test("non-check call still returns fresh/not-exists for valid cache", async () => {
    await files.storeVectorResult([[{ id: "a", body: "x" }]], "doc2");
    expect(await files.cachedVectorInformation("doc2")).toEqual({
      exists: false,
      chunks: [],
    });
  });

  test("legacy bare array, garbage, lower version, missing bodies are false", async () => {
    fs.writeFileSync(cacheFile("legacy"), JSON.stringify([[{ id: "a" }]]));
    fs.writeFileSync(cacheFile("bad"), "{not json");
    fs.writeFileSync(
      cacheFile("old"),
      JSON.stringify({ cache_version: 1, chunks: [[{ body: "x" }]] })
    );
    expect(await files.cachedVectorInformation("legacy", true)).toBe(false);
    expect(await files.cachedVectorInformation("bad", true)).toBe(false);
    expect(await files.cachedVectorInformation("old", true)).toBe(false);
    expect(await files.cachedVectorInformation("missing", true)).toBe(false);
    await files.storeVectorResult([[{ id: "a", values: [1] }]], "nobody");
    expect(await files.cachedVectorInformation("nobody", true)).toBe(false);
  });
});
