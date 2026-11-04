/** sparseStatus (D4, IDX-05): on-demand filtered counts, never cached. */
const { hasSparseColumns } = require("./schema");

async function sparseStatus(table) {
  if (!table) return "missing";
  if (!(await hasSparseColumns(table))) return "missing";
  const total = await table.countRows();
  if (total === 0) return "missing";
  const withSparse = await table.countRows("sparse_idx IS NOT NULL");
  if (withSparse === 0) return "missing";
  const withoutSparse = await table.countRows("sparse_idx IS NULL");
  return withoutSparse === 0 ? "ready" : "partial";
}

module.exports = { sparseStatus };
