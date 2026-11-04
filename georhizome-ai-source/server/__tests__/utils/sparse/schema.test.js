/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const lancedb = require("@lancedb/lancedb");
const {
  hasSparseColumns,
  buildTypedTable,
  ensureSparseColumns,
  stripSparseKeys,
  findExistingHashes,
  stagingTableName,
  stagingMarkerPath,
  SPARSE_COLUMNS,
} = require("../../../utils/sparse/schema");

let tmp, db;
const vec = () => [0.1, 0.2, 0.3, 0.4];
const ft = (sch, n) => String(sch.fields.find((f) => f.name === n).type);
const typed = async (t) => {
  const s = await t.schema();
  expect(ft(s, "sparse_idx")).toMatch(/List<Uint16>/);
  expect(ft(s, "sparse_val")).toMatch(/List<Float32>/);
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparse-schema-"));
  db = await lancedb.connect(tmp);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("stripSparseKeys / helpers", () => {
  expect(
    stripSparseKeys({ id: "a", sparse_idx: [1], sparse_val: [1], x: 2 })
  ).toEqual({ id: "a", x: 2 });
  expect(SPARSE_COLUMNS).toEqual(["sparse_idx", "sparse_val"]);
  expect(stagingTableName("ns")).toBe("ns__sparse_stage");
  expect(stagingMarkerPath("/d", "ns")).toBe("/d/ns__sparse_stage.json");
});

test("typed create stays typed after add with arrays and explicit nulls", async () => {
  const rows = [
    {
      id: "a",
      content_hash: "ha",
      vector: vec(),
      sparse_idx: [1, 2],
      sparse_val: [0.5, 1],
    },
    {
      id: "b",
      content_hash: "hb",
      vector: vec(),
      sparse_idx: null,
      sparse_val: null,
    },
  ];
  const t = await db.createTable("typed", buildTypedTable(rows));
  await typed(t);
  await t.add([
    {
      id: "c",
      content_hash: "hc",
      vector: vec(),
      sparse_idx: [3],
      sparse_val: [2],
    },
  ]);
  await typed(t);
  await t.add([
    {
      id: "d",
      content_hash: "hd",
      vector: vec(),
      sparse_idx: null,
      sparse_val: null,
    },
  ]);
  await typed(t);
  expect(await t.countRows()).toBe(4);
  expect(await hasSparseColumns(t)).toBe(true);
});

test("all-null batch still typed", async () => {
  const t = await db.createTable(
    "allnull",
    buildTypedTable([
      {
        id: "a",
        content_hash: "h",
        vector: vec(),
        sparse_idx: null,
        sparse_val: null,
      },
    ])
  );
  await typed(t);
});

test("legacy upgrade preserves rows, nulls sparse, idempotent", async () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({
    id: `l${i}`,
    content_hash: `h${i}`,
    vector: vec(),
  }));
  const t = await db.createTable("legacy", rows);
  expect(await hasSparseColumns(t)).toBe(false);
  const up = await ensureSparseColumns(db, "legacy");
  await typed(up);
  expect(await up.countRows()).toBe(12);
  expect(await up.countRows("sparse_idx IS NULL")).toBe(12);
  const again = await ensureSparseColumns(db, "legacy");
  expect(await again.countRows()).toBe(12);
  await again.add([
    {
      id: "n",
      content_hash: "hn",
      vector: vec(),
      sparse_idx: [1],
      sparse_val: [1],
    },
  ]);
  await typed(again);
});

test("findExistingHashes sees all 30 rows on dense-only table", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: `d${i}`,
    content_hash: `h${i % 15}`,
    vector: vec(),
  }));
  const t = await db.createTable("dense30", rows);
  const r = await findExistingHashes(t, await t.countRows());
  expect(r.complete.size).toBe(0);
  const ids = [...r.denseOnly.values()].reduce((n, a) => n + a.length, 0);
  expect(ids).toBe(30);
  expect(r.denseOnly.size).toBe(15);
});

test("findExistingHashes splits complete vs denseOnly beyond 10 rows", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: `m${i}`,
    content_hash: `h${i}`,
    vector: vec(),
    sparse_idx: i < 20 ? [i] : null,
    sparse_val: i < 20 ? [1] : null,
  }));
  const t = await db.createTable("mixed30", buildTypedTable(rows));
  const r = await findExistingHashes(t, 30);
  expect(r.complete.size).toBe(20);
  expect(r.denseOnly.size).toBe(10);
  expect(r.denseOnly.get("h25")).toEqual(["m25"]);
});
