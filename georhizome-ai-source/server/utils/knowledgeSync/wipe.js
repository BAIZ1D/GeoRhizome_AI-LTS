const fs = require("fs");
const path = require("path");
const paths = require("./paths");
const locks = require("./locks");
const marker = require("./marker");
const { assertWorkspaceAccess } = require("./access");
const { KnowledgeSyncError } = require("./errors");

const WorkspaceModel = () => require("../../models/workspace").Workspace;
const db = () => require("../prisma");

const rmrf = (outer, target) => {
  paths.assertWithin(outer, target);
  return fs.promises.rm(target, { recursive: true, force: true });
};

/**
 * D-17: purge a workspace's synced knowledge. Removes the lance table, the
 * ks-<slug> documents, workspace_documents/document_vectors rows, the synced
 * marker and the backup. The workspaces row and chat settings stay untouched.
 * Never contacts GitHub. LanceDb.connect() opens a new client per call (no
 * cached handle), so no handle invalidation is needed after removing the dir.
 */
async function wipeWorkspace({ slug, userId, user, multiUser } = {}) {
  paths.assertSafeSlug(slug);
  return locks.withWorkspaceLock(
    slug,
    "wipe",
    async () => {
      await assertWorkspaceAccess({ slug, user, multiUser });
      const ws = await WorkspaceModel().get({ slug });
      if (!ws)
        throw new KnowledgeSyncError("KS_E_NOT_FOUND", { phase: "wipe" });

      await rmrf(paths.lancedbRoot(), paths.lanceTablePath(slug));
      // IDX-04: crash-window staging table + marker (plan 11-05 D-R6).
      await rmrf(
        paths.lancedbRoot(),
        paths.lanceTablePath(`${slug}__sparse_stage`)
      );
      await rmrf(
        paths.lancedbRoot(),
        path.join(paths.lancedbRoot(), `${slug}__sparse_stage.json`)
      );
      await rmrf(paths.documentsRoot(), paths.ksDocsDir(slug));
      await rmrf(paths.storageBase(), paths.backupRoot(slug));

      const prisma = db();
      await prisma.$transaction(async (tx) => {
        const docs = await tx.workspace_documents.findMany({
          where: { workspaceId: ws.id },
        });
        const docIds = docs.map((d) => d.docId);
        if (docIds.length)
          await tx.document_vectors.deleteMany({
            where: { docId: { in: docIds } },
          });
        await tx.workspace_documents.deleteMany({
          where: { workspaceId: ws.id },
        });
        await marker.deleteMarker(tx, slug);
      });
      return { slug, wiped: true };
    },
    userId === undefined ? null : String(userId)
  );
}

module.exports = { wipeWorkspace };
