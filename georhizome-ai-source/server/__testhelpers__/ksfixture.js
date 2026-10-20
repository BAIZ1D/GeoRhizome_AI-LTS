// Shared importer fixture (tests only). Call AFTER jest.mock of prisma /
// models/workspace / models/systemSettings is registered by the test file.
const fs = require("fs");
const path = require("path");

const PW = "correct horse battery";

function testConfig() {
  const { getKnowledgeSyncConfig } = require("../utils/knowledgeSync/config");
  const base = getKnowledgeSyncConfig();
  return {
    ...base,
    chunk_size_bytes: 1024,
    scrypt: { ...base.scrypt, N: 1024 },
    allowedScryptParams: [{ N: 1024, r: base.scrypt.r, p: base.scrypt.p }],
    allowedChunkSizes: [1024],
  };
}

/** Exports workspace ws1 (2 vectors, 1 doc d1) and wipes local state. */
async function buildArchive(root, config) {
  const lancedb = require("@lancedb/lancedb");
  const memdb = require("./memdb");
  const { exportWorkspace } = require("../utils/knowledgeSync/exporter");
  process.env.STORAGE_DIR = root;
  process.env.NODE_ENV = "test";
  process.env.EMBEDDING_DIMENSION = "2";
  memdb.reset();
  const conn = await lancedb.connect(path.join(root, "lancedb"));
  await conn.createTable("ws1", [
    { id: "v1", vector: [0.1, 0.2], text: "a" },
    { id: "v2", vector: [0.3, 0.4], text: "b" },
  ]);
  const dir = path.join(root, "documents", "custom-documents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "doc1.json"),
    JSON.stringify({
      title: "t",
      chunkSource: "link:///Users/someone/secret/doc1.pdf",
      pageContent: "hello",
    })
  );
  memdb.state.docs.push({
    id: 1,
    docId: "d1",
    filename: "doc1.json",
    docpath: "custom-documents/doc1.json",
    workspaceId: 1,
    metadata: JSON.stringify({
      title: "t",
      chunkSource: "/Users/someone/secret/doc1.pdf",
    }),
    pinned: false,
    watched: false,
    createdAt: new Date(),
    lastUpdatedAt: new Date(),
  });
  memdb.state.nextId = 2;
  memdb.state.vecs.push(
    { docId: "d1", vectorId: "v1" },
    { docId: "d1", vectorId: "v2" }
  );
  const res = await exportWorkspace({ slug: "ws1", passphrase: PW, config });
  fs.rmSync(path.join(root, "lancedb"), { recursive: true, force: true });
  fs.rmSync(path.join(root, "documents"), { recursive: true, force: true });
  memdb.reset();
  return path.basename(res.archivePath);
}

module.exports = { PW, testConfig, buildArchive };
