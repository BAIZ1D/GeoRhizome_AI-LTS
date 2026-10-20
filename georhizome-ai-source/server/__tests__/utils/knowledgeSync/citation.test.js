const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "ks-cit-init");

jest.mock(
  "../../../utils/prisma",
  () => require("../../../__testhelpers__/memdb").db
);
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(async (c) =>
      c.slug === "ws1" || c.name === "WS One"
        ? { id: 1, name: "WS One", slug: "ws1" }
        : null
    ),
  },
}));
jest.mock("../../../models/systemSettings", () => {
  const m = new Map();
  return {
    SystemSettings: {
      get: jest.fn(async ({ label }) =>
        m.has(label) ? { value: m.get(label) } : null
      ),
      _updateSettings: jest.fn(async (o) => {
        for (const [k, v] of Object.entries(o)) m.set(k, v);
      }),
    },
  };
});

const memdb = require("../../../__testhelpers__/memdb");
const {
  PW,
  testConfig,
  buildArchive,
} = require("../../../__testhelpers__/ksfixture");
const preview = require("../../../utils/knowledgeSync/preview");
const { confirmImport } = require("../../../utils/knowledgeSync/importer");
const locks = require("../../../utils/knowledgeSync/locks");
const paths = require("../../../utils/knowledgeSync/paths");

const config = testConfig();
const OLD_ENV = { ...process.env };
let root;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-cit-"));
  locks._resetForTests();
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  fs.rmSync(root, { recursive: true, force: true });
});

test("imported citation opens from ks-<slug> with redacted source", async () => {
  const name = await buildArchive(root, config);
  const p = await preview.previewImport({
    archiveName: name,
    passphrase: PW,
    userId: 1,
    config,
  });
  await confirmImport({
    previewId: p.previewId,
    userId: 1,
    passphrase: PW,
    config,
  });

  const row = memdb.state.docs[0];
  // (a) docpath under custom-documents/ks-<slug>/<basename>
  expect(row.docpath).toBe("custom-documents/ks-ws1/doc1.json");
  // (b) resolved exactly as utils/files fileData: documentsPath + docpath
  const full = path.resolve(paths.documentsRoot(), row.docpath);
  expect(full.startsWith(paths.documentsRoot() + path.sep)).toBe(true);
  const data = JSON.parse(fs.readFileSync(full, "utf8"));
  // (c) chunkSource redacted to basename, no absolute local path
  expect(data.chunkSource).toBe("link://doc1.pdf");
  expect(JSON.stringify(data)).not.toContain("/Users/");
  expect(JSON.parse(row.metadata).chunkSource).toBe("doc1.pdf");
  // (d) filename is the basename (not "ks-ws1")
  expect(row.filename).toBe("doc1.json");
});
