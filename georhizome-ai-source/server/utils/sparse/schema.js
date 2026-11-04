/**
 * Typed sparse-column plumbing for LanceDB (Phase 11, plan 05).
 * Implements the paths verified by the plan-01 spike (11-SPIKE-RESULT.md):
 * TYPED_CREATE=compose, LEGACY_MIGRATION=typed addColumns (arrow_cast NULL),
 * DEDUPE_FILTER=where. Every scan sets an explicit .limit(rowCount).
 * Callers must hold the workspace "embed" lock around ensureSparseColumns.
 */
const path = require("path");
const arrow = require("apache-arrow");
const lancedb = require("@lancedb/lancedb");

const SPARSE_COLUMNS = ["sparse_idx", "sparse_val"];
const ADD_COLUMNS_SQL = [
  { name: "sparse_idx", valueSql: "arrow_cast(NULL, 'List(UInt16)')" },
  { name: "sparse_val", valueSql: "arrow_cast(NULL, 'List(Float32)')" },
];

const u16List = () =>
  new arrow.List(new arrow.Field("item", new arrow.Uint16(), true));
const f32List = () =>
  new arrow.List(new arrow.Field("item", new arrow.Float32(), true));

const stagingTableName = (namespace) => `${namespace}__sparse_stage`;
const stagingMarkerPath = (lancedbDir, namespace) =>
  path.join(lancedbDir, `${stagingTableName(namespace)}.json`);

function fieldNames(schema) {
  return new Set((schema?.fields || []).map((f) => f.name));
}

async function hasSparseColumns(table) {
  if (!table) return false;
  const names = fieldNames(await table.schema());
  return SPARSE_COLUMNS.every((c) => names.has(c));
}

function sparseTypesOk(schema) {
  const t = (n) => {
    const f = schema.fields.find((x) => x.name === n);
    return f ? String(f.type) : "";
  };
  return (
    /List<Uint16>/.test(t("sparse_idx")) &&
    /List<Float32>/.test(t("sparse_val"))
  );
}

function stripSparseKeys(row) {
  const rest = { ...row };
  for (const c of SPARSE_COLUMNS) delete rest[c];
  return rest;
}

/** rows: scalar/vector/text fields + sparse_idx/sparse_val (number[]|null). */
function buildTypedTable(rows) {
  const base = lancedb.makeArrowTable(rows.map(stripSparseKeys));
  const cols = {};
  for (const f of base.schema.fields) cols[f.name] = base.getChild(f.name);
  cols.sparse_idx = arrow.vectorFromArray(
    rows.map((r) => r.sparse_idx ?? null),
    u16List()
  );
  cols.sparse_val = arrow.vectorFromArray(
    rows.map((r) => r.sparse_val ?? null),
    f32List()
  );
  return new arrow.Table(cols);
}

/**
 * Upgrade a legacy dense-only table in place (D1, no row cap, no copy).
 * Returns the (re-opened) table. No-op when columns already exist.
 */
async function ensureSparseColumns(client, namespace) {
  let table = await client.openTable(namespace);
  if (await hasSparseColumns(table)) return table;
  await table.addColumns(ADD_COLUMNS_SQL);
  table = await client.openTable(namespace);
  if (!sparseTypesOk(await table.schema())) {
    throw new Error(
      `sparse columns on ${namespace} are not typed List<Uint16>/List<Float32>`
    );
  }
  return table;
}

/**
 * Returns {complete:Set<hash>, denseOnly:Map<hash,id[]>} (D-R3).
 * Tables without sparse columns are entirely denseOnly.
 */
async function findExistingHashes(table, rowCount) {
  const complete = new Set();
  const denseOnly = new Map();
  const addDense = (r) => {
    const list = denseOnly.get(r.content_hash) || [];
    list.push(r.id);
    denseOnly.set(r.content_hash, list);
  };
  if (!table) return { complete, denseOnly };
  const limit = rowCount ?? (await table.countRows());
  if (limit === 0) return { complete, denseOnly };

  if (!(await hasSparseColumns(table))) {
    const rows = await table
      .query()
      .select(["id", "content_hash"])
      .limit(limit)
      .toArray();
    for (const r of rows) if (r.content_hash != null) addDense(r);
    return { complete, denseOnly };
  }

  const done = await table
    .query()
    .where("sparse_idx IS NOT NULL")
    .select(["id", "content_hash"])
    .limit(limit)
    .toArray();
  for (const r of done)
    if (r.content_hash != null) complete.add(r.content_hash);
  const dense = await table
    .query()
    .where("sparse_idx IS NULL")
    .select(["id", "content_hash"])
    .limit(limit)
    .toArray();
  for (const r of dense) if (r.content_hash != null) addDense(r);
  return { complete, denseOnly };
}

module.exports = {
  SPARSE_COLUMNS,
  stagingTableName,
  stagingMarkerPath,
  hasSparseColumns,
  sparseTypesOk,
  buildTypedTable,
  ensureSparseColumns,
  stripSparseKeys,
  findExistingHashes,
};
