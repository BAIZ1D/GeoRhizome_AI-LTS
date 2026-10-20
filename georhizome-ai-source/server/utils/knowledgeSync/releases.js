const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const { stagingRoot, assertWithin } = require("./paths");
const { requireFreeSpace } = require("./preflight");
const {
  buildCatalog,
  validateCatalog,
  addVersion,
  removeVersion,
  CATALOG_ASSET_NAME,
} = require("./catalog");
const {
  buildPublicIndex,
  validatePreviewPayload,
  INDEX_ASSET_NAME,
  PREVIEW_ASSET_NAME,
  RELEASE_BODY,
} = require("./publicIndex");
const { releaseTag } = require("./manifest");
const { splitFile, cryptoSemaphore } = require("./transport");
const { encryptBuffer, decryptBuffer } = require("./crypto");
const { safeLog } = require("./redact");
const locks = require("./locks");
const { createGithubClient } = require("./github");

// Lazy: these pull in prisma / the encryption manager.
const LOAD = {
  exportWorkspace: () => require("./exporter").exportWorkspace,
  getOrCreateRandomId: () => require("./workspaceId").getOrCreateRandomId,
  getRandomId: () => require("./workspaceId").getRandomId,
  getPassphrase: () => require("./secrets").getPassphrase,
  getPat: () => require("./secrets").getPat,
  getWorkspace: () => (slug) =>
    require("../../models/workspace").Workspace.get({ slug }),
  fetchPublicAsset: () => require("./github").fetchPublicAsset,
};
const dep = (deps, k) => (deps && deps[k]) || LOAD[k]();

const sem = cryptoSemaphore(1);
const noop = () => {};
const err = (code, phase) => new KnowledgeSyncError(code, { phase });

