const fs = require("fs");
const os = require("os");
const path = require("path");
const tar = require("tar");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "ks-stg-init");

const mockStore = new Map();
const mockPrisma = {
  workspace_documents: { findMany: jest.fn() },
  document_vectors: { findMany: jest.fn() },
  system_settings: {
    findFirst: jest.fn(async ({ where }) =>
      mockStore.has(where.label) ? { value: mockStore.get(where.label) } : null
    ),
    upsert: jest.fn(async ({ where, create }) => {
      mockStore.set(where.label, create.value);
    }),
  },
};
jest.mock("../../../utils/prisma", () => mockPrisma);
jest.mock("../../../models/workspace", () => ({
  Workspace: {
    get: jest.fn(async ({ slug }) =>
      slug === "ws1" ? { id: 1, name: "WS One", slug: "ws1" } : null
    ),
  },
}));
jest.mock("../../../models/systemSettings", () => ({
  SystemSettings: {
    get: jest.fn(async ({ label }) =>
      mockStore.has(label) ? { value: mockStore.get(label) } : null
    ),
    _updateSettings: jest.fn(async (o) => {
      for (const [k, v] of Object.entries(o)) mockStore.set(k, v);
    }),
  },
}));

const lancedb = require("@lancedb/lancedb");
const { exportWorkspace } = require("../../../utils/knowledgeSync/exporter");
const stage = require("../../../utils/knowledgeSync/stage");
const locks = require("../../../utils/knowledgeSync/locks");
const {
  getKnowledgeSyncConfig,
} = require("../../../utils/knowledgeSync/config");
const {
  decryptFile,
  encryptFile,
} = require("../../../utils/knowledgeSync/crypto");
const {
  extractArchive,
  packDirectory,
} = require("../../../utils/knowledgeSync/archive");
const paths = require("../../../utils/knowledgeSync/paths");

const PW = "correct horse battery";
const base = getKnowledgeSyncConfig();
const config = {
  ...base,
  chunk_size_bytes: 1024,
  scrypt: { ...base.scrypt, N: 1024 },
  allowedScryptParams: [{ N: 1024, r: base.scrypt.r, p: base.scrypt.p }],
  allowedChunkSizes: [1024],
};
let root;
let archivePath;
const OLD_ENV = { ...process.env };

beforeEach(async () => {
  mockStore.clear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-stg-"));
  process.env.STORAGE_DIR = root;
  process.env.NODE_ENV = "test";
  process.env.EMBEDDING_DIMENSION = "2";
  locks._resetForTests();
  const conn = await lancedb.connect(path.join(root, "lancedb"));
  await conn.createTable("ws1", [
    { id: "v1", vector: [0.1, 0.2], text: "a" },
    { id: "v2", vector: [0.3, 0.4], text: "b" },
  ]);
  fs.mkdirSync(path.join(root, "documents", "custom-documents"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, "documents", "custom-documents", "doc1.json"),
    JSON.stringify({ title: "t" })
  );
  mockPrisma.workspace_documents.findMany.mockResolvedValue([
    {
      docId: "d1",
      filename: "doc1.json",
      docpath: "custom-documents/doc1.json",
      metadata: null,
      pinned: false,
      watched: false,
      createdAt: new Date(),
    },
  ]);
  mockPrisma.document_vectors.findMany.mockResolvedValue([
    { docId: "d1", vectorId: "v1" },
    { docId: "d1", vectorId: "v2" },
  ]);
  const res = await exportWorkspace({ slug: "ws1", passphrase: PW, config });
  archivePath = res.archivePath;
});
afterEach(() => {
  process.env = { ...OLD_ENV };
  fs.rmSync(root, { recursive: true, force: true });
});

const code = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return null;
};
const staging = () => paths.stagingRoot({ config });
const leftovers = () =>
  fs.existsSync(staging())
    ? fs.readdirSync(staging()).filter((n) => n !== "exports")
    : [];
const snap = (d, rel = "") =>
  fs
    .readdirSync(path.join(d, rel), { withFileTypes: true })
    .flatMap((e) => {
      const r = path.join(rel, e.name);
      if (r.startsWith("knowledge-sync-staging")) return [];
      return e.isDirectory() ? [r, ...snap(d, r)] : [r];
    })
    .sort();

// Re-pack an archive after mutating its extracted tree.
async function repack(mutate, name) {
  const w = path.join(staging(), "tamper-" + name);
  fs.mkdirSync(w, { recursive: true });
  const t = path.join(w, "a.tar");
  await decryptFile(archivePath, t, PW, { config, stagingDir: staging() });
  const x = path.join(w, "x");
  await extractArchive(t, x, { config });
  await mutate(x);
  const t2 = path.join(w, "b.tar");
  await packDirectory(x, t2, ["manifest.enc", "lancedb", "documents", "db"]);
  const out = path.join(paths.exportsDir({ config }), name);
  await encryptFile(t2, out, PW, { config });
  fs.rmSync(w, { recursive: true, force: true });
  return name;
}

test("valid archive stages and verifies", async () => {
  const s = await stage.stageArchive({
    archiveName: path.basename(archivePath),
    passphrase: PW,
    config,
  });
  expect(s.manifest.rowCount).toBe(2);
  expect(s.rows.docs).toHaveLength(1);
  expect(fs.existsSync(s.stagedLance)).toBe(true);
  expect(fs.existsSync(path.join(s.dir, "archive.tar"))).toBe(false);
  await stage.discardStaged(s.jobId, { config });
  expect(leftovers()).toEqual([]);
});

