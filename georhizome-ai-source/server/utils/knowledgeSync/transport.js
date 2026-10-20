const fs = require("fs");
const path = require("path");
const { pipeline } = require("stream/promises");
const { KnowledgeSyncError } = require("./errors");
const { sha256File } = require("./util");

const READ_HWM = 1024 * 1024;
const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function throwIfAborted(signal) {
  if (signal && signal.aborted)
    throw new KnowledgeSyncError("KS_E_CANCELLED", { phase: "transport" });
}

/** Split `src` into part-NNNN.bin files of at most partSize bytes. */
async function splitFile(src, partSize, outDir, { signal } = {}) {
  if (!Number.isInteger(partSize) || partSize <= 0)
    throw new KnowledgeSyncError("KS_E_PARAMS", { phase: "split" });
  const { size } = await fs.promises.stat(src);
  await fs.promises.mkdir(outDir, { recursive: true });
  const parts = [];
  let idx = 0;
  for (let start = 0; start < size; start += partSize) {
    throwIfAborted(signal);
    idx += 1;
    const end = Math.min(start + partSize, size) - 1;
    const name = `part-${String(idx).padStart(4, "0")}.bin`;
    const dest = path.join(outDir, name);
    await pipeline(
      fs.createReadStream(src, { start, end, highWaterMark: READ_HWM }),
      fs.createWriteStream(dest)
    );
    parts.push({ name, size: end - start + 1, sha256: await sha256File(dest) });
  }
  return parts;
}

/** Concatenate parts (index order) into destPath. */
async function reassemble(partDir, parts, destPath, { signal } = {}) {
  const out = fs.createWriteStream(destPath);
  try {
    for (const p of parts) {
      throwIfAborted(signal);
      const rs = fs.createReadStream(path.join(partDir, p.name), {
        highWaterMark: READ_HWM,
      });
      await new Promise((resolve, reject) => {
        rs.on("error", reject);
        rs.on("end", resolve);
        rs.pipe(out, { end: false });
      });
    }
  } catch (e) {
    out.destroy();
    throw e;
  }
  await new Promise((resolve, reject) => {
    out.on("error", reject);
    out.on("finish", resolve);
    out.end();
  });
}

function headerOf(err, name) {
  const h = err && (err.headers || (err.response && err.response.headers));
  if (!h) return undefined;
  if (typeof h.get === "function") return h.get(name);
  return h[name];
}

function shouldRetry(err) {
  const s = err && err.status;
  if (typeof s !== "number") return !!(err && err.retryable);
  if (s === 401 || s === 404 || s === 422) return false;
  if (RETRY_STATUSES.has(s)) return true;
  if (s === 403) {
    return (
      headerOf(err, "retry-after") !== undefined ||
      String(headerOf(err, "x-ratelimit-remaining")) === "0"
    );
  }
  return false;
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal)
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(t);
          reject(new KnowledgeSyncError("KS_E_CANCELLED", { phase: "retry" }));
        },
        { once: true }
      );
  });

async function withRetry(
  fn,
  { attempts, minMs, maxMs, signal, sleep = defaultSleep } = {}
) {
  for (let i = 1; ; i++) {
    throwIfAborted(signal);
    try {
      return await fn(i);
    } catch (err) {
      if (
        (err && err.code === "KS_E_CANCELLED") ||
        i >= attempts ||
        !shouldRetry(err)
      )
        throw err;
      let wait = Math.min(maxMs, minMs * 2 ** (i - 1));
      const ra = Number(headerOf(err, "retry-after"));
      if (Number.isFinite(ra) && ra >= 0) wait = Math.max(ra * 1000, wait);
      await sleep(wait, signal);
    }
  }
}

function cryptoSemaphore(size = 1) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= size || !queue.length) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
      });
    },
  };
}

module.exports = {
  splitFile,
  reassemble,
  withRetry,
  cryptoSemaphore,
  shouldRetry,
};
