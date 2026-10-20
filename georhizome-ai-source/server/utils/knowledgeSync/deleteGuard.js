const locks = require("./locks");

/**
 * Run a workspace-destructive callback under the per-workspace "delete" lock
 * (D-01). Throws KS_E_BUSY when export/import/embed/etc. holds the slug.
 */
function deleteWorkspaceLocked(slug, fn) {
  return locks.withWorkspaceLock(slug, "delete", fn);
}

module.exports = { deleteWorkspaceLocked };
