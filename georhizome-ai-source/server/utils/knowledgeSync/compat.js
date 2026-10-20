const { KnowledgeSyncError } = require("./errors");
const { effectiveEmbedder } = require("./embedder");

function checkCompatibility(manifest, local = effectiveEmbedder()) {
  const a = manifest.embedder;
  const reasons = [];
  const cmp = (code, field, expected, actual) => {
    if (expected !== actual) reasons.push({ code, field, expected, actual });
  };
  cmp("KS_E_EMBEDDER_MISMATCH", "modelId", local.modelId, a.modelId);
  cmp("KS_E_DIM_MISMATCH", "dimension", local.dimension, a.dimension);
  cmp(
    "KS_E_EMBEDDER_MISMATCH",
    "prefixes.query",
    local.prefixes?.query ?? "",
    a.prefixes?.query ?? ""
  );
  cmp(
    "KS_E_EMBEDDER_MISMATCH",
    "prefixes.document",
    local.prefixes?.document ?? "",
    a.prefixes?.document ?? ""
  );
  cmp(
    "KS_E_EMBEDDER_MISMATCH",
    "normalization",
    local.normalization,
    a.normalization
  );
  return { ok: reasons.length === 0, reasons };
}

function assertCompatible(manifest, local) {
  const r = checkCompatibility(manifest, local);
  if (!r.ok)
    throw new KnowledgeSyncError(r.reasons[0].code, { phase: "compat" });
  return r;
}

module.exports = { checkCompatibility, assertCompatible };
