const fs = require("fs");
const path = require("path");

/**
 * Documented fallbacks for config/app_config.json `knowledge_sync`.
 * Decryption authenticates every chunk BEFORE extraction runs, so
 * max_extract_bytes guards an authenticated-but-oversized archive.
 */
const DEFAULTS = Object.freeze({
  /** GitHub repo hosting knowledge releases. */
  repo: "BAIZ1D/GeoRhizome_AI-LTS",
  /** Max bytes per uploaded archive part (1 GiB). */
  part_size_bytes: 1073741824,
  /** Plaintext bytes per encrypted chunk (1 MiB). */
  chunk_size_bytes: 1048576,
  scrypt: Object.freeze({
    /** CPU/memory cost. */
    N: 131072,
    r: 8,
    p: 1,
    /** scrypt maxmem (256 MiB). */
    maxmem_bytes: 268435456,
    salt_bytes: 16,
  }),
  /** Minimum passphrase length. */
  passphrase_min_length: 12,
  /** Opaque catalog release tag. */
  catalog_release_tag: "ks-catalog-0001",
  /** Staging directory name under STORAGE_DIR. */
  staging_dir_name: "knowledge-sync-staging",
  /** Extraction byte bound (4 x part size). */
  max_extract_bytes: 4294967296,
  /** Max archive entries. */
  max_entries: 200000,
});

function candidatePaths() {
  return [
    "/config/app_config.json",
    path.resolve(__dirname, "../../../../config/app_config.json"),
  ];
}

const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const str = (v) => typeof v === "string" && v.trim().length > 0;

function pick(src, key, def, ok) {
  return src && ok(src[key]) ? src[key] : def;
}

function readRaw(configPath) {
  const list = configPath ? [configPath] : candidatePaths();
  for (const p of list) {
    try {
      if (!fs.existsSync(p)) continue;
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (_e) {
      console.warn("[KnowledgeSync] config unreadable or invalid; using defaults");
      return null;
    }
  }
  return null;
}

/**
 * Loads knowledge_sync settings, re-read on every call, per-field fallback.
 */
function getKnowledgeSyncConfig({ configPath } = {}) {
  const raw = readRaw(configPath);
  const ks = raw && typeof raw.knowledge_sync === "object" ? raw.knowledge_sync : null;
  const sc = ks && typeof ks.scrypt === "object" && ks.scrypt ? ks.scrypt : null;
  const D = DEFAULTS;
  const scrypt = {
    N: pick(sc, "N", D.scrypt.N, posInt),
    r: pick(sc, "r", D.scrypt.r, posInt),
    p: pick(sc, "p", D.scrypt.p, posInt),
    maxmem_bytes: pick(sc, "maxmem_bytes", D.scrypt.maxmem_bytes, posInt),
    salt_bytes: pick(sc, "salt_bytes", D.scrypt.salt_bytes, posInt),
  };
  const cfg = {
    repo: pick(ks, "repo", D.repo, str),
    part_size_bytes: pick(ks, "part_size_bytes", D.part_size_bytes, posInt),
    chunk_size_bytes: pick(ks, "chunk_size_bytes", D.chunk_size_bytes, posInt),
    scrypt,
    passphrase_min_length: pick(ks, "passphrase_min_length", D.passphrase_min_length, posInt),
    catalog_release_tag: pick(ks, "catalog_release_tag", D.catalog_release_tag, str),
    staging_dir_name: pick(ks, "staging_dir_name", D.staging_dir_name, str),
    max_extract_bytes: pick(ks, "max_extract_bytes", D.max_extract_bytes, posInt),
    max_entries: pick(ks, "max_entries", D.max_entries, posInt),
  };
  cfg.allowedScryptParams = [{ N: scrypt.N, r: scrypt.r, p: scrypt.p }];
  cfg.allowedChunkSizes = [cfg.chunk_size_bytes];
  return cfg;
}

module.exports = { getKnowledgeSyncConfig, DEFAULTS };
