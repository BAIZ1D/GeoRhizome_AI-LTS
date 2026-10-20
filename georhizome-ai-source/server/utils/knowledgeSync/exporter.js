const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const { KnowledgeSyncError } = require("./errors");
const { getKnowledgeSyncConfig, candidatePaths } = require("./config");
const {
  stagingRoot,
  exportsDir,
  documentsRoot,
  lanceTablePath,
  assertSafeSlug,
  assertWithin,
} = require("./paths");
const { estimateBytes, requireFreeSpace } = require("./preflight");
const { computeVectorIdHash } = require("./vectorIdHash");
const { buildManifest } = require("./manifest");
const { packDirectory } = require("./archive");
const { encryptFile } = require("./crypto");
const { effectiveEmbedder } = require("./embedder");
const { safeLog } = require("./redact");
const locks = require("./locks");
const marker = require("./marker");
const secrets = require("./secrets");
const workspaceId = require("./workspaceId");

const err = (code, phase) => new KnowledgeSyncError(code, { phase });
const ROWS_ESTIMATE_BYTES = 1048576;

// Lazy: these pull in prisma.
const prisma = () => require("../prisma");
const WorkspaceModel = () => require("../../models/workspace").Workspace;

function readChunking() {
  for (const p of candidatePaths()) {
    try {
      if (!fs.existsSync(p)) continue;
      const ts = JSON.parse(fs.readFileSync(p, "utf-8"))?.text_splitter || {};
      return {
        chunkSize:
          Number.isInteger(ts.chunk_size) && ts.chunk_size > 0
            ? ts.chunk_size
            : 1000,
        overlap:
          Number.isInteger(ts.chunk_overlap) && ts.chunk_overlap >= 0
            ? ts.chunk_overlap
            : 20,
      };
    } catch {
      break;
    }
  }
  return { chunkSize: 1000, overlap: 20 };
}

const ABS_RE = /^([\\/]|[A-Za-z]:[\\/])/;
// Replace absolute local paths with their basename (copy only; Pitfall 10).
function redactPaths(value) {
  if (typeof value === "string") {
    const m = value.match(/^([a-z]+:\/\/)?(.*)$/is);
    const scheme = m[1] || "";
    const rest = m[2];
    if (ABS_RE.test(rest)) {
      return scheme + rest.split(/[\\/]/).filter(Boolean).pop();
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redactPaths);
  if (value && typeof value === "object") {
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = redactPaths(v);
    return o;
  }
  return value;
}

function lancedbVersion() {
  let dir = path.dirname(require.resolve("@lancedb/lancedb"));
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, "package.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf-8"));
      if (j.name === "@lancedb/lancedb") return j.version;
    }
    dir = path.dirname(dir);
  }
  throw err("KS_E_UNKNOWN", "export");
}

async function assertNoSymlinks(dir) {
  for (const ent of await fs.promises.readdir(dir)) {
    const p = path.join(dir, ent);
    const st = await fs.promises.lstat(p);
    if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory()))
      throw err("KS_E_UNSAFE_ENTRY", "export");
    if (st.isDirectory()) await assertNoSymlinks(p);
  }
}

function safeBasename(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.includes("..")
  )
    throw err("KS_E_UNSAFE_ENTRY", "export");
  return name;
}

async function loadDocs(workspace) {
  const docs = await prisma().workspace_documents.findMany({
    where: { workspaceId: workspace.id },
  });
  const ids = docs.map((d) => d.docId);
  const vectors = ids.length
    ? await prisma().document_vectors.findMany({
        where: { docId: { in: ids } },
      })
    : [];
  return { docs, vectors };
}

