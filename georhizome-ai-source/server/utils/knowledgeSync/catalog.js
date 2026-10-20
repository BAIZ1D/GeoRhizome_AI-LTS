const { KnowledgeSyncError } = require("./errors");

const CATALOG_ASSET_NAME = "catalog.bin";
const RID_RE = /^[0-9a-f]{8}$/;
const bad = (phase) => new KnowledgeSyncError("KS_E_MANIFEST", { phase });
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);

function exactKeys(o, keys, phase) {
  if (!isObj(o)) throw bad(phase);
  const ks = Object.keys(o);
  if (ks.length !== keys.length || !keys.every((k) => ks.includes(k)))
    throw bad(phase);
}

function validateCatalog(c) {
  exactKeys(c, ["formatVersion", "entries"], "catalog");
  if (c.formatVersion !== 1) throw bad("formatVersion");
  if (!Array.isArray(c.entries)) throw bad("entries");
  const seen = new Set();
  for (const e of c.entries) {
    exactKeys(e, ["name", "slug", "randomId", "latestVersion"], "entry");
    if (typeof e.name !== "string" || !e.name) throw bad("entry");
    if (typeof e.slug !== "string" || !e.slug) throw bad("entry");
    if (!RID_RE.test(String(e.randomId)) || seen.has(e.randomId))
      throw bad("entry");
    seen.add(e.randomId);
    if (!Number.isInteger(e.latestVersion) || e.latestVersion < 1)
      throw bad("entry");
  }
  return Object.freeze(c);
}

function buildCatalog(entries) {
  return validateCatalog({ formatVersion: 1, entries });
}

module.exports = { buildCatalog, validateCatalog, CATALOG_ASSET_NAME };
