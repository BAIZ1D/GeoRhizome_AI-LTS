const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig } = require("./config");
const {
  stagingRoot,
  exportsDir,
  assertWithin,
  assertSafeSlug,
} = require("./paths");
const { requireFreeSpace } = require("./preflight");
const { computeVectorIdHash } = require("./vectorIdHash");
const { validateManifest } = require("./manifest");
const { extractArchive } = require("./archive");
const { decryptFile } = require("./crypto");

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const err = (code, phase) => new KnowledgeSyncError(code, { phase });

function safeBase(n) {
  return (
    typeof n === "string" &&
    n &&
    !n.includes("/") &&
    !n.includes("\\") &&
    !n.includes("\0") &&
    !n.includes("..")
  );
}

async function sha256File(file) {
  const h = crypto.createHash("sha256");
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", resolve);
  });
  return h.digest("hex");
}

async function listFiles(root, rel = "") {
  const out = [];
  for (const ent of await fs.promises.readdir(path.join(root, rel))) {
    const r = rel ? `${rel}/${ent}` : ent;
    const st = await fs.promises.lstat(path.join(root, r));
    if (st.isDirectory()) out.push(...(await listFiles(root, r)));
    else out.push(r);
  }
  return out;
}

async function verifyContents(x, manifest) {
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  for (const f of manifest.files) {
    const p = assertWithin(x, path.join(x, f.path));
    let st;
    try {
      st = await fs.promises.lstat(p);
    } catch {
      throw err("KS_E_MANIFEST", "verify");
    }
    if (!st.isFile() || st.size !== f.size)
      throw err("KS_E_MANIFEST", "verify");
    if ((await sha256File(p)) !== f.sha256)
      throw err("KS_E_MANIFEST", "verify");
  }
  for (const rel of await listFiles(x)) {
    if (rel === "manifest.enc") continue;
    if (!listed.has(rel)) throw err("KS_E_MANIFEST", "verify");
  }

  const slug = manifest.workspace.slug;
  assertSafeSlug(slug);
  const lancedb = require("@lancedb/lancedb");
  let table;
  try {
    const conn = await lancedb.connect(path.join(x, "lancedb"));
    table = await conn.openTable(slug);
  } catch {
    throw err("KS_E_MANIFEST", "verify");
  }
  if ((await table.countRows()) !== manifest.rowCount)
    throw err("KS_E_MANIFEST", "verify");
  const schema = await table.schema();
  const vf = schema.fields.find((f) => f.name === "vector");
  const dim = vf && vf.type && vf.type.listSize;
  if (dim !== manifest.embedder.dimension)
    throw err("KS_E_DIM_MISMATCH", "verify");
  if ((await computeVectorIdHash(table)) !== manifest.vectorIdHash)
    throw err("KS_E_MANIFEST", "verify");
}

async function readRows(x, _manifest) {
  let rows;
  try {
    rows = JSON.parse(
      await fs.promises.readFile(path.join(x, "db", "rows.json"), "utf-8")
    );
  } catch {
    throw err("KS_E_MANIFEST", "rows");
  }
  if (!rows || !Array.isArray(rows.docs) || !Array.isArray(rows.vectors))
    throw err("KS_E_MANIFEST", "rows");
  for (const d of rows.docs) {
    if (!d || typeof d.docId !== "string" || !safeBase(d.file))
      throw err("KS_E_UNSAFE_ENTRY", "rows");
    if (!fs.existsSync(path.join(x, "documents", d.file)))
      throw err("KS_E_MANIFEST", "rows");
  }
  return rows;
}

