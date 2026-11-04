const { SparseError } = require("./errors");
const { loadSparseConfig, resolveBaseUrl, num } = require("./config");
const autostart = require("./autostart");

/**
 * Write-path client for the sparse encoder (POST {base}/sparse/encode).
 * Limits and timeouts come from config (see config.js). Callers pass chunk
 * BODY text only (D-R1); text is never altered, logged or put in errors.
 */
const UINT16_MAX = 65535;
const VOCAB_LIMIT = 65536;
const CONN_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ECONNRESET",
]);

let lastSuccessAt = 0;
let lastStartFailureAt = 0;
let lastStartFailureError = null;
let chain = Promise.resolve();

function _resetWarmState() {
  lastSuccessAt = 0;
  lastStartFailureAt = 0;
  lastStartFailureError = null;
  chain = Promise.resolve();
}

function currentTimeoutMs(cfg, now = Date.now()) {
  const idleMs = num(cfg.idle_unload_minutes, 15) * 60 * 1000;
  const cold = !lastSuccessAt || now - lastSuccessAt > idleMs;
  const warm = num(cfg.timeout_ms, 5000);
  return cold ? Math.max(warm, num(cfg.cold_timeout_ms, warm)) : warm;
}

function describeError(err, timeoutMs) {
  if (err?.name === "AbortError") return `timeout after ${timeoutMs}ms`;
  const code = err?.cause?.code || err?.code;
  return code ? String(code) : "network error";
}

function isConnFailure(err) {
  if (err?.name === "AbortError") return false;
  const code = err?.cause?.code || err?.code;
  if (code) return CONN_CODES.has(code);
  return err?.message === "fetch failed";
}

class ConnFailure extends Error {}

function validate(data, n) {
  if (
    !data ||
    !Array.isArray(data.data) ||
    data.data.length !== n ||
    (data.vocab_size != null && !(Number(data.vocab_size) <= VOCAB_LIMIT))
  ) {
    throw new SparseError("SPARSE_E_BAD_RESPONSE");
  }
  const out = new Array(n);
  data.data.forEach((row, pos) => {
    const idx = row?.index == null ? pos : row.index;
    if (!Number.isInteger(idx) || idx < 0 || idx >= n || out[idx]) {
      throw new SparseError("SPARSE_E_BAD_RESPONSE");
    }
    const { indices, values } = row || {};
    if (
      !Array.isArray(indices) ||
      !Array.isArray(values) ||
      indices.length !== values.length ||
      !indices.every((i) => Number.isInteger(i) && i >= 0 && i <= UINT16_MAX) ||
      !values.every((v) => typeof v === "number" && Number.isFinite(v))
    ) {
      throw new SparseError("SPARSE_E_BAD_RESPONSE");
    }
    out[idx] = { indices, values };
  });
  return out;
}

/** One HTTP attempt for a batch. Throws SparseError or ConnFailure. */
async function postBatch(batch, cfg, now) {
  const timeoutMs = currentTimeoutMs(cfg, now());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetch(`${resolveBaseUrl(cfg)}/sparse/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: batch }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err) {
      if (isConnFailure(err)) throw new ConnFailure();
      console.warn(`[Sparse] encode failed (${describeError(err, timeoutMs)})`);
      throw new SparseError("SPARSE_E_UNAVAILABLE", { port: cfg.port });
    }
    if (res.status === 413) throw new SparseError("SPARSE_E_TOO_LARGE");
    if (res.status === 503) {
      let detail = "";
      try {
        detail = String((await res.json())?.detail || "");
      } catch {
        /* ignore */
      }
      if (/degraded|load failed/i.test(detail)) {
        throw new SparseError("SPARSE_E_DEGRADED");
      }
      throw new SparseError("SPARSE_E_BUSY");
    }
    if (!res.ok) {
      console.warn(`[Sparse] encode HTTP ${res.status}`);
      throw new SparseError("SPARSE_E_BAD_RESPONSE");
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new SparseError("SPARSE_E_BAD_RESPONSE");
    }
    const out = validate(data, batch.length);
    lastSuccessAt = now();
    lastStartFailureAt = 0;
    lastStartFailureError = null;
    return out;
  } finally {
    clearTimeout(timer);
  }
}

async function postBatchWithBusyRetry(batch, cfg, now) {
  try {
    return await postBatch(batch, cfg, now);
  } catch (e) {
    if (e instanceof SparseError && e.code === "SPARSE_E_BUSY") {
      return postBatch(batch, cfg, now);
    }
    throw e;
  }
}

async function encodeInner(bodies, { cfg, now, ensure }) {
  if (
    lastStartFailureAt &&
    now() - lastStartFailureAt < num(cfg.cold_timeout_ms, 233000)
  ) {
    throw (
      lastStartFailureError ||
      new SparseError("SPARSE_E_UNAVAILABLE", { port: cfg.port })
    );
  }
  const size = cfg.max_inputs_per_request;
  const results = [];
  let started = false;
  for (let i = 0; i < bodies.length; i += size) {
    const batch = bodies.slice(i, i + size);
    let out;
    try {
      out = await postBatchWithBusyRetry(batch, cfg, now);
    } catch (e) {
      if (!(e instanceof ConnFailure)) throw e;
      const fail = (reason) => {
        const err = new SparseError(
          reason === "degraded" ? "SPARSE_E_DEGRADED" : "SPARSE_E_UNAVAILABLE",
          { port: cfg.port }
        );
        lastStartFailureAt = now();
        lastStartFailureError = err;
        return err;
      };
      if (started) throw fail();
      started = true;
      const ok = await ensure(cfg);
      if (!ok) throw fail(autostart.getLastStartReason());
      try {
        out = await postBatchWithBusyRetry(batch, cfg, now);
      } catch (e2) {
        if (e2 instanceof ConnFailure) throw fail();
        throw e2;
      }
    }
    results.push(...out);
  }
  return results;
}

/**
 * Encode chunk bodies to sparse vectors.
 * @param {string[]} bodies
 * @param {{cfg?: object, now?: () => number, ensure?: Function}} [opts]
 * @returns {Promise<{indices: number[], values: number[]}[]>} aligned with bodies
 * @throws {SparseError}
 */
function encodeSparse(bodies, opts = {}) {
  const cfg = opts.cfg || loadSparseConfig();
  const now = opts.now || Date.now;
  const ensure = opts.ensure || autostart.ensureSparseServer;
  if (!Array.isArray(bodies) || bodies.length === 0) {
    return Promise.resolve([]);
  }
  const max = cfg.max_input_chars;
  if (bodies.some((t) => [...String(t)].length > max)) {
    return Promise.reject(new SparseError("SPARSE_E_TOO_LARGE"));
  }
  const run = chain.then(() => encodeInner(bodies, { cfg, now, ensure }));
  chain = run.catch(() => {});
  return run;
}

module.exports = {
  encodeSparse,
  loadSparseConfig,
  currentTimeoutMs,
  _resetWarmState,
};
