const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const { stagingRoot, exportsDir, assertWithin } = require("./paths");
const { requireFreeSpace } = require("./preflight");
const {
  validatePublicIndex,
  validatePreviewPayload,
  INDEX_ASSET_NAME,
  PREVIEW_ASSET_NAME,
} = require("./publicIndex");
const { releaseTag } = require("./manifest");
const { reassemble, cryptoSemaphore } = require("./transport");
const { decryptBuffer } = require("./crypto");
const releases = require("./releases");

// Lazy: these pull in prisma / the encryption manager.
const LOAD = {
  getPassphrase: () => require("./secrets").getPassphrase,
  getCatalogStatus: () => require("./catalogCache").getCatalogStatus,
  fetchPublicAsset: () => require("./github").fetchPublicAsset,
  downloadPart: () => require("./github").downloadPart,
  effectiveEmbedder: () => require("./embedder").effectiveEmbedder,
  previewFromManifest: () => require("./preview").previewFromManifest,
  previewImport: () => require("./preview").previewImport,
  confirmImport: () => require("./importer").confirmImport,
  discardStaged: () => require("./stage").discardStaged,
  rollbackWorkspace: () => require("./rollback").rollbackWorkspace,
};
const dep = (deps, k) => (deps && deps[k]) || LOAD[k]();
const err = (code, phase) => new KnowledgeSyncError(code, { phase });
const sem = cryptoSemaphore(1);
const rmrf = (p) =>
  fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});

/** Publish (XFER-02): delegates to releases.publishWorkspace. */
function publishRunner(args = {}) {
  return releases.publishWorkspace(args);
}

function parseJson(buf, code, phase) {
  try {
    return JSON.parse(Buffer.from(buf).toString("utf8"));
  } catch {
    throw err(code, phase);
  }
}

// C1/D-19: everything here uses token-free reads of small public assets.
async function previewPhase({ entry, version, passphrase, ctx, cfg, deps }) {
  const rec = version
    ? entry.versions.find((v) => v.version === version)
    : null;
  const n = version || entry.latestVersion;
  if (!n || (version && !rec && entry.versions.length))
    throw err("KS_E_NOT_FOUND", "preview");
  const tag = rec ? rec.tag : releaseTag(entry.randomId, n);
  const fetchAsset = dep(deps, "fetchPublicAsset");
  const opts = { signal: ctx.signal, config: cfg };
  const index = validatePublicIndex(
    parseJson(
      await fetchAsset(tag, INDEX_ASSET_NAME, opts),
      "KS_E_MANIFEST",
      "index"
    )
  );
  if (index.totalSize > cfg.max_extract_bytes)
    throw err("KS_E_SIZE_LIMIT", "preview");
  if (index.parts.some((p) => p.size > cfg.part_size_bytes))
    throw err("KS_E_SIZE_LIMIT", "preview");
  const local = dep(deps, "effectiveEmbedder")();
  if (index.embedder.id !== local.modelId)
    throw err("KS_E_EMBEDDER_MISMATCH", "preview");
  if (index.embedder.dimension !== local.dimension)
    throw err("KS_E_DIM_MISMATCH", "preview");
  const enc = await fetchAsset(tag, PREVIEW_ASSET_NAME, opts);
  const plain = await sem.run(() =>
    decryptBuffer(enc, passphrase, { kind: "catalog", config: cfg })
  );
  const payload = validatePreviewPayload(
    parseJson(plain, "KS_E_MANIFEST", "preview")
  );
  if (payload.manifest.versionId !== index.versionId)
    throw err("KS_E_MANIFEST", "preview");
  const result = await dep(
    deps,
    "previewFromManifest"
  )({
    manifest: payload.manifest,
    docs: payload.docs,
    indexTotalSize: index.totalSize,
  });
  return { tag, index, result, rid: entry.randomId, version: n };
}