// B1: process-wide promise-chain mutex around the whole
// read-latest-catalog -> modify -> publish ks-catalog-<seq+1> sequence.
let catalogChain = Promise.resolve();
function catalogMutex(fn) {
  const p = catalogChain.then(() => fn());
  catalogChain = p.then(noop, noop);
  return p;
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function readLatestCatalog({ client, deps, config, passphrase, signal }) {
  const cfg = config || getKnowledgeSyncConfig();
  const prefix = cfg.catalog_tag_prefix;
  const pub = (await client.listReleasesByTagPrefix(prefix, { signal }))
    .filter((r) => r.draft !== true)
    .map((r) => ({
      tag: r.tag_name,
      seq: Number(String(r.tag_name).slice(prefix.length)),
    }))
    .filter((r) => Number.isInteger(r.seq) && r.seq >= 1)
    .sort((a, b) => b.seq - a.seq);
  if (!pub.length) return { catalog: buildCatalog([]), seq: 0 };
  const buf = await dep(deps, "fetchPublicAsset")(
    pub[0].tag,
    CATALOG_ASSET_NAME,
    { signal, config: cfg }
  );
  const plain = await sem.run(() =>
    decryptBuffer(buf, passphrase, { kind: "catalog", config: cfg })
  );
  let json;
  try {
    json = JSON.parse(plain.toString("utf8"));
  } catch {
    throw err("KS_E_CATALOG", "catalog");
  }
  return { catalog: validateCatalog(json), seq: pub[0].seq };
}

/** Encrypts the catalog and publishes it as a NEW ks-catalog-<seq> release. */
async function publishCatalog({ client, catalog, passphrase, config, signal }) {
  const cfg = config || getKnowledgeSyncConfig();
  const enc = await sem.run(() =>
    encryptBuffer(Buffer.from(JSON.stringify(catalog)), passphrase, {
      kind: "catalog",
      config: cfg,
    })
  );
  const dir = path.join(stagingRoot({ config: cfg }), `cat-${uuidv4()}`);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    const file = path.join(dir, CATALOG_ASSET_NAME);
    await fs.promises.writeFile(file, enc);
    return await client.publishCatalogRelease(file, { signal });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** N = max(maxVersion, latestVersion, every ks-<rid>-v* tag incl. drafts) + 1;
 * the maxVersion tombstone keeps a deleted number from ever being reused. */
async function nextVersion(client, entry, randomId, { signal } = {}) {
  let max = Math.max(
    entry ? entry.maxVersion || 0 : 0,
    entry ? entry.latestVersion || 0 : 0
  );
  if (randomId) {
    const re = new RegExp(`^ks-${escRe(randomId)}-v(\\d+)$`);
    const rels = await client.listReleasesByTagPrefix(`ks-${randomId}-v`, {
      signal,
    });
    for (const r of rels) {
      const m = String(r.tag_name).match(re);
      if (m && Number(m[1]) > max) max = Number(m[1]);
    }
  }
  return max + 1;
}

async function passphraseOf(passphrase, deps) {
  const p = passphrase || (await dep(deps, "getPassphrase")());
  if (!p) throw err("KS_E_PASSPHRASE", "preflight");
  return p;
}

async function publishWorkspace({
  slug,
  userId: _userId,
  ctx,
  client: givenClient,
  passphrase: givenPass,
  deps,
  config,
  onCatalogChanged = noop,
} = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const c = ctx || {};
  const cancelled = () => c.throwIfCancelled && c.throwIfCancelled();
  const passphrase = await passphraseOf(givenPass, deps);
  if (!givenClient && !(await dep(deps, "getPat")()))
    throw err("KS_E_NO_PAT", "preflight");
  const client = givenClient || createGithubClient({ config: cfg });
  const workspace = await dep(deps, "getWorkspace")(slug);
  if (!workspace) throw err("KS_E_NOT_FOUND", "preflight");
  const staging = stagingRoot({ config: cfg });
  const signal = c.signal;

  return locks.withWorkspaceLock(slug, "export", async () => {
    const rid = await dep(deps, "getOrCreateRandomId")(slug);
    const { catalog } = await readLatestCatalog({
      client,
      deps,
      config: cfg,
      passphrase,
      signal,
    });
    const entry = catalog.entries.find((e) => e.randomId === rid) || null;
    const N = await nextVersion(client, entry, rid, { signal });
    // D-13: stale drafts for this workspace only (never published ones).
    const stale = (
      await client.listReleasesByTagPrefix(`ks-${rid}-v`, { signal })
    ).filter((r) => r.draft === true);
    for (const r of stale) {
      await client.deleteRelease(r.id, { signal });
      await client.deleteTag(r.tag_name, { signal });
    }

    let archivePath = null;
    let partDir = null;
    let publishedId = null;
    const tag = releaseTag(rid, N);
    try {
      cancelled();
      const exp = await dep(
        deps,
        "exportWorkspace"
      )({
        slug,
        passphrase,
        config: cfg,
        versionId: N,
        overwrite: true,
        lockHeld: true,
        onPhase: (p) => c.setPhase && c.setPhase(p),
        signal,
      });
      archivePath = exp.archivePath;
      await requireFreeSpace(staging, exp.bytes, { config: cfg });
      partDir = path.join(staging, `pub-${rid}-v${N}-${uuidv4()}`);
      assertWithin(staging, partDir);
      const parts = await splitFile(archivePath, cfg.part_size_bytes, partDir, {
        signal,
      });
      const index = buildPublicIndex(exp.manifest, parts);
      const indexFile = path.join(partDir, INDEX_ASSET_NAME);
      await fs.promises.writeFile(indexFile, JSON.stringify(index));
      const payload = validatePreviewPayload({
        manifest: exp.manifest,
        docs: exp.docs,
      });
      const previewEnc = await sem.run(() =>
        encryptBuffer(Buffer.from(JSON.stringify(payload)), passphrase, {
          kind: "catalog",
          config: cfg,
        })
      );
      const previewFile = path.join(partDir, PREVIEW_ASSET_NAME);
      await fs.promises.writeFile(previewFile, previewEnc);

      cancelled();
      if (c.setPhase) c.setPhase("upload");
      const files = [
        ...parts.map((p) => ({
          name: p.name,
          file: path.join(partDir, p.name),
        })),
        { name: INDEX_ASSET_NAME, file: indexFile },
        { name: PREVIEW_ASSET_NAME, file: previewFile },
      ];
      let total = 0;
      for (const f of files) total += (await fs.promises.stat(f.file)).size;
      let sent = 0;
      const rel = await client.createDraftRelease(
        { tag, name: tag, body: RELEASE_BODY },
        { signal }
      );
      for (const f of files) {
        cancelled();
        await client.uploadAsset(rel.id, f.name, f.file, {
          signal,
          onBytes: (n) => {
            sent += n;
            if (c.setPercent && total) c.setPercent((sent / total) * 100);
          },
        });
      }
      await client.publishRelease(rel.id, { signal });
      publishedId = rel.id;

      // Catalog LAST, serialized process-wide (B1).
      const sizeBytes = exp.manifest.files.reduce((s, f) => s + f.size, 0);
      try {
        await catalogMutex(async () => {
          const latest = await readLatestCatalog({
            client,
            deps,
            config: cfg,
            passphrase,
            signal,
          });
          const next = addVersion(
            latest.catalog,
            { name: workspace.name, slug, randomId: rid },
            {
              version: N,
              tag,
              parts: parts.length,
              sizeBytes,
              docCount: exp.docs.length,
              publishedAt: new Date().toISOString(),
            }
          );
          await publishCatalog({
            client,
            catalog: next,
            passphrase,
            config: cfg,
            signal,
          });
        });
      } catch (e) {
        try {
          await client.deleteRelease(publishedId);
          await client.deleteTag(tag);
        } catch {
          safeLog("warn", "orphaned version release after catalog failure", {
            tag,
          });
        }
        throw e;
      }
      await onCatalogChanged();
      return { slug, versionId: N, tag, parts: parts.length };
    } finally {
      if (archivePath) await fs.promises.rm(archivePath, { force: true });
      if (partDir)
        await fs.promises.rm(partDir, { recursive: true, force: true });
    }
  });
}

async function deleteVersion({
  slug,
  version,
  client: givenClient,
  passphrase: givenPass,
  deps,
  config,
  signal,
  onCatalogChanged = noop,
} = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const passphrase = await passphraseOf(givenPass, deps);
  const client = givenClient || createGithubClient({ config: cfg });
  return locks.withWorkspaceLock(slug, "export", async () => {
    let tag = null;
    await catalogMutex(async () => {
      const { catalog } = await readLatestCatalog({
        client,
        deps,
        config: cfg,
        passphrase,
        signal,
      });
      const entry = catalog.entries.find(
        (e) => e.slug === slug || e.randomId === slug
      );
      if (!entry || !entry.versions.some((v) => v.version === version))
        throw err("KS_E_NOT_FOUND", "delete");
      tag = releaseTag(entry.randomId, version);
      // Catalog FIRST (D-11 fallback via removeVersion), as a new release.
      await publishCatalog({
        client,
        catalog: removeVersion(catalog, entry.randomId, version),
        passphrase,
        config: cfg,
        signal,
      });
    });
    await onCatalogChanged();
    const rel = await client.getReleaseByTag(tag, { signal });
    if (rel) await client.deleteRelease(rel.id, { signal });
    try {
      await client.deleteTag(tag, { signal });
    } catch {
      // Release Immutability may refuse tag removal; recorded, not fatal.
      safeLog("warn", "tag deletion refused", { tag });
    }
    return { slug, version, tag };
  });
}

async function listVersions({
  slug,
  client: givenClient,
  passphrase: givenPass,
  deps,
  config,
  signal,
} = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const passphrase = await passphraseOf(givenPass, deps);
  const client = givenClient || createGithubClient({ config: cfg });
  const { catalog } = await readLatestCatalog({
    client,
    deps,
    config: cfg,
    passphrase,
    signal,
  });
  const entry = catalog.entries.find((e) => e.slug === slug) || null;
  const rid = entry ? entry.randomId : await dep(deps, "getRandomId")(slug);
  let drafts = [];
  if (rid) {
    drafts = (await client.listReleasesByTagPrefix(`ks-${rid}-v`, { signal }))
      .filter((r) => r.draft === true)
      .map((r) => ({ tag: r.tag_name }));
  }
  return {
    latest: entry ? entry.latestVersion : 0,
    versions: entry ? entry.versions.map((v) => ({ ...v })) : [],
    drafts,
  };
}

module.exports = {
  nextVersion,
  publishWorkspace,
  deleteVersion,
  listVersions,
  catalogMutex,
  readLatestCatalog,
};
