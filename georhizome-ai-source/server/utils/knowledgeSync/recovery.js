const fs = require("fs");
const path = require("path");
const { getKnowledgeSyncConfig } = require("./config");
const paths = require("./paths");
const journalLib = require("./journal");
const marker = require("./marker");
const swap = require("./swap");
const { safeLog } = require("./redact");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const rmrf = (p) => fs.promises.rm(p, { recursive: true, force: true });

async function readPendingMarker(slug) {
  try {
    const raw = await fs.promises.readFile(
      path.join(swap._testOnly.pendingRoot(slug), "marker.json"),
      "utf-8"
    );
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Did the DB transaction commit? The explicit commit token (written in the
 * same transaction, keyed by jobId) is the authority. Legacy fallback for
 * journals from before the token existed: marker.jobId === journal.jobId, or a
 * deleted marker when the pre-swap marker (pending/marker.json) was non-null.
 */
async function dbCommitted(journal) {
  if (await marker.hasCommitToken(journal.jobId)) return true;
  const m = await marker.readMarker(journal.slug);
  if (m && m.jobId === journal.jobId) return true;
  if (m === null) return (await readPendingMarker(journal.slug)) !== null;
  return false;
}

async function deleteCreatedWorkspace(journal) {
  if (journal.createdWorkspaceId === null) return;
  if ((await marker.readMarker(journal.slug)) !== null) return;
  const { Workspace } = require("../../models/workspace");
  await Workspace.delete({ id: journal.createdWorkspaceId });
}

async function recoverOne(journal, counts) {
  switch (journal.state) {
    case "prepared":
      await rmrf(swap._testOnly.pendingRoot(journal.slug));
      await deleteCreatedWorkspace(journal);
      await journalLib.removeJournalDir(journal.jobId);
      counts.rolledBack++;
      return;
    case "swapping": {
      if (await dbCommitted(journal)) {
        await swap.finishSwap(journal);
        counts.finished++;
      } else {
        await swap.rollbackSwap(journal);
        await deleteCreatedWorkspace(journal);
        counts.rolledBack++;
      }
      return;
    }
    case "committed":
      await swap.finishSwap(journal);
      counts.finished++;
      return;
    default:
      await journalLib.removeJournalDir(journal.jobId);
      counts.rolledBack++;
  }
}

async function hasUnsafeSlug(dir) {
  try {
    const j = JSON.parse(
      await fs.promises.readFile(path.join(dir, "journal.json"), "utf-8")
    );
    if (!j || typeof j !== "object" || !("slug" in j)) return false;
    paths.assertSafeSlug(j.slug);
    return false;
  } catch (err) {
    return err && err.code === "KS_E_UNSAFE_ENTRY";
  }
}

async function sweepStale(cfg, counts) {
  const root = paths.stagingRoot();
  let ents;
  try {
    ents = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const cutoff = Date.now() - cfg.stale_staging_hours * 3600 * 1000;
  for (const e of ents) {
    if (!e.isDirectory() || !UUID_RE.test(e.name)) continue;
    try {
      if (await journalLib.readJournal(e.name)) continue;
      const dir = path.join(root, e.name);
      if (await hasUnsafeSlug(dir)) {
        safeLog("warn", "quarantined journal with unsafe slug", {
          code: "KS_E_UNSAFE_ENTRY",
        });
        await rmrf(dir);
        counts.cleaned++;
        continue;
      }
      const st = await fs.promises.stat(dir);
      if (st.mtimeMs < cutoff) {
        await rmrf(dir);
        counts.cleaned++;
      }
    } catch (err) {
      safeLog("warn", "stale staging cleanup failed", {
        code: err && err.code,
      });
    }
  }
}

async function recoverKnowledgeSync() {
  const counts = { recovered: 0, rolledBack: 0, finished: 0, cleaned: 0 };
  try {
    const cfg = getKnowledgeSyncConfig();
    const journals = await journalLib.listJournals();
    for (const journal of journals) {
      try {
        paths.assertSafeSlug(journal.slug);
        await recoverOne(journal, counts);
      } catch (err) {
        safeLog("error", "knowledge sync recovery failed for job", {
          code: err && err.code,
        });
      }
    }
    await sweepStale(cfg, counts);
    counts.recovered = counts.rolledBack + counts.finished;
    if (counts.recovered || counts.cleaned)
      safeLog("warn", "knowledge sync recovery complete", counts);
  } catch (err) {
    safeLog("error", "knowledge sync recovery aborted", {
      code: err && err.code,
    });
  }
  return counts;
}

module.exports = { recoverKnowledgeSync };
