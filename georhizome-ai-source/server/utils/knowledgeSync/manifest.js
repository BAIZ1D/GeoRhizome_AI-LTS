const crypto = require("crypto");
const { KnowledgeSyncError } = require("./errors");

const MANIFEST_FORMAT_VERSION = 1;
const HEX64 = /^[0-9a-f]{64}$/;
const RID_RE = /^[0-9a-f]{8}$/;

const bad = (phase) => new KnowledgeSyncError("KS_E_MANIFEST", { phase });
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
const posInt = (n) => Number.isInteger(n) && n > 0;
const nonEmptyStr = (s) => typeof s === "string" && s.length > 0;

function exactKeys(o, keys, phase) {
  if (!isObj(o)) throw bad(phase);
  const ks = Object.keys(o);
  if (ks.length !== keys.length || !keys.every((k) => ks.includes(k)))
    throw bad(phase);
}

function safeRelPath(p) {
  if (!nonEmptyStr(p)) return false;
  if (p.startsWith("/") || p.includes("\\") || /^[A-Za-z]:/.test(p))
    return false;
  return !p.split("/").some((s) => s === ".." || s === "" || s === ".");
}

function newRandomId() {
  return crypto.randomBytes(4).toString("hex");
}

function releaseTag(randomId, versionId) {
  if (
    typeof randomId !== "string" ||
    !RID_RE.test(randomId) ||
    !posInt(versionId)
  )
    throw bad("tag");
  return `ks-${randomId}-v${versionId}`;
}

function validateManifest(m) {
  exactKeys(
    m,
    [
      "formatVersion",
      "workspace",
      "versionId",
      "embedder",
      "chunking",
      "rowCount",
      "vectorIdHash",
      "files",
      "versions",
      "createdAt",
    ],
    "manifest"
  );
  if (m.formatVersion !== MANIFEST_FORMAT_VERSION) throw bad("formatVersion");
  exactKeys(m.workspace, ["name", "slug", "randomId"], "workspace");
  if (!nonEmptyStr(m.workspace.name) || !nonEmptyStr(m.workspace.slug))
    throw bad("workspace");
  if (!RID_RE.test(String(m.workspace.randomId))) throw bad("workspace");
  if (!posInt(m.versionId)) throw bad("versionId");
  exactKeys(
    m.embedder,
    ["modelId", "dimension", "normalization", "prefixes"],
    "embedder"
  );
  if (!nonEmptyStr(m.embedder.modelId) || !posInt(m.embedder.dimension))
    throw bad("embedder");
  if (typeof m.embedder.normalization !== "boolean") throw bad("embedder");
  exactKeys(m.embedder.prefixes, ["query", "document"], "prefixes");
  if (
    typeof m.embedder.prefixes.query !== "string" ||
    typeof m.embedder.prefixes.document !== "string"
  )
    throw bad("prefixes");
  exactKeys(m.chunking, ["chunkSize", "overlap"], "chunking");
  if (!posInt(m.chunking.chunkSize)) throw bad("chunking");
  if (!Number.isInteger(m.chunking.overlap) || m.chunking.overlap < 0)
    throw bad("chunking");
  if (!Number.isInteger(m.rowCount) || m.rowCount < 0) throw bad("rowCount");
  if (typeof m.vectorIdHash !== "string" || !HEX64.test(m.vectorIdHash))
    throw bad("vectorIdHash");
  if (!Array.isArray(m.files)) throw bad("files");
  for (const f of m.files) {
    exactKeys(f, ["path", "size", "sha256"], "files");
    if (!safeRelPath(f.path)) throw bad("files");
    if (!Number.isInteger(f.size) || f.size < 0) throw bad("files");
    if (typeof f.sha256 !== "string" || !HEX64.test(f.sha256))
      throw bad("files");
  }
  exactKeys(m.versions, ["lancedb", "app"], "versions");
  if (!nonEmptyStr(m.versions.lancedb) || !nonEmptyStr(m.versions.app))
    throw bad("versions");
  if (!nonEmptyStr(m.createdAt) || Number.isNaN(Date.parse(m.createdAt)))
    throw bad("createdAt");
  return Object.freeze(m);
}

function buildManifest(fields) {
  const m = {
    formatVersion: MANIFEST_FORMAT_VERSION,
    workspace: fields.workspace,
    versionId: fields.versionId,
    embedder: fields.embedder,
    chunking: fields.chunking,
    rowCount: fields.rowCount,
    vectorIdHash: fields.vectorIdHash,
    files: fields.files,
    versions: fields.versions,
    createdAt: fields.createdAt || new Date().toISOString(),
  };
  return validateManifest(m);
}

module.exports = {
  buildManifest,
  validateManifest,
  MANIFEST_FORMAT_VERSION,
  newRandomId,
  releaseTag,
};
