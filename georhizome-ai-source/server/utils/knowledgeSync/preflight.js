const fs = require("fs");
const path = require("path");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");

const unsafe = (phase) =>
  new KnowledgeSyncError("KS_E_UNSAFE_ENTRY", { phase });

// lstat walk: sums regular-file sizes; symlinks/special entries are rejected.
async function sizeOf(p) {
  const st = await fs.promises.lstat(p);
  if (st.isSymbolicLink()) throw unsafe("preflight");
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) throw unsafe("preflight");
  let total = 0;
  for (const ent of await fs.promises.readdir(p))
    total += await sizeOf(path.join(p, ent));
  return total;
}

async function estimateBytes(paths) {
  let total = 0;
  for (const p of paths) total += await sizeOf(p);
  return total;
}

async function requireFreeSpace(dir, bytesNeeded, { config } = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const fail = () =>
    new KnowledgeSyncError("KS_E_DISK_SPACE", { phase: "preflight" });
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    if (typeof fs.promises.statfs !== "function") throw fail();
    const s = await fs.promises.statfs(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(free)) throw fail();
    if (free < cfg.disk_preflight_factor * bytesNeeded) throw fail();
  } catch (e) {
    if (e instanceof KnowledgeSyncError) throw e;
    throw fail();
  }
}

module.exports = { estimateBytes, requireFreeSpace };
