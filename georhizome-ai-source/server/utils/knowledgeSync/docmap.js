const { KnowledgeSyncError } = require("./errors");
const { ksDocpathPrefix } = require("./paths");

const util = require("./util");

const safeBasename = (name) => util.safeBasename(name, "docpath");

/** Pure: archive rows -> local rows (docpath rebuilt from LOCAL slug). */
function buildImportRows({ rows, localSlug, workspaceId, existingFlags }) {
  const prefix = ksDocpathPrefix(localSlug);
  const flags = existingFlags || new Map();
  const seen = new Set();
  const docs = rows.docs.map((d) => {
    const file = safeBasename(d.file);
    if (seen.has(file))
      throw new KnowledgeSyncError("KS_E_MANIFEST", { phase: "docmap" });
    seen.add(file);
    const f = flags.get(d.docId);
    const createdAt = d.createdAt ? new Date(d.createdAt) : new Date();
    return {
      docId: d.docId,
      // Prefer the original display name; `file` may carry a dedupe prefix.
      filename: util.isSafeBasename(d.filename) ? d.filename : file,
      docpath: `${prefix}/${file}`,
      workspaceId,
      metadata: d.metadata == null ? null : JSON.stringify(d.metadata),
      pinned: f ? !!f.pinned : !!d.pinned,
      watched: f ? !!f.watched : !!d.watched,
      createdAt,
    };
  });
  const vectors = rows.vectors.map((v) => ({
    docId: v.docId,
    vectorId: v.vectorId,
  }));
  return { docs, vectors };
}

/** Snapshot of live rows via the passed client (prisma or tx). */
async function buildSnapshotRows(client, workspaceId) {
  const all = await client.workspace_documents.findMany({
    where: { workspaceId },
  });
  const docs = all.map(({ id: _id, ...rest }) => rest);
  const ids = docs.map((d) => d.docId);
  const vecs = ids.length
    ? await client.document_vectors.findMany({ where: { docId: { in: ids } } })
    : [];
  return {
    docs,
    vectors: vecs.map((v) => ({ docId: v.docId, vectorId: v.vectorId })),
  };
}

module.exports = { safeBasename, buildImportRows, buildSnapshotRows };
