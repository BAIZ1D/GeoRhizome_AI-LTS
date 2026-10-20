const {
  buildManifest,
  validateManifest,
  newRandomId,
  releaseTag,
} = require("../../../utils/knowledgeSync/manifest");

const valid = () => ({
  formatVersion: 1,
  workspace: { name: "ワーク", slug: "my-ws", randomId: "7f3a9c2e" },
  versionId: 3,
  embedder: {
    modelId: "m",
    dimension: 768,
    normalization: true,
    prefixes: { query: "q: ", document: "d: " },
  },
  chunking: { chunkSize: 1024, overlap: 20 },
  rowCount: 10,
  vectorIdHash: "a".repeat(64),
  files: [{ path: "lancedb/x.lance", size: 5, sha256: "b".repeat(64) }],
  versions: { lancedb: "1", app: "1" },
  createdAt: "2026-01-01T00:00:00.000Z",
});
const code = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.code;
  }
};

test("valid manifest frozen", () => {
  expect(Object.isFrozen(validateManifest(valid()))).toBe(true);
  expect(Object.isFrozen(buildManifest(valid()))).toBe(true);
});
test.each([
  ["missing rowCount", (m) => delete m.rowCount],
  ["extra key", (m) => (m.foo = 1)],
  ["formatVersion 2", (m) => (m.formatVersion = 2)],
  ["bad sha", (m) => (m.files[0].sha256 = "zz")],
  ["bad versionId", (m) => (m.versionId = 0)],
  ["traversal path", (m) => (m.files[0].path = "../x")],
  ["nested extra", (m) => (m.chunking.x = 1)],
])("rejects %s", (_n, mut) => {
  const m = valid();
  mut(m);
  expect(code(() => validateManifest(m))).toBe("KS_E_MANIFEST");
});
test("random id and tag", () => {
  expect(newRandomId()).toMatch(/^[0-9a-f]{8}$/);
  expect(releaseTag("7f3a9c2e", 4)).toBe("ks-7f3a9c2e-v4");
  expect(code(() => releaseTag("ワーク", 1))).toBe("KS_E_MANIFEST");
});
