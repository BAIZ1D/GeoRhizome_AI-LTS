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
  /** Free-space multiple of archive size required before import/export. */
  disk_preflight_factor: 3,
  /** Backup directory name under STORAGE_DIR. */
  backup_dir_name: "knowledge-sync-backup",
  /** Orphan staging age (hours) before cleanup. */
  stale_staging_hours: 24,
  /** Import preview validity (minutes). */
  preview_ttl_minutes: 60,
  /** Prisma interactive transaction timeout (ms). */
  import_tx_timeout_ms: 60000,
  /** Prisma transaction max wait (ms). */
  import_tx_max_wait_ms: 10000,
});

function candidatePaths() {
  return [
    "/config/app_config.json",
    path.resolve(__dirname, "../../../../config/app_config.json"),
  ];
}

const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const posNum = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
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
    } catch {
      console.warn(
        "[KnowledgeSync] config unreadable or invalid; using defaults"
      );
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
  const ks =
    raw && typeof raw.knowledge_sync === "object" ? raw.knowledge_sync : null;
  const sc =
    ks && typeof ks.scrypt === "object" && ks.scrypt ? ks.scrypt : null;
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
    passphrase_min_length: pick(
      ks,
      "passphrase_min_length",
      D.passphrase_min_length,
      posInt
    ),
    catalog_release_tag: pick(
      ks,
      "catalog_release_tag",
      D.catalog_release_tag,
      str
    ),
    staging_dir_name: pick(ks, "staging_dir_name", D.staging_dir_name, str),
    max_extract_bytes: pick(
      ks,
      "max_extract_bytes",
      D.max_extract_bytes,
      posInt
    ),
    max_entries: pick(ks, "max_entries", D.max_entries, posInt),
    disk_preflight_factor: pick(
      ks,
      "disk_preflight_factor",
      D.disk_preflight_factor,
      posNum
    ),
    backup_dir_name: pick(ks, "backup_dir_name", D.backup_dir_name, str),
    stale_staging_hours: pick(
      ks,
      "stale_staging_hours",
      D.stale_staging_hours,
      posInt
    ),
    preview_ttl_minutes: pick(
      ks,
      "preview_ttl_minutes",
      D.preview_ttl_minutes,
      posInt
    ),
    import_tx_timeout_ms: pick(
      ks,
      "import_tx_timeout_ms",
      D.import_tx_timeout_ms,
      posInt
    ),
    import_tx_max_wait_ms: pick(
      ks,
      "import_tx_max_wait_ms",
      D.import_tx_max_wait_ms,
      posInt
    ),
  };
  cfg.allowedScryptParams = [{ N: scrypt.N, r: scrypt.r, p: scrypt.p }];
  cfg.allowedChunkSizes = [cfg.chunk_size_bytes];
  return cfg;
}

module.exports = { getKnowledgeSyncConfig, DEFAULTS };