async function syncRunner({
  slug,
  userId,
  ctx,
  passphrase: givenPass,
  accessCtx = {},
  version,
  deps,
  config,
} = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const passphrase = givenPass || (await dep(deps, "getPassphrase")());
  if (!passphrase) throw err("KS_E_PASSPHRASE", "preflight");

  // (1) preview, before any part download.
  ctx.setPhase("preview");
  const status = await dep(deps, "getCatalogStatus")();
  const entry = status && (status.entries || []).find((e) => e.slug === slug);
  if (!entry) throw err("KS_E_NOT_FOUND", "preview");
  const pv = await previewPhase({
    entry,
    version,
    passphrase,
    ctx,
    cfg,
    deps,
  });
  ctx.setPreview(pv.result);
  const blockers = (pv.result.blocking || []).filter(
    (c) => !(c === "KS_E_TARGET_UNSYNCED" && accessCtx.allowUnsynced)
  );
  if (blockers.length) throw err(blockers[0], "preview");
  ctx.throwIfCancelled();
  await ctx.awaitConfirm();

  const staging = stagingRoot({ config: cfg });
  const dlDir = path.join(staging, `dl-${pv.rid}-v${pv.version}`);
  assertWithin(staging, dlDir);
  const archiveName = `sync-${uuidv4()}.grks`;
  const archivePath = path.join(exportsDir({ config: cfg }), archiveName);
  let previewId = null;
  let confirmed = false;
  try {
    // (2) download parts token-free; retry resumes the same directory.
    ctx.setPhase("download");
    ctx.throwIfCancelled();
    await requireFreeSpace(staging, pv.index.totalSize, { config: cfg });
    let got = 0;
    const download = dep(deps, "downloadPart");
    try {
      for (const part of pv.index.parts) {
        ctx.throwIfCancelled();
        await download(pv.tag, part, dlDir, {
          signal: ctx.signal,
          config: cfg,
          onBytes: (b) => {
            got += b;
            if (pv.index.totalSize)
              ctx.setPercent((got / pv.index.totalSize) * 100);
          },
        });
      }
    } catch (e) {
      if (e && e.code === "KS_E_CANCELLED") await rmrf(dlDir);
      throw e;
    }

    // (3) verify: reassemble, full previewImport, compare with confirmed.
    ctx.setPhase("verify");
    ctx.throwIfCancelled();
    await fs.promises.mkdir(exportsDir({ config: cfg }), { recursive: true });
    await reassemble(dlDir, pv.index.parts, archivePath, {
      signal: ctx.signal,
    });
    await rmrf(dlDir);
    const full = await sem.run(() =>
      dep(
        deps,
        "previewImport"
      )({ archiveName, passphrase, userId, config: cfg })
    );
    previewId = full.previewId;
    if (
      full.versionId !== pv.result.versionId ||
      JSON.stringify(full.compatibility) !==
        JSON.stringify(pv.result.compatibility)
    )
      throw err("KS_E_MANIFEST", "verify");

    // (4) import: no cancel from here. Server-side recheck still applies.
    ctx.setPhase("import");
    confirmed = true;
    return await dep(
      deps,
      "confirmImport"
    )({ previewId, userId, ...accessCtx, passphrase });
  } catch (e) {
    if (previewId && !confirmed)
      await dep(deps, "discardStaged")(previewId, { config: cfg }).catch(
        () => {}
      );
    throw e;
  } finally {
    await fs.promises.rm(archivePath, { force: true }).catch(() => {});
  }
}

async function rollbackRunner({
  slug,
  userId,
  ctx,
  accessCtx = {},
  deps,
  config,
} = {}) {
  ctx.setPhase("verify");
  ctx.throwIfCancelled();
  ctx.setPhase("import");
  return dep(deps, "rollbackWorkspace")({ slug, userId, ...accessCtx, config });
}

module.exports = { publishRunner, syncRunner, rollbackRunner };