async function stageArchive({ archiveName, passphrase, config } = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  if (typeof archiveName !== "string" || !NAME_RE.test(archiveName))
    throw err("KS_E_NOT_FOUND", "stage");
  const archivePath = assertWithin(
    exportsDir({ config: cfg }),
    path.join(exportsDir({ config: cfg }), archiveName)
  );
  let st;
  try {
    st = await fs.promises.stat(archivePath);
  } catch {
    throw err("KS_E_NOT_FOUND", "stage");
  }
  if (!st.isFile()) throw err("KS_E_NOT_FOUND", "stage");
  const archiveBytes = st.size;
  const staging = stagingRoot({ config: cfg });
  await requireFreeSpace(staging, archiveBytes, { config: cfg });

  const jobId = uuidv4();
  const dir = assertWithin(staging, path.join(staging, jobId));
  const x = path.join(dir, "x");
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    const tarFile = path.join(dir, "archive.tar");
    await decryptFile(archivePath, tarFile, passphrase, {
      config: cfg,
      stagingDir: staging,
    });
    await extractArchive(tarFile, x, { config: cfg });
    await fs.promises.rm(tarFile, { force: true });

    const manPlain = path.join(dir, "manifest.json");
    await decryptFile(path.join(x, "manifest.enc"), manPlain, passphrase, {
      config: cfg,
      stagingDir: staging,
    });
    let manifest;
    try {
      manifest = validateManifest(
        JSON.parse(await fs.promises.readFile(manPlain, "utf-8"))
      );
    } catch (e) {
      if (e instanceof KnowledgeSyncError) throw e;
      throw err("KS_E_MANIFEST", "manifest");
    }
    await verifyContents(x, manifest);
    const rows = await readRows(x, manifest);
    return {
      jobId,
      dir,
      manifest,
      rows,
      archiveBytes,
      stagedLance: path.join(x, "lancedb", manifest.workspace.slug + ".lance"),
      stagedDocs: path.join(x, "documents"),
    };
  } catch (e) {
    await fs.promises.rm(dir, { recursive: true, force: true });
    if (e instanceof KnowledgeSyncError) throw e;
    throw err("KS_E_UNKNOWN", "stage");
  }
}

function previewDir(previewId, cfg) {
  if (typeof previewId !== "string" || !UUID_RE.test(previewId))
    throw err("KS_E_PREVIEW_INVALID", "load");
  const staging = stagingRoot({ config: cfg });
  return assertWithin(staging, path.join(staging, previewId));
}

async function loadStaged(previewId, { config, allowExpired = false } = {}) {
  const cfg = config || getKnowledgeSyncConfig();
  const dir = previewDir(previewId, cfg);
  let meta;
  try {
    meta = JSON.parse(
      await fs.promises.readFile(path.join(dir, "preview.json"), "utf-8")
    );
  } catch {
    throw err("KS_E_PREVIEW_INVALID", "load");
  }
  const age = Date.now() - Date.parse(meta && meta.createdAt);
  if (
    !allowExpired &&
    (!Number.isFinite(age) || age > cfg.preview_ttl_minutes * 60000)
  )
    throw err("KS_E_PREVIEW_INVALID", "load");
  const x = path.join(dir, "x");
  try {
    const manPlain = path.join(dir, "manifest.json");
    // manifest.json (non-secret, validated) is kept in staging for reload.
    const manifest = validateManifest(
      JSON.parse(await fs.promises.readFile(manPlain, "utf-8"))
    );
    const rows = JSON.parse(
      await fs.promises.readFile(path.join(x, "db", "rows.json"), "utf-8")
    );
    return {
      jobId: previewId,
      dir,
      meta,
      manifest,
      rows,
      stagedLance: path.join(x, "lancedb", manifest.workspace.slug + ".lance"),
      stagedDocs: path.join(x, "documents"),
    };
  } catch {
    throw err("KS_E_PREVIEW_INVALID", "load");
  }
}

// CR-03: in-process exclusive claim on a preview (synchronous check-and-set).
const claimed = new Set();
function claimPreview(previewId) {
  if (claimed.has(previewId)) throw err("KS_E_BUSY", "claim");
  claimed.add(previewId);
}
function releasePreview(previewId) {
  claimed.delete(previewId);
}

/**
 * CR-02: the preview dir doubles as the import journal dir. Refuse while a
 * confirm holds the claim (unless the caller is that confirm) or while an
 * import journal exists (crash recovery owns the directory then).
 */
async function discardStaged(previewId, { config, owned = false } = {}) {
  const dir = previewDir(previewId, config || getKnowledgeSyncConfig());
  if (!owned && claimed.has(previewId)) throw err("KS_E_BUSY", "discard");
  if (await require("./journal").readJournal(previewId))
    throw err("KS_E_BUSY", "discard");
  await fs.promises.rm(dir, { recursive: true, force: true });
}

module.exports = {
  stageArchive,
  loadStaged,
  discardStaged,
  claimPreview,
  releasePreview,
};
