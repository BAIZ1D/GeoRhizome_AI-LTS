const { KnowledgeSyncError, isKnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const {
  validateCatalog,
  buildCatalog,
  CATALOG_ASSET_NAME,
} = require("./catalog");
const { safeLog } = require("./redact");

// Server-side catalog status cache (D-15). Co-worker reads are token-free:
// github.com download URLs only, never api.github.com (D-16).
let cache = null; // { value, at }
let inflight = null;
let semaphore = null;

const LOADERS = {
  now: () => () => Date.now(),
  secrets: () => require("./secrets"),
  github: () => require("./github"),
  marker: () => require("./marker"),
  crypto: () => require("./crypto"),
  transport: () => require("./transport"),
};
let overrides = {};
// Lazy per key: requiring ./secrets pulls in the encryption manager.
const deps = () =>
  new Proxy(overrides, {
    get: (o, k) =>
      k in o ? o[k] : LOADERS[k] ? (o[k] = LOADERS[k]()) : undefined,
  });

function sem(d) {
  if (d.semaphore) return d.semaphore;
  return (semaphore ||= d.transport.cryptoSemaphore(1));
}

async function decodeCatalog(buffer, passphrase, d, cfg) {
  const plain = await sem(d).run(() =>
    d.crypto.decryptBuffer(buffer, passphrase, { kind: "catalog", config: cfg })
  );
  let json;
  try {
    json = JSON.parse(plain.toString("utf8"));
  } catch {
    throw new KnowledgeSyncError("KS_E_CATALOG", { phase: "catalog" });
  }
  return validateCatalog(json);
}

async function withLocal(catalog, d) {
  const localVersions = {};
  const entries = [];
  for (const e of catalog.entries) {
    const m = await d.marker.readMarker(e.slug);
    const local =
      m && m.sourceRandomId === e.randomId && Number.isFinite(m.versionId)
        ? m.versionId
        : null;
    if (local !== null) localVersions[e.slug] = local;
    entries.push({
      slug: e.slug,
      name: e.name,
      randomId: e.randomId,
      latestVersion: e.latestVersion,
      maxVersion: e.maxVersion,
      versions: e.versions.map((v) => ({ ...v })),
      localVersion: local,
      updateAvailable: local !== null && e.latestVersion > local,
    });
  }
  return { entries, localVersions };
}

const toError = (err) => ({
  code:
    isKnowledgeSyncError(err) && err.code === "KS_E_PASSPHRASE"
      ? "KS_E_PASSPHRASE"
      : "KS_E_CATALOG",
  message: new KnowledgeSyncError(
    isKnowledgeSyncError(err) && err.code === "KS_E_PASSPHRASE"
      ? "KS_E_PASSPHRASE"
      : "KS_E_CATALOG"
  ).message,
});

async function fetchFresh(d, cfg, passphrase, signal) {
  const hint = d.github.readCatalogSeqHint();
  const found = await d.github.fetchPublicCatalog({
    signal,
    startSeq: hint,
    config: cfg,
  });
  const catalog = await decodeCatalog(found.buffer, passphrase, d, cfg);
  return withLocal(catalog, d);
}

async function getCatalogStatus({ force = false, signal } = {}) {
  const d = deps();
  const status = await d.secrets.passphraseStatus();
  if (!status || !status.configured)
    return {
      configured: false,
      checkedAt: null,
      stale: false,
      error: null,
      entries: [],
      localVersions: {},
    };
  const cfg = getKnowledgeSyncConfig();
  const nowMs = d.now();
  if (!force && cache && nowMs - cache.at < cfg.catalog_cache_ttl_ms)
    return { ...cache.value, stale: false };
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const passphrase = await d.secrets.getPassphrase();
      if (!passphrase) throw new KnowledgeSyncError("KS_E_PASSPHRASE");
      const { entries, localVersions } = await fetchFresh(
        d,
        cfg,
        passphrase,
        signal
      );
      const value = {
        configured: true,
        checkedAt: new Date(d.now()).toISOString(),
        stale: false,
        error: null,
        entries,
        localVersions,
      };
      cache = { value, at: d.now() };
      return value;
    } catch (err) {
      if (
        isKnowledgeSyncError(err) &&
        err.code === "KS_E_CATALOG" &&
        err.phase === "empty"
      ) {
        const value = {
          configured: true,
          checkedAt: new Date(d.now()).toISOString(),
          stale: false,
          error: null,
          entries: [],
          localVersions: {},
        };
        cache = { value, at: d.now() };
        return value;
      }
      safeLog("warn", "catalog fetch failed", { code: err && err.code });
      const error = toError(err);
      if (cache)
        return { ...cache.value, stale: true, error, configured: true };
      return {
        configured: true,
        checkedAt: null,
        stale: false,
        error,
        entries: [],
        localVersions: {},
      };
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const refresh = (opts = {}) => getCatalogStatus({ ...opts, force: true });

function invalidate() {
  cache = null;
}

/**
 * Publish-side read (admin, PAT): lists catalog releases with the token to
 * find the highest published seq, then reads it. Bypasses the cache.
 * Returns { catalog, seq } (empty catalog, seq 0 when none published).
 */
async function readCatalogAuthoritative({ signal, client } = {}) {
  const d = deps();
  const cfg = getKnowledgeSyncConfig();
  const gh =
    client || d.githubClient || d.github.createGithubClient({ config: cfg });
  const prefix = cfg.catalog_tag_prefix;
  const pub = (await gh.listReleasesByTagPrefix(prefix, { signal }))
    .filter((r) => r.draft !== true)
    .map((r) => ({
      tag: r.tag_name,
      seq: Number(String(r.tag_name).slice(prefix.length)),
    }))
    .filter((r) => Number.isInteger(r.seq) && r.seq >= 1)
    .sort((a, b) => b.seq - a.seq);
  if (!pub.length) return { catalog: buildCatalog([]), seq: 0 };
  const passphrase = await d.secrets.getPassphrase();
  if (!passphrase) throw new KnowledgeSyncError("KS_E_PASSPHRASE");
  const buffer = await d.github.fetchPublicAsset(
    pub[0].tag,
    CATALOG_ASSET_NAME,
    { signal, config: cfg }
  );
  return {
    catalog: await decodeCatalog(buffer, passphrase, d, cfg),
    seq: pub[0].seq,
  };
}

function _setDepsForTests(o = {}) {
  overrides = o;
  cache = null;
  inflight = null;
  semaphore = null;
}

module.exports = {
  getCatalogStatus,
  refresh,
  invalidate,
  readCatalogAuthoritative,
  _setDepsForTests,
};
