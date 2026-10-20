const crypto = require("crypto");
const { KnowledgeSyncError, toClientError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const marker = require("./marker");
const { safeLog } = require("./redact");
const { UUID_RE } = require("./util");

// In-memory job registry (D-06..D-09). Holds no passphrase, token or path.
const jobs = new Map(); // jobId -> record
const activeBySlug = new Map(); // slug -> jobId

const PHASES = Object.freeze({
  publish: ["pack", "encrypt", "upload"],
  sync: ["preview", "download", "verify", "import"],
  rollback: ["verify", "import"],
});
const CANCELLABLE = new Set([
  "pack",
  "encrypt",
  "upload",
  "preview",
  "download",
]);
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);

const uidOf = (u) => (u && typeof u === "object" ? u.id : u);
const sameUser = (a, b) => {
  const x = uidOf(a);
  const y = uidOf(b);
  if (x === undefined || x === null) return y === undefined || y === null;
  return y !== undefined && y !== null && String(x) === String(y);
};
const forbidden = () =>
  new KnowledgeSyncError("KS_E_FORBIDDEN", { phase: "job" });

function crumb(rec) {
  // Serialized per job so terminal states always land after earlier writes.
  rec.crumbChain = (rec.crumbChain || Promise.resolve()).then(() =>
    marker
      .writeJobBreadcrumb(rec.slug, {
        jobId: rec.id,
        userId: rec.userId === undefined ? null : rec.userId,
        slug: rec.slug,
        kind: rec.kind,
        state: rec.state,
        phase: rec.phase,
        updatedAt: new Date().toISOString(),
      })
      .catch(() => safeLog("warn", "job breadcrumb write failed"))
  );
  return rec.crumbChain;
}

function touch(rec) {
  rec.updatedAt = Date.now();
}

function finish(rec, state, err) {
  rec.state = state;
  rec.error = err ? toClientError(err) : null;
  touch(rec);
  if (activeBySlug.get(rec.slug) === rec.id) activeBySlug.delete(rec.slug);
  if (rec.confirmWaiter) {
    rec.confirmWaiter = null;
  }
  const p = crumb(rec);
  const t = setTimeout(
    () => jobs.delete(rec.id),
    getKnowledgeSyncConfig().job_retention_ms
  );
  if (t.unref) t.unref();
  return p;
}

function makeCtx(rec) {
  return {
    signal: rec.ac.signal,
    setPhase(p) {
      rec.phase = p;
      rec.percent = null;
      touch(rec);
      crumb(rec);
    },
    setPercent(n) {
      rec.percent = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
      touch(rec);
    },
    throwIfCancelled() {
      if (rec.cancelRequested)
        throw new KnowledgeSyncError("KS_E_CANCELLED", { phase: rec.phase });
    },
    setPreview(obj) {
      rec.preview = obj;
      touch(rec);
    },
    awaitConfirm() {
      const ttl = getKnowledgeSyncConfig().preview_ttl_minutes * 60 * 1000;
      return new Promise((resolve, reject) => {
        let timer = null;
        const settle = (fn, v) => {
          clearTimeout(timer);
          rec.confirmWaiter = null;
          fn(v);
        };
        rec.confirmWaiter = {
          resolve: () => settle(resolve),
          reject: (e) => settle(reject, e),
        };
        timer = setTimeout(
          () =>
            rec.confirmWaiter &&
            rec.confirmWaiter.reject(
              new KnowledgeSyncError("KS_E_PREVIEW_INVALID", {
                phase: "preview",
              })
            ),
          ttl
        );
        if (timer.unref) timer.unref();
        rec.state = "awaiting_confirm";
        touch(rec);
        crumb(rec);
      });
    },
  };
}

async function runJob(rec, run) {
  try {
    await run(makeCtx(rec));
    rec.percent = 100;
    await finish(rec, "succeeded");
  } catch (err) {
    if (rec.cancelRequested)
      await finish(rec, "cancelled", new KnowledgeSyncError("KS_E_CANCELLED"));
    else await finish(rec, "failed", err);
  }
}

/** Returns the job id before any I/O; one active job per workspace (D-08). */
function startJob({ kind, slug, userId, run }) {
  if (!PHASES[kind]) throw new KnowledgeSyncError("KS_E_UNKNOWN");
  if (typeof run !== "function") throw new KnowledgeSyncError("KS_E_UNKNOWN");
  if (activeBySlug.has(slug))
    throw new KnowledgeSyncError("KS_E_BUSY", { phase: "job" });
  const id = crypto.randomUUID();
  const now = Date.now();
  const rec = {
    id,
    kind,
    slug,
    userId: userId === undefined ? null : uidOf(userId),
    state: "running",
    phase: null,
    percent: null,
    cancelRequested: false,
    error: null,
    preview: null,
    createdAt: now,
    updatedAt: now,
    ac: new AbortController(),
    confirmWaiter: null,
  };
  jobs.set(id, rec);
  activeBySlug.set(slug, id);
  crumb(rec);
  setImmediate(() => runJob(rec, run));
  return id;
}

