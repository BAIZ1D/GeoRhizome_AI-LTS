const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const paths = require("./paths");
const locks = require("./locks");
const swap = require("./swap");
const journalLib = require("./journal");

const WorkspaceModel = () => require("../../models/workspace").Workspace;

const exists = (p) =>
  fs.promises.access(p).then(
    () => true,
    () => false
  );

async function readJson(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf-8"));
  } catch {
    throw new KnowledgeSyncError("KS_E_NO_BACKUP", { phase: "backup" });
  }
}

/** One-step reversible rollback to the backup slot (D-04, IMP-08). */
async function rollbackWorkspace({ slug, userId: _userId, config } = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  paths.assertSafeSlug(slug);
  const workspace = await WorkspaceModel().get({ slug });
  if (!workspace)
    throw new KnowledgeSyncError("KS_E_NOT_FOUND", { phase: "slug" });
  const bk = paths.backupRoot(slug);
  if (!(await exists(path.join(bk, "rows.json"))))
    throw new KnowledgeSyncError("KS_E_NO_BACKUP", { phase: "backup" });

  return locks.withWorkspaceLock(slug, "rollback", async () => {
    const rows = await readJson(path.join(bk, "rows.json"));
    if (!rows || !Array.isArray(rows.docs) || !Array.isArray(rows.vectors))
      throw new KnowledgeSyncError("KS_E_NO_BACKUP", { phase: "backup" });
    const oldMarker = (await exists(path.join(bk, "marker.json")))
      ? await readJson(path.join(bk, "marker.json"))
      : null;
    const jobId = crypto.randomUUID();
    const lance = path.join(bk, "lance");
    const docs = path.join(bk, "docs");
    await swap.runSwap(
      {
        jobId,
        kind: "rollback",
        slug,
        workspaceId: workspace.id,
        createdWorkspaceId: null,
        source: {
          lance: (await exists(lance)) ? lance : null,
          docs: (await exists(docs)) ? docs : null,
          rows,
          marker: oldMarker
            ? { ...oldMarker, jobId, syncedAt: new Date().toISOString() }
            : null,
        },
      },
      { config: cfg }
    );
    return {
      slug,
      restoredVersionId: oldMarker ? oldMarker.versionId ?? null : null,
    };
  });
}

module.exports = { rollbackWorkspace };
