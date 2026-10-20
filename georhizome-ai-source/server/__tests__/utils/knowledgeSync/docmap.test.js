const {
  safeBasename,
  buildImportRows,
} = require("../../../utils/knowledgeSync/docmap");

const rows = (docs) => ({
  docs,
  vectors: [{ docId: "d1", vectorId: "v1" }],
});
const D = (o = {}) => ({
  docId: "d1",
  filename: "a.json",
  file: "a.json",
  metadata: { x: 1 },
  pinned: false,
  watched: false,
  createdAt: "2024-01-01T00:00:00.000Z",
  ...o,
});

test("filename is basename; docpath under ks-<slug>", () => {
  const { docs } = buildImportRows({
    rows: rows([D()]),
    localSlug: "loc",
    workspaceId: 3,
  });
  expect(docs[0].filename).toBe("a.json");
  expect(docs[0].docpath).toBe("custom-documents/ks-loc/a.json");
  expect(docs[0].workspaceId).toBe(3);
});
test("traversal names rejected", () => {
  for (const n of ["../x", "a/b", "a\\b", "", "a\0b"])
    expect(() => safeBasename(n)).toThrow(/unsafe/i);
});
test("pinned/watched preserved for surviving docId, archived for new", () => {
  const { docs } = buildImportRows({
    rows: rows([D(), D({ docId: "d2", file: "b.json", pinned: true })]),
    localSlug: "loc",
    workspaceId: 1,
    existingFlags: new Map([["d1", { pinned: true, watched: true }]]),
  });
  expect(docs[0]).toMatchObject({ pinned: true, watched: true });
  expect(docs[1]).toMatchObject({ pinned: true, watched: false });
});
test("duplicate files rejected", () => {
  expect(() =>
    buildImportRows({
      rows: rows([D(), D({ docId: "d2" })]),
      localSlug: "loc",
      workspaceId: 1,
    })
  ).toThrow();
});
test("vectors mapped", () => {
  const r = buildImportRows({
    rows: rows([D()]),
    localSlug: "loc",
    workspaceId: 1,
  });
  expect(r.vectors).toEqual([{ docId: "d1", vectorId: "v1" }]);
});

test("IN-01: original archive filename is preserved; docpath uses file", () => {
  const { docs } = buildImportRows({
    rows: rows([D({ filename: "report.json", file: "abcd1234-report.json" })]),
    localSlug: "s",
    workspaceId: 1,
  });
  expect(docs[0].filename).toBe("report.json");
  expect(docs[0].docpath).toMatch(/\/abcd1234-report\.json$/);
});

test("IN-01: unsafe archive filename falls back to file", () => {
  const { docs } = buildImportRows({
    rows: rows([D({ filename: "../evil.json", file: "a.json" })]),
    localSlug: "s",
    workspaceId: 1,
  });
  expect(docs[0].filename).toBe("a.json");
});
