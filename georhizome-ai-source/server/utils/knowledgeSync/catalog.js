const { KnowledgeSyncError } = require("./errors");

const CATALOG_ASSET_NAME = "catalog.bin";
const RID_RE = /^[0-9a-f]{8}$/;
const TAG_RE = /^ks-([0-9a-f]{8})-v(\d+)$/;
const ENTRY_KEYS = [
  "name",
  "slug",
  "randomId",
  "latestVersion",
  "maxVersion",
  "versions",
];
const VERSION_KEYS = [
  "version",
  "tag",
  "parts",
  "sizeBytes",
  "docCount",
  "publishedAt",
];
const bad = (phase) => new KnowledgeSyncError("KS_E_MANIFEST", { phase });
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
const posInt = (n) => Number.isSafeInteger(n) && n >= 1;
const nonNegInt = (n) => Number.isSafeInteger(n) && n >= 0;

function exactKeys(o, keys, phase) {
  if (!isObj(o)) throw bad(phase);
  const ks = Object.keys(o);
  if (ks.length !== keys.length || !keys.every((k) => ks.includes(k)))
    throw bad(phase);
}

function validateVersionRec(v, randomId) {
  exactKeys(v, VERSION_KEYS, "version");
  if (!posInt(v.version)) throw bad("version");
  const m = typeof v.tag === "string" ? v.tag.match(TAG_RE) : null;
  if (!m || m[1] !== randomId || Number(m[2]) !== v.version) throw bad("tag");
  if (!posInt(v.parts)) throw bad("version");
  if (!nonNegInt(v.sizeBytes) || !nonNegInt(v.docCount)) throw bad("version");
  if (
    typeof v.publishedAt !== "string" ||
    Number.isNaN(Date.parse(v.publishedAt))
  )
    throw bad("version");
}

function validateEntryCommon(e, seen) {
  if (typeof e.name !== "string" || !e.name) throw bad("entry");
  if (typeof e.slug !== "string" || !e.slug) throw bad("entry");
  if (!RID_RE.test(String(e.randomId)) || seen.has(e.randomId))
    throw bad("entry");
  seen.add(e.randomId);
}

function validateEntryV2(e) {
  if (!nonNegInt(e.latestVersion) || !posInt(e.maxVersion)) throw bad("entry");
  if (e.maxVersion < e.latestVersion) throw bad("entry");
  if (!Array.isArray(e.versions)) throw bad("entry");
  if (e.versions.length === 0) {
    if (e.latestVersion !== 0) throw bad("entry");
    return;
  }
  let prev = 0;
  for (const v of e.versions) {
    validateVersionRec(v, e.randomId);
    if (v.version <= prev) throw bad("versions");
    prev = v.version;
  }
  if (e.latestVersion !== prev || e.maxVersion < prev) throw bad("entry");
}

function deepFreeze(o) {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const k of Object.keys(o)) deepFreeze(o[k]);
  }
  return o;
}

/** Accepts formatVersion 1 or 2; always returns a frozen v2 shape. */
function validateCatalog(c) {
  exactKeys(c, ["formatVersion", "entries"], "catalog");
  if (c.formatVersion !== 1 && c.formatVersion !== 2)
    throw bad("formatVersion");
  if (!Array.isArray(c.entries)) throw bad("entries");
  const seen = new Set();
  const out = [];
  for (const e of c.entries) {
    if (c.formatVersion === 1) {
      exactKeys(e, ["name", "slug", "randomId", "latestVersion"], "entry");
      validateEntryCommon(e, seen);
      if (!posInt(e.latestVersion)) throw bad("entry");
      out.push({
        name: e.name,
        slug: e.slug,
        randomId: e.randomId,
        latestVersion: e.latestVersion,
        maxVersion: e.latestVersion,
        versions: [],
      });
    } else {
      exactKeys(e, ENTRY_KEYS, "entry");
      validateEntryCommon(e, seen);
      validateEntryV2(e);
      out.push({
        name: e.name,
        slug: e.slug,
        randomId: e.randomId,
        latestVersion: e.latestVersion,
        maxVersion: e.maxVersion,
        versions: e.versions.map((v) => ({ ...v })),
      });
    }
  }
  return deepFreeze({ formatVersion: 2, entries: out });
}

function buildCatalog(entries) {
  return validateCatalog({ formatVersion: 2, entries });
}

const findIdx = (cat, key) =>
  cat.entries.findIndex((e) => e.randomId === key || e.slug === key);

/** Returns a new catalog with versionRec added (entry created if absent). */
function addVersion(catalog, entryMeta, versionRec) {
  const entries = catalog.entries.map((e) => ({
    ...e,
    versions: e.versions.map((v) => ({ ...v })),
  }));
  let e = entries.find((x) => x.randomId === entryMeta.randomId);
  if (!e) {
    e = {
      name: entryMeta.name,
      slug: entryMeta.slug,
      randomId: entryMeta.randomId,
      latestVersion: 0,
      maxVersion: 0,
      versions: [],
    };
    entries.push(e);
  } else {
    e.name = entryMeta.name;
    e.slug = entryMeta.slug;
  }
  e.versions = e.versions.filter((v) => v.version !== versionRec.version);
  e.versions.push({ ...versionRec });
  e.versions.sort((a, b) => a.version - b.version);
  e.latestVersion = e.versions[e.versions.length - 1].version;
  e.maxVersion = Math.max(e.maxVersion, e.latestVersion);
  return buildCatalog(entries);
}

/** Removes a version; the entry stays as a tombstone when none remain. */
function removeVersion(catalog, slugOrRid, version) {
  const i = findIdx(catalog, slugOrRid);
  if (i < 0) throw new KnowledgeSyncError("KS_E_NOT_FOUND");
  const entries = catalog.entries.map((e) => ({
    ...e,
    versions: e.versions.map((v) => ({ ...v })),
  }));
  const e = entries[i];
  e.versions = e.versions.filter((v) => v.version !== version);
  e.latestVersion = e.versions.length
    ? e.versions[e.versions.length - 1].version
    : 0;
  return buildCatalog(entries);
}

/** Next version number for an entry; never reuses a removed number. */
function getNextVersion(catalog, slugOrRid) {
  const i = findIdx(catalog, slugOrRid);
  return i < 0 ? 1 : catalog.entries[i].maxVersion + 1;
}

module.exports = {
  buildCatalog,
  validateCatalog,
  addVersion,
  removeVersion,
  getNextVersion,
  CATALOG_ASSET_NAME,
};
