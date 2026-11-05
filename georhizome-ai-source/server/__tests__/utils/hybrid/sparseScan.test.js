/* eslint-env jest */
const fs = require("fs");
const os = require("os");
const path = require("path");
const lancedb = require("@lancedb/lancedb");
const { buildTypedTable } = require("../../../utils/sparse/schema");
const { scoreTable } = require("../../../utils/hybrid/sparseScan");

let tmp, db;
const row = (id, idx, val) => ({
  id,
  vector: [0.1, 0.2, 0.3, 0.4],
  sparse_idx: idx,
  sparse_val: val,
});

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hybrid-scan-"));
  db = await lancedb.connect(tmp);
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("15 rows: row beyond default limit 10 is found", async () => {
  const rows = [];
  for (let i = 0; i < 15; i++) {
    rows.push(row(`r${String(i).padStart(2, "0")}`, [5], [i === 14 ? 2 : 0]));
  }
  rows[14].sparse_idx = [7];
  rows[14].sparse_val = [2];
  const t = await db.createTable("t15", buildTypedTable(rows));
  const out = await scoreTable(t, { indices: [7], values: [1] }, 5);
  expect(out).toEqual([{ id: "r14", score: 2 }]);
});

test("topN, order, ties by id, null and non-positive excluded, duplicates sum", async () => {
  const rows = [
    row("b", [1], [1]),
    row("a", [1], [1]),
    row("c", [1, 2], [3, 1]),
    row("d", [9], [5]),
    row("n", null, null),
    row("neg", [1], [-4]),
  ];
  const t = await db.createTable("tmix", buildTypedTable(rows));
  const q = { indices: [1, 1, 2], values: [0.5, 0.5, 1] };
  const out = await scoreTable(t, q, 3);
  expect(out.map((r) => r.id)).toEqual(["c", "a", "b"]);
  expect(out[0].score).toBeCloseTo(4);
  expect(out[1].score).toBeCloseTo(1);
  const top1 = await scoreTable(t, q, 1);
  expect(top1.map((r) => r.id)).toEqual(["c"]);
});

test("empty table -> []", async () => {
  const seed = await db.createTable(
    "tempty",
    buildTypedTable([row("x", [1], [1])])
  );
  await seed.delete("id = 'x'");
  expect(await scoreTable(seed, { indices: [1], values: [1] }, 5)).toEqual([]);
});
