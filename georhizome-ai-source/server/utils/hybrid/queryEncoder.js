const { loadSparseConfig, resolveBaseUrl, num } = require("../sparse/config");
const autostart = require("../sparse/autostart");

/**
 * Query-time sparse encoder (HYB-01/HYB-03). Own AbortController timeout,
 * no shared write-path chain, never throws. Query text is never logged.
 * @returns {Promise<{vec: {indices:number[],values:number[]}|null, reason: string|null}>}
 */
const UINT16_MAX = 65535;
const CONN_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ECONNRESET",
]);

function isConnFailure(err) {
  if (err?.name === "AbortError") return false;
  const code = err?.cause?.code || err?.code;
  if (code) return CONN_CODES.has(code);
  return err?.message === "fetch failed";
}

function validRow(row) {
  const { indices, values } = row || {};
  return (
    Array.isArray(indices) &&
    Array.isArray(values) &&
    indices.length === values.length &&
    indices.every((i) => Number.isInteger(i) && i >= 0 && i <= UINT16_MAX) &&
    values.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

function kickAutostart(cfg) {
  Promise.resolve()
    .then(() => autostart.ensureSparseServer(cfg))
    .catch((e) =>
      console.warn(`[Hybrid] sparse autostart failed (${e?.code || "error"})`)
    );
}

async function encodeQuery(text, { cfg, timeoutMs } = {}) {
  const c = cfg || loadSparseConfig();
  const controller = new AbortController();
  const ms = num(timeoutMs, num(c.timeout_ms, 5000));
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const max = num(c.max_input_chars, 1024);
    const cps = [...String(text ?? "")];
    const body = cps.length > max ? cps.slice(0, max).join("") : cps.join("");
    let res;
    try {
      res = await fetch(`${resolveBaseUrl(c)}/sparse/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: [body] }),
        redirect: "error",
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === "AbortError") {
        return { vec: null, reason: "sparse_timeout" };
      }
      if (isConnFailure(err)) kickAutostart(c);
      return { vec: null, reason: "sparse_unavailable" };
    }
    if (!res.ok) return { vec: null, reason: `sparse_http_${res.status}` };
    let data;
    try {
      data = await res.json();
    } catch (err) {
      if (err?.name === "AbortError") {
        return { vec: null, reason: "sparse_timeout" };
      }
      return { vec: null, reason: "sparse_invalid" };
    }
    const row = Array.isArray(data?.data) ? data.data[0] : null;
    if (
      !Array.isArray(data?.data) ||
      data.data.length !== 1 ||
      !validRow(row)
    ) {
      return { vec: null, reason: "sparse_invalid" };
    }
    return {
      vec: { indices: row.indices, values: row.values },
      reason: null,
    };
  } catch {
    return { vec: null, reason: "sparse_unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { encodeQuery };
