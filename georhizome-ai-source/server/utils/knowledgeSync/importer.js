const fs = require("fs");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const {
  loadStaged,
  discardStaged,
  claimPreview,
  releasePreview,
} = require("./stage");
const { validateConfirmable } = require("./preview");
const { buildImportRows } = require("./docmap");
const { assertSafeSlug } = require("./paths");
const marker = require("./marker");
const journalLib = require("./journal");
const locks = require("./locks");
const swap = require("./swap");
const { assertWorkspaceAccess } = require("./access");
const { safeLog } = require("./redact");

const prisma = () => require("../prisma");
const WorkspaceModel = () => require("../../models/workspace").Workspace;

async function refuseIfBlocked(staged, opts) {
  const v = await validateConfirmable(staged, opts);
  if (!v.ok) throw new KnowledgeSyncError(v.blocking[0], { phase: "confirm" });
  return v;
}

/**
 * Confirm an import. passphrase is accepted for API symmetry but never used
 * or logged: the staged manifest was already verified at preview time.
 */
async function confirmImport(opts = {}) {
  // CR-03: one confirm per preview at a time, claimed before anything is
  // created (unmatched targets would otherwise take different slug locks).
  const previewId = opts.previewId;
  const cfg = opts.config || getKnowledgeSyncConfig();
  claimPreview(previewId);
  try {
    return await confirmImportClaimed({ ...opts, config: cfg });
  } finally {
    releasePreview(previewId);
  }
}

async function confirmImportClaimed({
  previewId,
  userId,
  user = null,
  multiUser = false,
  passphrase: _p,
  allowUnsynced = false,
  config,
} = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const staged = await loadStaged(previewId, { config: cfg });

  // T-06-25: only the previewing user may confirm.
  const owner = staged.meta && staged.meta.ownerUserId;
  if (owner !== null && owner !== undefined && owner !== userId)
    throw new KnowledgeSyncError("KS_E_PREVIEW_INVALID", { phase: "owner" });

  // D-08: server-side recompute; client "confirm" is never trusted.
  const first = await refuseIfBlocked(staged, { allowUnsynced });

  const W = WorkspaceModel();
  let workspace;
  let createdWorkspaceId = null;
  if (first.target.matched) {
    workspace = first.target.workspace;
    // W2: matched (existing) workspace requires membership in multi-user mode.
    await assertWorkspaceAccess({ slug: workspace.slug, user, multiUser });
  } else {
    const res = await W.new(staged.manifest.workspace.name, userId);
    if (!res || !res.workspace)
      throw new KnowledgeSyncError("KS_E_UNKNOWN", { phase: "create" });
    workspace = res.workspace;
    createdWorkspaceId = workspace.id;
    // WR-01: record the created workspace in a "prepared" journal right away
    // so boot recovery deletes it if we crash before the swap starts.
    try {
      await journalLib.createJournal(staged.jobId, {
        kind: "import",
        slug: assertSafeSlug(workspace.slug),
        createdWorkspaceId,
      });
    } catch (e) {
      await W.delete({ id: createdWorkspaceId });
      throw e;
    }
  }
  const slug = assertSafeSlug(workspace.slug);
  const created = createdWorkspaceId !== null;

  const cleanupCreated = async () => {
    if (!created) return;
    if ((await marker.readMarker(slug).catch(() => null)) === null)
      await W.delete({ id: createdWorkspaceId });
    const j = await journalLib.readJournal(staged.jobId);
    if (j && j.state === "prepared")
      await journalLib.removeJournalFile(staged.jobId);
  };

  let swapResult = null;
  try {
    await locks.withWorkspaceLock(
      slug,
      "import",
      async () => {
        // Recheck inside the lock (state may have moved since the first check).
        await refuseIfBlocked(staged, { allowUnsynced });
        if (!created) await assertWorkspaceAccess({ slug, user, multiUser });
        const archiveIds = new Set(staged.rows.docs.map((d) => d.docId));
        const local = await prisma().workspace_documents.findMany({
          where: { workspaceId: workspace.id },
        });
        const existingFlags = new Map(
          local
            .filter((d) => archiveIds.has(d.docId))
            .map((d) => [d.docId, { pinned: d.pinned, watched: d.watched }])
        );
        const rows = buildImportRows({
          rows: staged.rows,
          localSlug: slug,
          workspaceId: workspace.id,
          existingFlags,
        });
        const hasDocs = fs.existsSync(staged.stagedDocs);
        swapResult = await swap.runSwap(
          {
            jobId: staged.jobId,
            kind: "import",
            slug,
            workspaceId: workspace.id,
            createdWorkspaceId,
            source: {
              lance: staged.stagedLance,
              docs: hasDocs ? staged.stagedDocs : null,
              rows,
              marker: {
                versionId: staged.manifest.versionId,
                sourceRandomId: staged.manifest.workspace.randomId,
                syncedAt: new Date().toISOString(),
              },
            },
          },
          { config: cfg }
        );
      },
      staged.jobId
    );
  } catch (e) {
    if (!(e instanceof swap.CrashSignal)) await cleanupCreated();
    throw e;
  }
  const finalizePending = !!(swapResult && swapResult.finalizePending);
  // The staging dir is the journal dir: keep it for recovery if still pending.
  if (!finalizePending)
    await discardStaged(previewId, { config: cfg, owned: true }).catch(
      () => {}
    );
  safeLog("info", "import complete", {
    slug,
    versionId: staged.manifest.versionId,
  });
  return {
    slug,
    versionId: staged.manifest.versionId,
    docCount: staged.rows.docs.length,
    created,
    finalizePending,
  };
}

module.exports = { confirmImport };
