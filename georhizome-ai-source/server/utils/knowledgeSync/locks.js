const { KnowledgeSyncError } = require("./errors");

// In-process per-workspace lock (D-01). Crash recovery is the journal's job.
const held = new Map();

/** Synchronous check-and-set: no await between check and set. */
function acquire(slug, op, jobId = null) {
  const cur = held.get(slug);
  if (cur) {
    if (cur.op === "embed" && op === "embed") {
      cur.embedRefs += 1;
      return;
    }
    throw new KnowledgeSyncError("KS_E_BUSY", { phase: "lock" });
  }
  held.set(slug, {
    op,
    jobId,
    since: Date.now(),
    embedRefs: op === "embed" ? 1 : 0,
  });
}

function release(slug, op) {
  const cur = held.get(slug);
  if (!cur) return;
  if (cur.op === "embed" && op === "embed" && cur.embedRefs > 1) {
    cur.embedRefs -= 1;
    return;
  }
  if (cur.op === op) held.delete(slug);
}

async function withWorkspaceLock(slug, op, fn, jobId = null) {
  acquire(slug, op, jobId);
  try {
    return await fn();
  } finally {
    release(slug, op);
  }
}

function syncing(slug) {
  const cur = held.get(slug);
  return !!cur && (cur.op === "import" || cur.op === "rollback");
}

function state(slug) {
  const cur = held.get(slug);
  return cur
    ? { op: cur.op, since: cur.since, embedRefs: cur.embedRefs }
    : null;
}

function heldCount() {
  return held.size;
}

function assertNotSyncing(slug) {
  if (syncing(slug))
    throw new KnowledgeSyncError("KS_E_SYNCING", { phase: "syncing" });
}

function _resetForTests() {
  held.clear();
}

module.exports = {
  acquire,
  release,
  withWorkspaceLock,
  syncing,
  state,
  heldCount,
  assertNotSyncing,
  _resetForTests,
};
