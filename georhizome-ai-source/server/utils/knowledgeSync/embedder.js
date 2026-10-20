const fs = require("fs");
const { candidatePaths } = require("./config");

// Fallbacks mirror GenericOpenAiEmbedder (model/dimension) and
// local_bge_server (normalize_embeddings=True, no prefixes).
const FALLBACK_MODEL = "BAAI/bge-m3";
const FALLBACK_DIMENSION = 1024;

function readEmbeddingConfig() {
  const candidates = candidatePaths();
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      return JSON.parse(fs.readFileSync(p, "utf-8"))?.embedding || {};
    } catch {
      return {};
    }
  }
  return {};
}

/** Effective embedder identity; no network (preview never probes). */
function effectiveEmbedder(env = process.env) {
  const cfg = readEmbeddingConfig();
  const dim =
    Number(env.EMBEDDING_DIMENSION) || cfg.dimension || FALLBACK_DIMENSION;
  const pre =
    cfg.prefixes && typeof cfg.prefixes === "object" ? cfg.prefixes : {};
  return {
    modelId: env.EMBEDDING_MODEL_PREF ?? cfg.model_name ?? FALLBACK_MODEL,
    dimension:
      Number.isSafeInteger(Number(dim)) && Number(dim) > 0
        ? Number(dim)
        : FALLBACK_DIMENSION,
    normalization:
      typeof cfg.normalization === "boolean" ? cfg.normalization : true,
    prefixes: {
      query: typeof pre.query === "string" ? pre.query : "",
      document: typeof pre.document === "string" ? pre.document : "",
    },
  };
}

module.exports = { effectiveEmbedder };
