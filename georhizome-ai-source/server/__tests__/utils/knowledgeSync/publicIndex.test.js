const {
  buildPublicIndex,
  validatePublicIndex,
  RELEASE_BODY,
} = require("../../../utils/knowledgeSync/publicIndex");
const {
  buildCatalog,
  validateCatalog,
  CATALOG_ASSET_NAME,
} = require("../../../utils/knowledgeSync/catalog");
const { buildManifest } = require("../../../utils/knowledgeSync/manifest");

const manifest = buildManifest({
  workspace: { name: "秘密ワーク", slug: "secret-slug", randomId: "7f3a9c2e" },
  versionId: 2,
  embedder: {
    modelId: "ruri",
    dimension: 768,
    normalization: true,
    prefixes: { query: "", document: "" },
  },
  chunking: { chunkSize: 1024, overlap: 0 },
  rowCount: 1,
  vectorIdHash: "a".repeat(64),
  files: [
    { path: "documents/secret-file.txt", size: 1, sha256: "b".repeat(64) },
  ],
  versions: { lancedb: "1", app: "1" },
  createdAt: "2026-01-01T00:00:00.000Z",
});

test("index leaks nothing", () => {
  const idx = buildPublicIndex(manifest, [
    { size: 10, sha256: "c".repeat(64) },
    { size: 5, sha256: "d".repeat(64) },
  ]);
  const s = JSON.stringify(idx);
  for (const x of ["秘密ワーク", "secret-slug", "7f3a9c2e", "secret-file"])
    expect(s).not.toContain(x);
  expect(idx.totalSize).toBe(15);
  expect(idx.parts[0].name).toBe("part-0001.bin");
});
test("rejects extra keys", () => {
  const idx = JSON.parse(JSON.stringify(buildPublicIndex(manifest, [])));
  idx.name = "x";
  expect(() => validatePublicIndex(idx)).toThrow();
});
test("release body", () => {
  expect(RELEASE_BODY).toBe(
    "Encrypted GeoRhizome knowledge archive. Not usable without the team passphrase."
  );
});
test("catalog", () => {
  expect(CATALOG_ASSET_NAME).toBe("catalog.bin");
  const e = (id) => ({
    name: "n",
    slug: "s",
    randomId: id,
    latestVersion: 1,
    maxVersion: 1,
    versions: [
      {
        version: 1,
        tag: `ks-${id}-v1`,
        parts: 1,
        sizeBytes: 1,
        docCount: 1,
        publishedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  expect(buildCatalog([e("7f3a9c2e")]).entries).toHaveLength(1);
  expect(() =>
    validateCatalog({
      formatVersion: 2,
      entries: [e("7f3a9c2e"), e("7f3a9c2e")],
    })
  ).toThrow();
  expect(() =>
    validateCatalog({ formatVersion: 2, entries: [e("ZZ")] })
  ).toThrow();
});
