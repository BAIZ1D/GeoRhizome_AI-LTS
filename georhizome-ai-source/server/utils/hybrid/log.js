/**
 * Retrieval log contract (HYB-03). One line per retrieval with a fixed
 * path + reason vocabulary. Only whitelisted fields are logged; query and
 * chunk text are never emitted.
 */
const PATHS = Object.freeze({
  HYBRID_RERANK: "hybrid_rerank",
  HYBRID_RRF: "hybrid_rrf",
  DENSE_RERANK: "dense_rerank",
  DENSE_ONLY: "dense_only",
});

const REASONS = Object.freeze({
  OK: "ok",
  HYBRID_DISABLED_GLOBAL: "hybrid_disabled_global",
  HYBRID_DISABLED_WORKSPACE: "hybrid_disabled_workspace",
  SPARSE_DISABLED: "sparse_disabled",
  SPARSE_MISSING: "sparse_missing",
  SPARSE_PARTIAL: "sparse_partial",
  SPARSE_TIMEOUT: "sparse_timeout",
  SPARSE_UNAVAILABLE: "sparse_unavailable",
  SPARSE_ERROR: "sparse_error",
  SPARSE_EMPTY: "sparse_empty",
  DENSE_TIMEOUT: "dense_timeout",
  HYBRID_ERROR: "hybrid_error",
  MISSING_ROW_ID: "missing_row_id",
});

function sanitize(v) {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Reason token for a reranker failure: `reranker_<sanitized reason>`. */
function rerankerReason(reason) {
  return `reranker_${sanitize(reason) || "unknown"}`;
}

function logRetrieval(fields = {}) {
  let { retrievalPath, reason } = fields;
  if (!Object.values(PATHS).includes(retrievalPath)) {
    reason = `invalid_path_${sanitize(reason) || "unknown"}`;
    retrievalPath = PATHS.DENSE_ONLY;
  }
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const ns = String(fields.namespace ?? "").replace(/[\r\n']/g, "");
  console.log(
    `[Retrieval] ws='${ns}' retrievalPath=${retrievalPath} reason=${
      reason ?? REASONS.OK
    } dense=${n(fields.dense)} sparse=${n(fields.sparse)} fused=${n(
      fields.fused
    )} ms=${n(fields.ms)}`
  );
}

module.exports = { logRetrieval, rerankerReason, PATHS, REASONS };