test("wrong passphrase: KS_E_PASSPHRASE, staging removed, no live writes", async () => {
  const before = snap(root);
  expect(
    await code(
      stage.stageArchive({
        archiveName: path.basename(archivePath),
        passphrase: "wrong wrong wrong",
        config,
      })
    )
  ).toBe("KS_E_PASSPHRASE");
  expect(leftovers()).toEqual([]);
  expect(snap(root)).toEqual(before);
});

test("flipped byte: KS_E_AUTH_TAG", async () => {
  const b = fs.readFileSync(archivePath);
  b[b.length - 5] ^= 0xff;
  fs.writeFileSync(archivePath, b);
  const c = await code(
    stage.stageArchive({
      archiveName: path.basename(archivePath),
      passphrase: PW,
      config,
    })
  );
  expect(["KS_E_AUTH_TAG", "KS_E_TRUNCATED"]).toContain(c);
  expect(leftovers()).toEqual([]);
});

test("tampered doc: KS_E_MANIFEST", async () => {
  const name = await repack(
    (x) => fs.writeFileSync(path.join(x, "documents", "doc1.json"), "{}"),
    "t1.grks"
  );
  expect(
    await code(
      stage.stageArchive({ archiveName: name, passphrase: PW, config })
    )
  ).toBe("KS_E_MANIFEST");
  expect(leftovers()).toEqual([]);
});

test("extra file: KS_E_MANIFEST", async () => {
  const name = await repack(
    (x) => fs.writeFileSync(path.join(x, "documents", "extra.json"), "{}"),
    "t2.grks"
  );
  expect(
    await code(
      stage.stageArchive({ archiveName: name, passphrase: PW, config })
    )
  ).toBe("KS_E_MANIFEST");
});

test("row-count tamper (rows.json altered): KS_E_MANIFEST", async () => {
  const name = await repack((x) => {
    const f = path.join(x, "db", "rows.json");
    const r = JSON.parse(fs.readFileSync(f, "utf-8"));
    r.vectors.pop();
    fs.writeFileSync(f, JSON.stringify(r));
  }, "t3.grks");
  expect(
    await code(
      stage.stageArchive({ archiveName: name, passphrase: PW, config })
    )
  ).toBe("KS_E_MANIFEST");
});

test("unsafe archive names rejected", async () => {
  for (const n of ["../x", "a/b", "", ".hidden", "a\\b"])
    expect(
      await code(stage.stageArchive({ archiveName: n, passphrase: PW, config }))
    ).toBe("KS_E_NOT_FOUND");
  expect(
    await code(
      stage.stageArchive({
        archiveName: "missing.grks",
        passphrase: PW,
        config,
      })
    )
  ).toBe("KS_E_NOT_FOUND");
});

test("loadStaged: bad id, missing, expired", async () => {
  expect(await code(stage.loadStaged("../x", { config }))).toBe(
    "KS_E_PREVIEW_INVALID"
  );
  const s = await stage.stageArchive({
    archiveName: path.basename(archivePath),
    passphrase: PW,
    config,
  });
  expect(await code(stage.loadStaged(s.jobId, { config }))).toBe(
    "KS_E_PREVIEW_INVALID"
  );
  fs.writeFileSync(
    path.join(s.dir, "preview.json"),
    JSON.stringify({ createdAt: new Date().toISOString() })
  );
  const ok = await stage.loadStaged(s.jobId, { config });
  expect(ok.manifest.workspace.slug).toBe("ws1");
  fs.writeFileSync(
    path.join(s.dir, "preview.json"),
    JSON.stringify({
      createdAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
    })
  );
  expect(await code(stage.loadStaged(s.jobId, { config }))).toBe(
    "KS_E_PREVIEW_INVALID"
  );
  await stage.discardStaged(s.jobId, { config });
});

test("CR-02: discard refused while claimed or journaled; expired preview loadable for discard", async () => {
  const journalLib = require("../../../utils/knowledgeSync/journal");
  const s = await stage.stageArchive({
    archiveName: path.basename(archivePath),
    passphrase: PW,
    config,
  });
  fs.writeFileSync(
    path.join(s.dir, "preview.json"),
    JSON.stringify({
      createdAt: new Date(Date.now() - 2 * 3600e3).toISOString(),
    })
  );
  const exp = await stage.loadStaged(s.jobId, { config, allowExpired: true });
  expect(exp.jobId).toBe(s.jobId);

  stage.claimPreview(s.jobId);
  expect(await code(stage.discardStaged(s.jobId, { config }))).toBe(
    "KS_E_BUSY"
  );
  expect(fs.existsSync(s.dir)).toBe(true);
  stage.releasePreview(s.jobId);

  await journalLib.createJournal(s.jobId, { kind: "import", slug: "ws1" });
  expect(await code(stage.discardStaged(s.jobId, { config }))).toBe(
    "KS_E_BUSY"
  );
  expect(fs.existsSync(path.join(s.dir, "journal.json"))).toBe(true);
  await journalLib.removeJournalDir(s.jobId);
  expect(leftovers()).toEqual([]);
});
