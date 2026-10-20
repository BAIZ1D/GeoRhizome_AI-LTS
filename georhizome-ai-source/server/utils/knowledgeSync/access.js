const { KnowledgeSyncError } = require("./errors");

const WorkspaceModel = () => require("../../models/workspace").Workspace;

/**
 * Multi-user workspace ACL for import-confirm and rollback (W2).
 * Single-user mode is unaffected. Admin/manager see all workspaces via
 * Workspace.getWithUser (AnythingLLM pattern); others must be members.
 */
async function assertWorkspaceAccess({ slug, user, multiUser }) {
  if (!multiUser) return;
  const ws = user ? await WorkspaceModel().getWithUser(user, { slug }) : null;
  if (!ws) throw new KnowledgeSyncError("KS_E_FORBIDDEN", { phase: "access" });
}

module.exports = { assertWorkspaceAccess };