function resolveDocFile(doc) {
  const root = documentsRoot();
  try {
    return assertWithin(root, path.resolve(root, String(doc.docpath)));
  } catch {
    throw err("KS_E_UNSAFE_ENTRY", "export");
  }
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

async function exportWorkspace({ slug, passphrase, config } = {}) {
  assertSafeSlug(slug);
  const cfg = config || getKnowledgeSyncConfig();
  const pass = passphrase || (await secrets.getPassphrase());
  if (!pass) throw err("KS_E_PASSPHRASE", "export");

  const workspace = await WorkspaceModel().get({ slug });
  if (!workspace) throw err("KS_E_NOT_FOUND", "export");

  // Step 1: estimate + preflight BEFORE the lock or any write (EXP-03).
  const lanceDir = lanceTablePath(slug);
  const pre = await loadDocs(workspace);
  const docFiles = pre.docs.map(resolveDocFile);
  const preExisting = [lanceDir];
  for (const f of docFiles) if (fs.existsSync(f)) preExisting.push(f);
  const estimate = (await estimateBytes(preExisting)) + ROWS_ESTIMATE_BYTES;
  const staging = stagingRoot({ config: cfg });
  await requireFreeSpace(staging, estimate, { config: cfg });
  if (cfg.max_extract_bytes && estimate > cfg.max_extract_bytes)
    throw err("KS_E_SIZE_LIMIT", "export");
  if (cfg.max_entries && pre.docs.length + 2 > cfg.max_entries)
    throw err("KS_E_SIZE_LIMIT", "export");

  return locks.withWorkspaceLock(slug, "export", async () => {
    const work = path.join(staging, uuidv4());
    const tarFile = work + ".tar";
    assertWithin(staging, work);
    try {
      await fs.promises.mkdir(path.join(work, "lancedb"), { recursive: true });
      await fs.promises.mkdir(path.join(work, "documents"), {
        recursive: true,
      });
      await fs.promises.mkdir(path.join(work, "db"), { recursive: true });

      // Step 3: snapshot lance table (no symlinks, no dereference).
      if (!fs.existsSync(lanceDir))
        throw err("KS_E_EXPORT_INCOMPLETE", "export");
      await assertNoSymlinks(lanceDir);
      await fs.promises.cp(
        lanceDir,
        path.join(work, "lancedb", slug + ".lance"),
        {
          recursive: true,
          dereference: false,
        }
      );

      // Step 4: referenced docs (re-read inside the lock).
      const { docs, vectors } = await loadDocs(workspace);
      const used = new Set();
      const rowDocs = [];
      for (const d of docs) {
        const src = resolveDocFile(d);
        let raw;
        try {
          const st = await fs.promises.lstat(src);
          if (st.isSymbolicLink() || !st.isFile()) throw new Error("bad");
          raw = await fs.promises.readFile(src, "utf-8");
        } catch {
          throw err("KS_E_EXPORT_INCOMPLETE", "export");
        }
        let json;
        try {
          json = JSON.parse(raw);
        } catch {
          throw err("KS_E_EXPORT_INCOMPLETE", "export");
        }
        let base = safeBasename(path.basename(src));
        if (used.has(base)) base = `${String(d.docId).slice(0, 8)}-${base}`;
        safeBasename(base);
        used.add(base);
        await fs.promises.writeFile(
          path.join(work, "documents", base),
          JSON.stringify(redactPaths(json))
        );
        let metadata = null;
        if (d.metadata) {
          try {
            metadata = redactPaths(JSON.parse(d.metadata));
          } catch {
            metadata = null;
          }
        }
        rowDocs.push({
          docId: d.docId,
          filename: d.filename,
          file: base,
          metadata,
          pinned: !!d.pinned,
          watched: !!d.watched,
          createdAt: new Date(d.createdAt).toISOString(),
        });
      }

      // Step 5: rows.json (no chat settings).
      const rows = {
        workspace: { name: workspace.name, slug: workspace.slug },
        docs: rowDocs,
        vectors: vectors.map((v) => ({ docId: v.docId, vectorId: v.vectorId })),
      };
      await fs.promises.writeFile(
        path.join(work, "db", "rows.json"),
        JSON.stringify(rows)
      );

      // Step 6: count + id hash from the COPIED table.
      const lancedb = require("@lancedb/lancedb");
      const conn = await lancedb.connect(path.join(work, "lancedb"));
      const table = await conn.openTable(slug);
      const rowCount = await table.countRows();
      if (rowCount !== rows.vectors.length)
        throw err("KS_E_EXPORT_INCOMPLETE", "export");
      const vectorIdHash = await computeVectorIdHash(table);

      // Step 7: manifest sealed as first entry.
      const versionId = await marker.nextExportVersion(slug);
      const files = [];
      for (const rel of await listFiles(work)) {
        const st = await fs.promises.stat(path.join(work, rel));
        files.push({
          path: rel,
          size: st.size,
          sha256: await sha256File(path.join(work, rel)),
        });
      }
      if (cfg.max_entries && files.length > cfg.max_entries)
        throw err("KS_E_SIZE_LIMIT", "export");
      const manifest = buildManifest({
        workspace: {
          name: workspace.name,
          slug,
          randomId: await workspaceId.getOrCreateRandomId(slug),
        },
        versionId,
        embedder: effectiveEmbedder(),
        chunking: readChunking(),
        rowCount,
        vectorIdHash,
        files,
        versions: {
          lancedb: lancedbVersion(),
          app: require("../../package.json").version,
        },
      });
      const manifestJson = path.join(work, "manifest.json");
      await fs.promises.writeFile(manifestJson, JSON.stringify(manifest));
      await encryptFile(manifestJson, path.join(work, "manifest.enc"), pass, {
        config: cfg,
      });
      await fs.promises.rm(manifestJson, { force: true });

      // Step 8: pack (manifest.enc first) and encrypt.
      await packDirectory(work, tarFile, [
        "manifest.enc",
        "lancedb",
        "documents",
        "db",
      ]);
      const tarSize = (await fs.promises.stat(tarFile)).size;
      if (cfg.max_extract_bytes && tarSize > cfg.max_extract_bytes)
        throw err("KS_E_SIZE_LIMIT", "export");
      const outDir = exportsDir({ config: cfg });
      await fs.promises.mkdir(outDir, { recursive: true });
      const archiveName = `${slug}-v${versionId}.grks`;
      const archivePath = path.join(outDir, archiveName);
      try {
        await encryptFile(tarFile, archivePath, pass, { config: cfg });
      } catch (e) {
        await fs.promises.rm(archivePath, { force: true });
        throw e;
      }

      // Step 9: commit version only after success.
      await marker.commitExportVersion(slug, versionId);
      const bytes = (await fs.promises.stat(archivePath)).size;
      safeLog("info", `export complete ${archiveName}`, { rowCount, bytes });
      return { archivePath, archiveName, versionId, rowCount, bytes };
    } finally {
      await fs.promises.rm(work, { recursive: true, force: true });
      await fs.promises.rm(tarFile, { force: true });
    }
  });
}

module.exports = { exportWorkspace, redactPaths };
