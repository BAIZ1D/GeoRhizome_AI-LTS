const { KnowledgeSyncError } = require("./errors");
const { MANIFEST_FORMAT_VERSION } = require("./manifest");

const RELEASE_BODY =
  "Encrypted GeoRhizome knowledge archive. Not usable without the team passphrase.";
const INDEX_ASSET_NAME = "index.json";
const PREVIEW_ASSET_NAME = "preview.bin";
const HEX64 = /^[0-9a-f]{64}$/;
const PART_RE = /^part-\d{4}\.bin$/;

const bad = (phase) => new KnowledgeSyncError("KS_E_MANIFEST", { phase });
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);

function exactKeys(o, keys, phase) {
  if (!isObj(o)) throw bad(phase);
  const ks = Object.keys(o);
  if (ks.length !== keys.length || !keys.every((k) => ks.includes(k)))
    throw bad(phase);
}

function validatePublicIndex(idx) {
  exactKeys(
    idx,
    [
      "formatVersion",
      "versionId",
      "embedder",
      "parts",
      "totalSize",
      "createdAt",
    ],
    "index"
  );
  if (idx.formatVersion !== MANIFEST_FORMAT_VERSION) throw bad("formatVersion");
  if (!Number.isInteger(idx.versionId) || idx.versionId < 1)
    throw bad("versionId");
  exactKeys(idx.embedder, ["id", "dimension"], "embedder");
  if (typeof idx.embedder.id !== "string" || !idx.embedder.id)
    throw bad("embedder");
  if (!Number.isInteger(idx.embedder.dimension) || idx.embedder.dimension < 1)
    throw bad("embedder");
  if (!Array.isArray(idx.parts)) throw bad("parts");
  let sum = 0;
  for (const p of idx.parts) {
    exactKeys(p, ["name", "size", "sha256"], "parts");
    if (!PART_RE.test(String(p.name))) throw bad("parts");
    if (!Number.isInteger(p.size) || p.size < 0) throw bad("parts");
    if (!HEX64.test(String(p.sha256))) throw bad("parts");
    sum += p.size;
  }
  if (idx.totalSize !== sum) throw bad("totalSize");
  if (
    typeof idx.createdAt !== "string" ||
    Number.isNaN(Date.parse(idx.createdAt))
  )
    throw bad("createdAt");
  return Object.freeze(idx);
}

// parts: [{size, sha256}] or [{name,size,sha256}]; names are regenerated opaque.
function buildPublicIndex(manifest, parts) {
  const out = (parts || []).map((p, i) => ({
    name: `part-${String(i + 1).padStart(4, "0")}.bin`,
    size: p.size,
    sha256: p.sha256,
  }));
  const idx = {
    formatVersion: manifest.formatVersion,
    versionId: manifest.versionId,
    embedder: {
      id: manifest.embedder.modelId,
      dimension: manifest.embedder.dimension,
    },
    parts: out,
    totalSize: out.reduce((a, p) => a + p.size, 0),
    createdAt: manifest.createdAt,
  };
  return validatePublicIndex(idx);
}

function validatePreviewPayload(p) {
  exactKeys(p, ["manifest", "docs"], "preview");
  if (!isObj(p.manifest)) throw bad("preview");
  if (!Array.isArray(p.docs)) throw bad("preview");
  for (const d of p.docs) {
    exactKeys(d, ["docId", "filename", "docpath"], "preview");
    for (const k of ["docId", "filename", "docpath"])
      if (typeof d[k] !== "string" || !d[k]) throw bad("preview");
  }
  return Object.freeze(p);
}

module.exports = {
  buildPublicIndex,
  validatePublicIndex,
  validatePreviewPayload,
  INDEX_ASSET_NAME,
  PREVIEW_ASSET_NAME,
  RELEASE_BODY,
};
