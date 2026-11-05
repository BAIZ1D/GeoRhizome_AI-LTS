const fs = require("fs");
const path = require("path");

/**
 * Hybrid retrieval config. Values come from `app_config.json` -> `hybrid`;
 * these are documented fallbacks only:
 * enabled false (strictly `true` enables), rrf_k 60, dense_top_n 50,
 * sparse_top_n 50, leg_timeout_ms 3000 (per-leg budget),
 * sparse_query_timeout_ms 3000 (sparse query-encode budget).
 * Non-finite or non-positive numbers fall back to the defaults.
 */
const DEFAULTS = Object.freeze({
  enabled: false,
  rrf_k: 60,
  dense_top_n: 50,
  sparse_top_n: 50,
  leg_timeout_ms: 3000,
  sparse_query_timeout_ms: 3000,
});

const CONFIG_PATHS = [
  "/config/app_config.json",
  path.resolve(__dirname, "../../../../config/app_config.json"),
];

function readAppConfig() {
  for (const p of CONFIG_PATHS) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.warn(`[Hybrid] Could not read ${p}: ${e.message}`);
    }
  }
  return null;
}

function posNum(value, fallback) {
  if (value === null || value === undefined || typeof value === "boolean")
    return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function loadHybridConfig() {
  const h = readAppConfig()?.hybrid || {};
  return {
    enabled: h.enabled === true,
    rrf_k: posNum(h.rrf_k, DEFAULTS.rrf_k),
    dense_top_n: posNum(h.dense_top_n, DEFAULTS.dense_top_n),
    sparse_top_n: posNum(h.sparse_top_n, DEFAULTS.sparse_top_n),
    leg_timeout_ms: posNum(h.leg_timeout_ms, DEFAULTS.leg_timeout_ms),
    sparse_query_timeout_ms: posNum(
      h.sparse_query_timeout_ms,
      DEFAULTS.sparse_query_timeout_ms
    ),
  };
}

module.exports = { loadHybridConfig, DEFAULTS, CONFIG_PATHS };
