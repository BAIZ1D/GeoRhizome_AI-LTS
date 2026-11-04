/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const lancedb = require("@lancedb/lancedb");
const {
  buildTypedTable,
  ensureSparseColumns,
} = require("../../../utils/sparse/schema");
const { sparseStatus } = require("../../../utils/sparse/status");

let tmp, db;
const vec = () => [0.1, 0.2, 0.3, 0.4];
const row = (id, sp) => ({
  id,
  content_hash: `h${id}`,
  vector: vec(),
  sparse_idx: sp ? [1] : null,
  sparse_val: sp ? [1] : null,
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sparse-status-"));
  db = await lancedb.connect(tmp);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("null/undefined table -> missing", async () => {
  expect(await sparseStatus(null)).toBe("missing");
  expect(await sparseStatus(undefined)).toBe("missing");
});

test("dense-only table -> missing", async () => {
  const t = await db.createTable("dense", [
    { id: "1", content_hash: "h", vector: vec() },
  ]);
  expect(await sparseStatus(t)).toBe("missing");
});

test("legacy upgraded (all null) -> missing", async () => {
  await db.createTable("leg", [{ id: "1", content_hash: "h", vector: vec() }]);
  const t = await ensureSparseColumns(db, "leg");
  expect(await sparseStatus(t)).toBe("missing");
});

test("partial, ready, no caching, total count unchanged", async () => {
  const t = await db.createTable(
    "p",
    buildTypedTable([row("1", true), row("2", false)])
  );
  expect(await sparseStatus(t)).toBe("partial");
  expect(await t.countRows()).toBe(2);
  const r = await db.createTable(
    "r",
    buildTypedTable([row("1", true), row("2", true)])
  );
  expect(await sparseStatus(r)).toBe("ready");
  expect(await r.countRows()).toBe(2);

  const c = await db.createTable("c", buildTypedTable([row("1", true)]));
  expect(await sparseStatus(c)).toBe("ready");
  await c.add([row("2", false)]);
  expect(await sparseStatus(c)).toBe("partial");
});

test("empty table with sparse columns -> missing", async () => {
  const t = await db.createTable("e", buildTypedTable([row("1", true)]));
  await t.delete("id = '1'");
  expect(await sparseStatus(t)).toBe("missing");
});
