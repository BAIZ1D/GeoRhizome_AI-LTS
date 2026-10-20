const path = require("path");
const { getKnowledgeSyncConfig } = require("./config");
const { KnowledgeSyncError } = require("./errors");

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// Mirrors utils/files documentsPath / LanceDb.uri STORAGE_DIR resolution
// (not imported: those modules pull in prisma / @lancedb).
function storageBase(env = process.env, pathImpl = path) {
  if (env.NODE_ENV === "development" || !env.STORAGE_DIR) {
    return pathImpl.resolve(__dirname, "../../storage");
  }
  return pathImpl.resolve(env.STORAGE_DIR);
}

function stagingRoot({ pathImpl = path, env = process.env, config } = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  return pathImpl.join(storageBase(env, pathImpl), cfg.staging_dir_name);
}
function lancedbRoot({ pathImpl = path, env = process.env } = {}) {
  return pathImpl.resolve(storageBase(env, pathImpl), "lancedb");
}
function documentsRoot({ pathImpl = path, env = process.env } = {}) {
  return pathImpl.resolve(storageBase(env, pathImpl), "documents");
}

function assertSafeSlug(slug) {
  if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
    throw new KnowledgeSyncError("KS_E_UNSAFE_ENTRY", { phase: "slug" });
  }
  return slug;
}

function assertWithin(outer, inner, pathImpl = path) {
  const o = pathImpl.resolve(outer);
  const i = pathImpl.resolve(inner);
  const rel = pathImpl.relative(o, i);
  const ok =
    i !== o &&
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(".." + pathImpl.sep) &&
    !pathImpl.isAbsolute(rel);
  if (!ok) throw new KnowledgeSyncError("KS_E_UNSAFE_ENTRY", { phase: "path" });
  return i;
}

module.exports = {
  stagingRoot,
  lancedbRoot,
  documentsRoot,
  assertSafeSlug,
  assertWithin,
};
