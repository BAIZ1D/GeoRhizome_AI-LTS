// Real Prisma + temp SQLite proof for import confirm / rollback (IN-03, SC5).
// memdb ignores transaction timeouts, so it cannot prove this.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { v4: uuidv4 } = require("uuid");

jest.setTimeout(180000);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ks-sqlite-"));
const dbUrl = "file:" + path.join(tmpRoot, "test.db");
// T-08-06: never connect outside os.tmpdir().
if (!path.resolve(tmpRoot).startsWith(path.resolve(os.tmpdir())))
  throw new Error("test DB must live under os.tmpdir()");

const { PrismaClient } = require("@prisma/client");
const realClient = new PrismaClient({ datasources: { db: { url: dbUrl } } });
jest.mock("../../../utils/prisma", () => global.__ksRealPrisma);
global.__ksRealPrisma = realClient;

const lancedb = require("@lancedb/lancedb");
const swap = require("../../../utils/knowledgeSync/swap");
const journalLib = require("../../../utils/knowledgeSync/journal");
const marker = require("../../../utils/knowledgeSync/marker");
const locks = require("../../../utils/knowledgeSync/locks");
const paths = require("../../../utils/knowledgeSync/paths");
const {
  getKnowledgeSyncConfig,
} = require("../../../utils/knowledgeSync/config");

const SLUG = "loc";
const N = 5000;
const OLD_ENV = { ...process.env };
let root;
let workspaceId;

beforeAll(() => {
  const schemaSrc = path.resolve(__dirname, "../../../prisma/schema.prisma");
  const schemaTmp = path.join(tmpRoot, "schema.prisma");
  fs.writeFileSync(
    schemaTmp,
    fs
      .readFileSync(schemaSrc, "utf8")
      .replace(/url\s*=\s*"file:[^"]*"/, `url = "${dbUrl}"`)
  );
  execFileSync(
    "npx",
    ["prisma", "db", "push", "--skip-generate", "--schema", schemaTmp],
    { cwd: path.resolve(__dirname, "../../.."), stdio: "pipe" }
  );
});

afterAll(async () => {
  await realClient.$disconnect();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function makeLance(dir, name, n, tag) {
  const conn = await lancedb.connect(dir);
  await conn.createTable(
    name,
    Array.from({ length: n }, (_, i) => ({
      id: `${tag}${i}`,
      vector: [0.1, 0.2],
      text: tag,
    }))
  );
}

async function seedOld() {
  await makeLance(paths.lancedbRoot(), SLUG, 2, "o");
  fs.mkdirSync(paths.ksDocsDir(SLUG), { recursive: true });
  fs.writeFileSync(path.join(paths.ksDocsDir(SLUG), "old.json"), "{}");
  await realClient.workspace_documents.create({
    data: {
      docId: "old1",
      filename: "old.json",
      docpath: "custom-documents/ks-loc/old.json",
      workspaceId,
    },
  });
  await realClient.document_vectors.create({
    data: { docId: "old1", vectorId: "o0" },
  });
  await realClient.system_settings.create({
    data: {
      label: marker.markerLabel(SLUG),
      value: JSON.stringify({ jobId: "x", versionId: 1, sourceRandomId: "r" }),
    },
  });
}

async function makeSource() {
  const jobId = uuidv4();
  const x = path.join(journalLib.jobDir(jobId), "x");
  await makeLance(path.join(x, "lancedb"), "src", 3, "big");
  fs.mkdirSync(path.join(x, "documents"), { recursive: true });
  fs.writeFileSync(path.join(x, "documents", "big.json"), "{}");
  const docs = Array.from({ length: N }, (_, i) => ({
    docId: `d${i}`,
    filename: `f${i}.json`,
    docpath: `custom-documents/ks-loc/f${i}.json`,
    metadata: null,
    pinned: false,
    watched: false,
    createdAt: "2024-01-01T00:00:00.000Z",
  }));
  return {
    jobId,
    source: {
      lance: path.join(x, "lancedb", "src.lance"),
      docs: path.join(x, "documents"),
      rows: {
        docs,
        vectors: docs.map((d, i) => ({ docId: d.docId, vectorId: `v${i}` })),
      },
      marker: { versionId: 2, sourceRandomId: "r", syncedAt: "t" },
    },
  };
}

const run = (jobId, source) =>
  locks.withWorkspaceLock(SLUG, "import", () =>
    swap.runSwap({ jobId, kind: "import", slug: SLUG, workspaceId, source })
  );

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-swap-sqlite-"));
  process.env.STORAGE_DIR = root;
  process.env.NODE_ENV = "test";
  locks._resetForTests();
  swap.setFailpoint(null);
  await realClient.document_vectors.deleteMany({});
  await realClient.workspace_documents.deleteMany({});
  await realClient.system_settings.deleteMany({});
  await realClient.workspaces.deleteMany({});
  const ws = await realClient.workspaces.create({
    data: { name: "loc", slug: SLUG },
  });
  workspaceId = ws.id;
});
afterEach(() => {
  swap.setFailpoint(null);
  process.env = { ...OLD_ENV };
  fs.rmSync(root, { recursive: true, force: true });
});

test("5000 docs + 5000 vectors confirm within import_tx_timeout_ms", async () => {
  await seedOld();
  const { jobId, source } = await makeSource();
  const t0 = Date.now();
  await run(jobId, source);
  const ms = Date.now() - t0;
  const limit = getKnowledgeSyncConfig().import_tx_timeout_ms;
  console.info(
    `sqlite swap ${N} docs + ${N} vectors: ${ms}ms (limit ${limit})`
  );
  expect(ms).toBeLessThan(limit);
  expect(
    await realClient.workspace_documents.count({ where: { workspaceId } })
  ).toBe(N);
  expect(await realClient.document_vectors.count()).toBe(N);
  expect(
    await realClient.workspace_documents.count({ where: { docId: "old1" } })
  ).toBe(0);
});

test("injected failure after vector batches rolls back to pre-import rows", async () => {
  await seedOld();
  const { jobId, source } = await makeSource();
  swap.setFailpoint("in:S5");
  await expect(run(jobId, source)).rejects.toThrow();
  swap.setFailpoint(null);
  const docs = await realClient.workspace_documents.findMany({
    where: { workspaceId },
  });
  expect(docs.map((d) => d.docId)).toEqual(["old1"]);
  const vecs = await realClient.document_vectors.findMany();
  expect(vecs.map((v) => v.vectorId)).toEqual(["o0"]);
  const m = await realClient.system_settings.findFirst({
    where: { label: marker.markerLabel(SLUG) },
  });
  expect(JSON.parse(m.value).versionId).toBe(1);
});
