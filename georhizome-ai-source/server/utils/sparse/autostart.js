const {
  loadSparseConfig,
  resolveHealthUrl,
  resolveHubUrl,
  num,
} = require("./config");

/**
 * Hub-driven auto-start of the sparse server (D2, D-R5: hub untouched).
 *
 * Probe-first: any HTTP answer from `{base}/health` (loading/unloaded/ready)
 * means the server is alive and serve is NOT called. Only a connection-level
 * failure triggers one `POST {hub}/hardware/serve {category:"sparse"}`,
 * followed by health polling bounded by `cold_timeout_ms`. Concurrent callers
 * share one start (`startInFlight`). Side effect accepted per D2/D3: serve
 * flips sparse.enabled=true via sync_sparse_state.
 */
const POLL_MS = 500;

let startInFlight = null;
let lastReason = null;

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isConnFailure(err) {
  if (err?.name === "AbortError") return false;
  const code = err?.cause?.code || err?.code;
  return (
    ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ECONNRESET"].includes(
      code
    ) || err?.message === "fetch failed"
  );
}

/** @returns {Promise<{alive: boolean, degraded?: boolean}>} */
async function probe(cfg) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), num(cfg.timeout_ms, 5000));
  try {
    const res = await fetch(resolveHealthUrl(cfg), {
      redirect: "error",
      signal: controller.signal,
    });
    let state = null;
    try {
      state = (await res.json())?.state;
    } catch {
      /* non-JSON answer still means alive */
    }
    return { alive: true, degraded: state === "degraded" };
  } catch (err) {
    // A slow-but-listening server is alive: never restart on timeout.
    if (err?.name === "AbortError") return { alive: true };
    if (isConnFailure(err)) return { alive: false };
    return { alive: false };
  } finally {
    clearTimeout(timer);
  }
}

async function doStart(cfg, { sleep, pollMs, now }) {
  lastReason = null;
  const first = await probe(cfg);
  if (first.alive) {
    if (first.degraded) {
      lastReason = "degraded";
      return false;
    }
    return true;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), num(cfg.timeout_ms, 5000));
  try {
    const res = await fetch(`${resolveHubUrl()}/hardware/serve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: "sparse" }),
      redirect: "error",
      signal: controller.signal,
    });
    if (!res.ok) {
      lastReason = `hub HTTP ${res.status}`;
      console.warn(`[Sparse] autostart: ${lastReason}`);
      return false;
    }
  } catch (err) {
    lastReason = err?.cause?.code || err?.name || "hub unreachable";
    console.warn(`[Sparse] autostart: hub unreachable (${lastReason})`);
    return false;
  } finally {
    clearTimeout(timer);
  }

  const deadline = now() + num(cfg.cold_timeout_ms, 233000);
  while (now() < deadline) {
    const p = await probe(cfg);
    if (p.alive) {
      if (p.degraded) {
        lastReason = "degraded";
        return false;
      }
      return true;
    }
    await sleep(pollMs);
  }
  lastReason = "start timeout";
  console.warn("[Sparse] autostart: health did not answer in time");
  return false;
}

/**
 * Ensure the sparse server answers. Single-flight.
 * @returns {Promise<boolean>} true when alive; false otherwise (see getLastStartReason).
 */
function ensureSparseServer(
  cfg = loadSparseConfig(),
  { sleep = defaultSleep, pollMs = POLL_MS, now = Date.now } = {}
) {
  if (startInFlight) return startInFlight;
  startInFlight = doStart(cfg, { sleep, pollMs, now }).finally(() => {
    startInFlight = null;
  });
  return startInFlight;
}

const getLastStartReason = () => lastReason;

module.exports = { ensureSparseServer, getLastStartReason, POLL_MS };
