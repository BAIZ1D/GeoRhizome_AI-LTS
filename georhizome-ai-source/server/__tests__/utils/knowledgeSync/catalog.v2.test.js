const {
  buildCatalog,
  validateCatalog,
  addVersion,
  removeVersion,
  getNextVersion,
} = require("../../../utils/knowledgeSync/catalog");

const RID = "7f3a9c2e";
const meta = { name: "n", slug: "s", randomId: RID };
const rec = (v) => ({
  version: v,
  tag: `ks-${RID}-v${v}`,
  parts: 1,
  sizeBytes: 10,
  docCount: 2,
  publishedAt: "2026-01-01T00:00:00.000Z",
});

test("v1 catalog accepted and normalized", () => {
  const c = validateCatalog({
    formatVersion: 1,
    entries: [{ name: "n", slug: "s", randomId: RID, latestVersion: 3 }],
  });
  expect(c.formatVersion).toBe(2);
  expect(c.entries[0].maxVersion).toBe(3);
  expect(c.entries[0].versions).toEqual([]);
  expect(Object.isFrozen(c)).toBe(true);
});

test("v2 invariants", () => {
  const ent = (o) => ({
    ...meta,
    latestVersion: 2,
    maxVersion: 2,
    versions: [rec(1), rec(2)],
    ...o,
  });
  const mk = (o) => () => buildCatalog([ent(o)]);
  expect(mk({})).not.toThrow();
  expect(mk({ versions: [rec(2), rec(1)] })).toThrow();
  expect(mk({ versions: [rec(1), rec(1)], latestVersion: 1 })).toThrow();
  expect(mk({ latestVersion: 1 })).toThrow();
  expect(mk({ maxVersion: 1 })).toThrow();
  expect(
    mk({ versions: [{ ...rec(1), tag: "ks-aaaaaaaa-v1" }], latestVersion: 1 })
  ).toThrow();
  expect(mk({ extra: 1 })).toThrow();
  expect(mk({ versions: [], latestVersion: 1 })).toThrow();
});

test("addVersion, removeVersion fallback and tombstone", () => {
  let c = buildCatalog([]);
  c = addVersion(c, meta, rec(1));
  c = addVersion(c, meta, rec(2));
  expect(c.entries[0].latestVersion).toBe(2);
  c = removeVersion(c, "s", 2);
  expect(c.entries[0].latestVersion).toBe(1);
  expect(c.entries[0].maxVersion).toBe(2);
  c = removeVersion(c, RID, 1);
  expect(c.entries).toHaveLength(1);
  expect(c.entries[0].versions).toEqual([]);
  expect(c.entries[0].latestVersion).toBe(0);
  expect(c.entries[0].maxVersion).toBe(2);
  expect(getNextVersion(c, "s")).toBe(3);
  expect(getNextVersion(c, "other")).toBe(1);
});

test("publish 1, remove, next is 2", () => {
  let c = addVersion(buildCatalog([]), meta, rec(1));
  c = removeVersion(c, "s", 1);
  expect(c.entries[0].maxVersion).toBe(1);
  expect(getNextVersion(c, "s")).toBe(2);
});
