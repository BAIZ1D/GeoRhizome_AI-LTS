const fs = require("fs");
const path = require("path");

/**
 * Sparse encoder (SPLADE, port 8004) client config. All values come from
 * `app_config.json` -> `sparse`; these are documented fallbacks only:
 * enabled false, port 8004, max_input_chars 1024 (code points),
 * max_inputs_per_request 16, idle_unload_minutes 15, timeout_ms 5000 warm,
 * cold_timeout_ms 233000 (model load budget). Base URL is never loopback:
 * env SPARSE_BASE_PATH, else host.docker.internal:<port>.
 */
const DEFAULTS = Object.freeze({
  enabled: false,
  port: 8004,
  max_input_chars: 1024,
  max_inputs_per_request: 16,
  idle_unload_minutes: 15,
  timeout_ms: 5000,
  cold_timeout_ms: 233000,
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
      console.warn(`[Sparse] Could not read ${p}: ${e.message}`);
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

function loadSparseConfig() {
  const s = readAppConfig()?.sparse || {};
  return {
    enabled: s.enabled === true,
    port: num(s.port, DEFAULTS.port),
    max_input_chars: num(s.max_input_chars, DEFAULTS.max_input_chars),
    max_inputs_per_request: Math.max(
      1,
      num(s.max_inputs_per_request, DEFAULTS.max_inputs_per_request)
    ),
    idle_unload_minutes: num(
      s.idle_unload_minutes,
      DEFAULTS.idle_unload_minutes
    ),
    timeout_ms: num(s.timeout_ms, DEFAULTS.timeout_ms),
    cold_timeout_ms: num(s.cold_timeout_ms, DEFAULTS.cold_timeout_ms),
  };
}

/** Base URL ending in /v1 (no trailing slash). */
function resolveBaseUrl(cfg = loadSparseConfig()) {
  const env = process.env.SPARSE_BASE_PATH;
  if (env) return env.replace(/\/+$/, "");
  return `http://host.docker.internal:${num(cfg.port, DEFAULTS.port)}/v1`;
}

function resolveHealthUrl(cfg = loadSparseConfig()) {
  return `${resolveBaseUrl(cfg).replace(/\/v1$/, "")}/health`;
}

function resolveHubUrl() {
  return (
    process.env.HARDWARE_SERVER_URL || "http://host.docker.internal:8002"
  ).replace(/\/+$/, "");
}

module.exports = {
  DEFAULTS,
  CONFIG_PATHS,
  readAppConfig,
  num,
  loadSparseConfig,
  resolveBaseUrl,
  resolveHealthUrl,
  resolveHubUrl,
};
