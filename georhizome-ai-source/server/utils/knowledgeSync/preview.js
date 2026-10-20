const fs = require("fs");
const path = require("path");
const { getKnowledgeSyncConfig } = require("./config");
const { stageArchive, discardStaged } = require("./stage");
const { checkCompatibility } = require("./compat");
const { effectiveEmbedder } = require("./embedder");
const marker = require("./marker");

const prisma = () => require("../prisma");
const WorkspaceModel = () => require("../../models/workspace").Workspace;

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

async function resolveTarget(manifest) {
  const W = WorkspaceModel();
  let ws = await W.get({ slug: manifest.workspace.slug });
  if (!ws) ws = await W.get({ name: manifest.workspace.name });
  if (ws) return { matched: true, workspace: ws };
  return { matched: false, willCreateName: manifest.workspace.name };
}

async function computeBlocking({
  manifest,
  rows,
  target,
  compatibility,
  allowUnsynced = false,
}) {
  const blocking = [];
  if (!compatibility.ok)
    for (const r of compatibility.reasons)
      if (!blocking.includes(r.code)) blocking.push(r.code);
  if (target.matched) {
    const m = await marker.readMarker(target.workspace.slug);
    if (m) {
      const same = m.sourceRandomId === manifest.workspace.randomId;
      if (!same || manifest.versionId <= Number(m.versionId))
        blocking.push("KS_E_VERSION_STALE");
    } else if (!allowUnsynced) {
      // WR-06: never-synced local workspace matched by slug/name: replacing
      // its documents needs an explicit override.
      const local = await prisma().workspace_documents.findMany({
        where: { workspaceId: target.workspace.id },
      });
      if (local.length) blocking.push("KS_E_TARGET_UNSYNCED");
    }
  }
  const ids = rows.docs.map((d) => d.docId);
  if (ids.length) {
    const owned = await prisma().workspace_documents.findMany({
      where: { docId: { in: ids } },
    });
    const ownId = target.matched ? target.workspace.id : null;
    if (owned.some((d) => d.workspaceId !== ownId))
      blocking.push("KS_E_DOCID_CONFLICT");
  }
  return blocking;
}

async function localOnlyOf(target, docs) {
  if (!target.matched) return [];
  const inArchive = new Set(docs.map((d) => d.docId));
  const local = await prisma().workspace_documents.findMany({
    where: { workspaceId: target.workspace.id },
  });
  return local
    .filter((d) => !inArchive.has(d.docId))
    .map((d) => ({
      docId: d.docId,
      filename: d.filename,
      docpath: d.docpath,
    }))
    .sort((a, b) => cmp(a.docpath, b.docpath) || cmp(a.docId, b.docId));
}

// C1: preview from the decrypted per-version preview asset (manifest + doc
// list) before any archive part is downloaded. Same shape as previewImport.
async function previewFromManifest({ manifest, docs, indexTotalSize } = {}) {
  const rows = { docs };
  const compatibility = checkCompatibility(manifest, effectiveEmbedder());
  const target = await resolveTarget(manifest);
  const localOnlyDocs = await localOnlyOf(target, docs);
  const blocking = await computeBlocking({
    manifest,
    rows,
    target,
    compatibility,
  });
  return {
    previewId: null,
    versionId: manifest.versionId,
    archiveBytes: indexTotalSize,
    sizeBytes: manifest.files.reduce((s, f) => s + f.size, 0),
    docCount: docs.length,
    compatibility,
    target: {
      matched: target.matched,
      slug: target.matched ? target.workspace.slug : null,
      name: target.matched ? target.workspace.name : target.willCreateName,
    },
    localOnlyDocs,
    blocking,
  };
}

async function previewImport({ archiveName, passphrase, userId, config } = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const staged = await stageArchive({ archiveName, passphrase, config: cfg });
  try {
    await fs.promises.writeFile(
      path.join(staged.dir, "preview.json"),
      JSON.stringify({
        ownerUserId: userId ?? null,
        archiveName,
        createdAt: new Date().toISOString(),
      })
    );
    const { manifest, rows } = staged;
    const compatibility = checkCompatibility(manifest, effectiveEmbedder());
    const target = await resolveTarget(manifest);
    const localOnlyDocs = await localOnlyOf(target, rows.docs);
    const blocking = await computeBlocking({
      manifest,
      rows,
      target,
      compatibility,
    });
    return {
      previewId: staged.jobId,
      versionId: manifest.versionId,
      archiveBytes: staged.archiveBytes,
      sizeBytes: manifest.files.reduce((s, f) => s + f.size, 0),
      docCount: rows.docs.length,
      compatibility,
      target: {
        matched: target.matched,
        slug: target.matched ? target.workspace.slug : null,
        name: target.matched ? target.workspace.name : target.willCreateName,
      },
      localOnlyDocs,
      blocking,
    };
  } catch (e) {
    await discardStaged(staged.jobId, { config: cfg }).catch(() => {});
    throw e;
  }
}

// Recomputed at confirm (D-08); never trust stored results.
async function validateConfirmable(staged, { allowUnsynced = false } = {}) {
  const { manifest, rows } = staged;
  const compatibility = checkCompatibility(manifest, effectiveEmbedder());
  const target = await resolveTarget(manifest);
  const blocking = await computeBlocking({
    manifest,
    rows,
    target,
    compatibility,
    allowUnsynced,
  });
  return { ok: blocking.length === 0, blocking, compatibility, target };
}

module.exports = {
  previewImport,
  previewFromManifest,
  resolveTarget,
  validateConfirmable,
};
