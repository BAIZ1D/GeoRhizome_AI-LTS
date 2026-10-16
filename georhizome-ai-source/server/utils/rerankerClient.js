const fs = require("fs");
const path = require("path");

/**
 * Shared client for the local cross-encoder reranker (POST /rerank, port 8001).
 * All parameters come from `app_config.json` -> `reranker`. The fallbacks below
 * are used only when that file or a key is missing:
 * - enabled: true (Stage 2 runs unless explicitly `false`)
 * - base_url: host.docker.internal (never loopback; GenericOpenAi rewriting is separate)
 * - wide_candidate_count: 30 Stage 1 cosine candidates
 * - final_top_k: null -> caller falls back to workspace topN
 * - min_reranker_score: -1.6 raw logits (Phase 1 calibration)
 * - timeout_ms: 12000 warm budget (Phase 1 p95 7988 ms x 1.5)
 * - cold_timeout_ms: 20000 budget when the model may need loading
 * - idle_unload_minutes: 15 (after this much idle time the next call is cold)
 */
const DEFAULTS = Object.freeze({
  enabled: true,
  base_url: "http://host.docker.internal:8001/rerank",
  wide_candidate_count: 30,
  final_top_k: null,
  min_reranker_score: -1.6,
  timeout_ms: 12000,
  cold_timeout_ms: 20000,
  idle_unload_minutes: 15,
});

const CONFIG_PATHS = [
  "/config/app_config.json",
  path.resolve(__dirname, "../../../config/app_config.json"),
];

let lastSuccessAt = 0;

function _resetWarmState() {
  lastSuccessAt = 0;
}

function readAppConfig() {
  for (const p of CONFIG_PATHS) {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (e) {
      console.warn(`[Reranker] Could not read ${p}: ${e.message}`);
    }
  }
  return null;
}

function num(value, fallback) {
  const n = Number(value);
  return value !== null && value !== undefined && Number.isFinite(n)
    ? n
    : fallback;
}

function loadRerankerConfig() {
  const r = readAppConfig()?.reranker;
  if (!r) return { ...DEFAULTS };
  return {
    enabled: r.enabled !== false,
    base_url: r.base_url || DEFAULTS.base_url,
    wide_candidate_count: num(
      r.wide_candidate_count,
      DEFAULTS.wide_candidate_count
    ),
    final_top_k: num(r.final_top_k, DEFAULTS.final_top_k),
    min_reranker_score: num(r.min_reranker_score, DEFAULTS.min_reranker_score),
    timeout_ms: num(r.timeout_ms, DEFAULTS.timeout_ms),
    cold_timeout_ms: num(r.cold_timeout_ms, DEFAULTS.cold_timeout_ms),
    idle_unload_minutes: num(
      r.idle_unload_minutes,
      DEFAULTS.idle_unload_minutes
    ),
  };
}

/**
 * Cold budget on the first call, or when the server has probably unloaded
 * the model after `idle_unload_minutes` without a successful call.
 */
function currentTimeoutMs(cfg, now = Date.now()) {
  const idleMs = num(cfg.idle_unload_minutes, 15) * 60 * 1000;
  const cold = !lastSuccessAt || now - lastSuccessAt > idleMs;
  const warm = num(cfg.timeout_ms, DEFAULTS.timeout_ms);
  return cold ? Math.max(warm, num(cfg.cold_timeout_ms, warm)) : warm;
}

function describeError(err, timeoutMs) {
  if (err?.name === "AbortError") return `timeout after ${timeoutMs}ms`;
  const code = err?.cause?.code || err?.code;
  if (code === "ECONNREFUSED") return "refused (ECONNREFUSED)";
  return code ? `${code}: ${err.message}` : `error: ${err?.message}`;
}

/**
 * Rerank candidates. Never throws.
 * @param {{query: string, candidates: {id: string, text: string}[], cfg?: object, label?: string}} params
 * @returns {Promise<{results: Array|null, reason: string|null}>} results are
 *   `{id, text, score, ...}` sorted by score desc, or null on fallback.
 */
async function rerank({
  query,
  candidates = [],
  cfg = loadRerankerConfig(),
  label = "retrieval",
}) {
  if (!cfg.enabled) return { results: null, reason: "disabled" };
  if (!query || !candidates.length) return { results: null, reason: "empty" };

  const timeoutMs = currentTimeoutMs(cfg);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let reason = null;
  try {
    const res = await fetch(cfg.base_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        candidates: candidates.map((c, i) => ({
          id: String(c.id ?? i),
          text: c.text || "",
        })),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      reason = `HTTP ${res.status}`;
    } else {
      const data = await res.json();
      if (Array.isArray(data?.results)) {
        lastSuccessAt = Date.now();
        return { results: data.results, reason: null };
      }
      reason = "invalid response (no results array)";
    }
  } catch (err) {
    reason = describeError(err, timeoutMs);
  } finally {
    clearTimeout(timer);
  }
  console.warn(
    `[Reranker] ${label}: falling back to Stage-1 order (${reason}) url=${cfg.base_url}`
  );
  return { results: null, reason };
}

/**
 * Rerank chat history against the current prompt and keep the top
 * `final_top_k` (default 8) turns in chronological order. Returns the input
 * unchanged when disabled, empty or on any reranker failure.
 * @param {{query: string, history: object[], toText: (row: object) => string, label?: string, cfg?: object}} params
 * @returns {Promise<object[]>}
 */
async function rerankHistory({
  query,
  history = [],
  toText,
  label = "chat-history",
  cfg = loadRerankerConfig(),
}) {
  if (!cfg.enabled || !query || history.length === 0) return history;
  const { results } = await rerank({
    query,
    candidates: history.map((row, idx) => ({
      id: String(idx),
      text: toText(row),
    })),
    cfg,
    label,
  });
  if (!results) return history;
  const keep = cfg.final_top_k || 8;
  const picked = results
    .map((r) => Number(r.id))
    .filter((i) => Number.isInteger(i) && i >= 0 && i < history.length)
    .slice(0, keep)
    .sort((a, b) => a - b);
  return picked.length ? picked.map((i) => history[i]) : history;
}

module.exports = {
  DEFAULTS,
  CONFIG_PATHS,
  loadRerankerConfig,
  currentTimeoutMs,
  rerank,
  rerankHistory,
  _resetWarmState,
};