function view(rec) {
  return {
    id: rec.id,
    kind: rec.kind,
    slug: rec.slug,
    state: rec.state,
    phase: rec.phase,
    percent: rec.percent,
    preview: rec.preview,
    error: rec.error
      ? { code: rec.error.code, message: rec.error.message }
      : null,
  };
}

function breadcrumbView(b) {
  const terminal = TERMINAL.has(b.state);
  const state = terminal ? b.state : "interrupted";
  let error = null;
  if (state === "interrupted")
    error = toClientError(new KnowledgeSyncError("KS_E_INTERRUPTED"));
  else if (state === "cancelled")
    error = toClientError(new KnowledgeSyncError("KS_E_CANCELLED"));
  else if (state === "failed") error = toClientError(new Error("x"));
  return {
    id: b.jobId,
    kind: b.kind,
    slug: b.slug,
    state,
    phase: b.phase || null,
    percent: null,
    preview: null,
    error,
  };
}

async function getJob(id, user, isAdmin = false) {
  const rec = typeof id === "string" ? jobs.get(id) : null;
  if (rec) {
    if (!isAdmin && !sameUser(rec.userId, user)) throw forbidden();
    return view(rec);
  }
  if (typeof id !== "string" || !UUID_RE.test(id))
    throw new KnowledgeSyncError("KS_E_JOB_NOT_FOUND");
  const crumbs = await marker.listJobBreadcrumbs();
  const b = crumbs.find((c) => c.jobId === id);
  if (!b) throw new KnowledgeSyncError("KS_E_JOB_NOT_FOUND");
  if (!isAdmin && !sameUser(b.userId, user)) throw forbidden();
  return breadcrumbView(b);
}

async function lastJobForSlug(slug, user, isAdmin = false) {
  const activeId = activeBySlug.get(slug);
  let rec = activeId ? jobs.get(activeId) : null;
  if (!rec) {
    for (const r of jobs.values())
      if (r.slug === slug && (!rec || r.createdAt >= rec.createdAt)) rec = r;
  }
  if (rec) {
    if (!isAdmin && !sameUser(rec.userId, user)) throw forbidden();
    return view(rec);
  }
  const b = await marker.readJobBreadcrumb(slug);
  if (!b || !b.jobId) return null;
  if (!isAdmin && !sameUser(b.userId, user)) throw forbidden();
  return breadcrumbView(b);
}

function ownedRec(id, user, isAdmin) {
  const rec = typeof id === "string" ? jobs.get(id) : null;
  if (!rec) throw new KnowledgeSyncError("KS_E_JOB_NOT_FOUND");
  if (!isAdmin && !sameUser(rec.userId, user)) throw forbidden();
  return rec;
}

function requestCancel(id, user, isAdmin = false) {
  const rec = ownedRec(id, user, isAdmin);
  if (TERMINAL.has(rec.state)) return view(rec);
  if (!CANCELLABLE.has(rec.phase) && rec.phase !== null)
    throw new KnowledgeSyncError("KS_E_SYNCING", { phase: rec.phase });
  rec.cancelRequested = true;
  rec.ac.abort();
  if (rec.confirmWaiter)
    rec.confirmWaiter.reject(
      new KnowledgeSyncError("KS_E_CANCELLED", { phase: rec.phase })
    );
  touch(rec);
  return view(rec);
}

/** Owner only: an admin cannot confirm another user's import. */
function confirmJob(id, user) {
  const rec = ownedRec(id, user, false);
  if (rec.state !== "awaiting_confirm" || !rec.confirmWaiter)
    throw new KnowledgeSyncError("KS_E_PREVIEW_INVALID", { phase: "confirm" });
  rec.state = "running";
  touch(rec);
  rec.confirmWaiter.resolve();
  return view(rec);
}

function _resetForTests() {
  jobs.clear();
  activeBySlug.clear();
}

module.exports = {
  PHASES,
  CANCELLABLE,
  startJob,
  getJob,
  requestCancel,
  confirmJob,
  confirm: confirmJob,
  lastJobForSlug,
  _resetForTests,
};
