const crypto = require("crypto");

// Single definition of the vector id hash (exporter + importer):
// sha256 hex of ascending-sorted string ids joined with "\n".
function computeIdHashFromArray(ids) {
  const sorted = ids.map(String).sort();
  return crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
}

// Selects ONLY the id column (no vectors) to keep memory low.
async function computeVectorIdHash(table) {
  const ids = [];
  for await (const batch of table.query().select(["id"])) {
    const col = batch.getChild("id");
    if (!col) continue;
    for (let i = 0; i < batch.numRows; i++) ids.push(String(col.get(i)));
  }
  return computeIdHashFromArray(ids);
}

module.exports = { computeVectorIdHash, computeIdHashFromArray };
