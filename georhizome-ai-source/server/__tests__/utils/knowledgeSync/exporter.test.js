const fs = require("fs");
const os = require("os");
const path = require("path");
const tar = require("tar");

process.env.STORAGE_DIR =
  process.env.STORAGE_DIR || path.join(os.tmpdir(), "ks-exp-init");

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
const locks = require("../../../utils/knowledgeSync/locks");
const {
  getKnowledgeSyncConfig,
} = require("../../../utils/knowledgeSync/config");
const { decryptFile } = require("../../../utils/knowledgeSync/crypto");
const { extractArchive } = require("../../../utils/knowledgeSync/archive");
const { validateManifest } = require("../../../utils/knowledgeSync/manifest");
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
let docFile;
const OLD_ENV = { ...process.env };

beforeEach(async () => {
  mockStore.clear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-exp-"));
  process.env.STORAGE_DIR = root;
  process.env.NODE_ENV = "test";
  locks._resetForTests();
  const conn = await lancedb.connect(path.join(root, "lancedb"));
  await conn.createTable("ws1", [
    { id: "v1", vector: [0.1, 0.2], text: "a" },
    { id: "v2", vector: [0.3, 0.4], text: "b" },
  ]);
  fs.mkdirSync(path.join(root, "documents", "custom-documents"), {
    recursive: true,
  });
  docFile = path.join(root, "documents", "custom-documents", "doc1.json");
  fs.writeFileSync(
    docFile,
    JSON.stringify({ title: "t", chunkSource: "/Users/secret/file.pdf" })
  );
  mockPrisma.workspace_documents.findMany.mockResolvedValue([
    {
      docId: "d1",
      filename: "doc1.json",
      docpath: "custom-documents/doc1.json",
      metadata: JSON.stringify({ chunkSource: "/Users/secret/file.pdf" }),
      pinned: false,
      watched: false,
      createdAt: new Date(),
    },
  ]);
  mockPrisma.document_vectors.findMany.mockResolvedValue([
    { docId: "d1", vectorId: "v1" },
    { docId: "d1", vectorId: "v2" },
  ]);
});
afterEach(() => {
  jest.restoreAllMocks();
  process.env = { ...OLD_ENV };
  fs.rmSync(root, { recursive: true, force: true });
});

const stagingLeftovers = () => {
  const s = paths.stagingRoot({ config });
  if (!fs.existsSync(s)) return [];
  return fs.readdirSync(s).filter((n) => n !== "exports");
};
const code = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.code;
  }
  return null;
};
const exportsList = () => {
  const d = paths.exportsDir({ config });
  return fs.existsSync(d) ? fs.readdirSync(d) : [];
};

test("happy path round trip, manifest.enc first, no residue", async () => {
  const res = await exportWorkspace({ slug: "ws1", passphrase: PW, config });
  expect(res.archiveName).toBe("ws1-v1.grks");
  expect(res.rowCount).toBe(2);
  const staging = paths.stagingRoot({ config });
  const tarPath = path.join(staging, "rt.tar");
  await decryptFile(res.archivePath, tarPath, PW, {
    config,
    stagingDir: staging,
  });
  const entries = [];
  await tar.t({ file: tarPath, onReadEntry: (e) => entries.push(e.path) });
  expect(entries[0]).toBe("manifest.enc");
  const dest = path.join(staging, "rt-extract");
  await extractArchive(tarPath, dest, { config });
  expect(fs.existsSync(path.join(dest, "lancedb", "ws1.lance"))).toBe(true);
  expect(fs.existsSync(path.join(dest, "db", "rows.json"))).toBe(true);
  const manPlain = path.join(staging, "rt-manifest.json");
  await decryptFile(path.join(dest, "manifest.enc"), manPlain, PW, {
    config,
    stagingDir: staging,
  });
  const m = validateManifest(JSON.parse(fs.readFileSync(manPlain, "utf-8")));
  expect(m.rowCount).toBe(2);
  expect(m.versionId).toBe(1);
  expect(m.workspace.slug).toBe("ws1");

  const rows = fs.readFileSync(path.join(dest, "db", "rows.json"), "utf-8");
  expect(rows).not.toMatch(/openAiTemp|chatModel|openAiPrompt/);
  expect(rows).not.toMatch(/Users\/secret/);
  const copied = fs.readFileSync(
    path.join(dest, "documents", "doc1.json"),
    "utf-8"
  );
  expect(JSON.parse(copied).chunkSource).toBe("file.pdf");
  // live file untouched
  expect(JSON.parse(fs.readFileSync(docFile, "utf-8")).chunkSource).toBe(
    "/Users/secret/file.pdf"
  );
  fs.rmSync(tarPath);
  fs.rmSync(dest, { recursive: true });
  fs.rmSync(manPlain);
  expect(stagingLeftovers()).toEqual([]);
  expect(locks.state("ws1")).toBeNull();
});

test("lock held during copy and released after", async () => {
  const orig = fs.promises.cp;
  let seen = null;
  jest.spyOn(fs.promises, "cp").mockImplementation(async (...a) => {
    seen = locks.state("ws1")?.op;
    return orig.apply(fs.promises, a);
  });
  await exportWorkspace({ slug: "ws1", passphrase: PW, config });
  expect(seen).toBe("export");
  expect(locks.state("ws1")).toBeNull();
});

test("busy when embed holds lock; nothing written", async () => {
  locks.acquire("ws1", "embed");
  expect(
    await code(exportWorkspace({ slug: "ws1", passphrase: PW, config }))
  ).toBe("KS_E_BUSY");
  expect(exportsList()).toEqual([]);
  expect(stagingLeftovers()).toEqual([]);
});

test("concurrent export gets KS_E_BUSY", async () => {
  const a = exportWorkspace({ slug: "ws1", passphrase: PW, config });
  const b = exportWorkspace({ slug: "ws1", passphrase: PW, config });
  const [ra, rb] = await Promise.allSettled([a, b]);
  const codes = [ra, rb].map((r) =>
    r.status === "rejected" ? r.reason.code : "ok"
  );
  expect(codes.sort()).toEqual(["KS_E_BUSY", "ok"]);
});

test("preflight failure writes nothing and never acquires", async () => {
  jest.spyOn(fs.promises, "statfs").mockResolvedValue({ bavail: 0, bsize: 1 });
  const acq = jest.spyOn(locks, "acquire");
  expect(
    await code(exportWorkspace({ slug: "ws1", passphrase: PW, config }))
  ).toBe("KS_E_DISK_SPACE");
  expect(acq).not.toHaveBeenCalled();
  expect(exportsList()).toEqual([]);
  expect(stagingLeftovers()).toEqual([]);
});

test("symlink in lance dir rejected", async () => {
  fs.symlinkSync(docFile, path.join(root, "lancedb", "ws1.lance", "evil-link"));
  expect(
    await code(exportWorkspace({ slug: "ws1", passphrase: PW, config }))
  ).toBe("KS_E_UNSAFE_ENTRY");
  expect(exportsList()).toEqual([]);
  expect(stagingLeftovers()).toEqual([]);
});

test("missing doc file -> KS_E_EXPORT_INCOMPLETE, no archive", async () => {
  fs.rmSync(docFile);
  expect(
    await code(exportWorkspace({ slug: "ws1", passphrase: PW, config }))
  ).toBe("KS_E_EXPORT_INCOMPLETE");
  expect(exportsList()).toEqual([]);
  expect(stagingLeftovers()).toEqual([]);
});

test("version increments only on success", async () => {
  const r1 = await exportWorkspace({ slug: "ws1", passphrase: PW, config });
  expect(r1.versionId).toBe(1);
  fs.rmSync(docFile);
  await code(exportWorkspace({ slug: "ws1", passphrase: PW, config }));
  fs.writeFileSync(docFile, JSON.stringify({ title: "t" }));
  const r2 = await exportWorkspace({ slug: "ws1", passphrase: PW, config });
  expect(r2.versionId).toBe(2);
});

test("unknown workspace -> KS_E_NOT_FOUND", async () => {
  expect(
    await code(exportWorkspace({ slug: "nope", passphrase: PW, config }))
  ).toBe("KS_E_NOT_FOUND");
});

test("WR-07: counter reset never overwrites or deletes an existing archive", async () => {
  const r1 = await exportWorkspace({ slug: "ws1", passphrase: PW, config });
  const orig = fs.readFileSync(r1.archivePath);
  mockStore.clear(); // simulate DB/prisma reset of the version counter
  expect(
    await code(exportWorkspace({ slug: "ws1", passphrase: PW, config }))
  ).toBe("KS_E_ARCHIVE_EXISTS");
  expect(fs.readFileSync(r1.archivePath).equals(orig)).toBe(true);
  expect(fs.existsSync(r1.archivePath + ".part")).toBe(false);
});

describe("phase 7 options", () => {
  test("explicit versionId honored and counter committed", async () => {
    const res = await exportWorkspace({
      slug: "ws1",
      passphrase: PW,
      config,
      versionId: 7,
    });
    expect(res.archiveName).toBe("ws1-v7.grks");
    expect(res.versionId).toBe(7);
    expect(res.manifest.versionId).toBe(7);
    expect(res.docs).toEqual([
      { docId: "d1", filename: "doc1.json", docpath: "doc1.json" },
    ]);
    expect(mockStore.get("ks_export_ver_ws1")).toBe("7");
  });
  test("overwrite true replaces leftover; false refuses", async () => {
    const dir = paths.exportsDir({ config });
    fs.mkdirSync(dir, { recursive: true });
    const left = path.join(dir, "ws1-v3.grks");
    fs.writeFileSync(left, "stale");
    expect(
      await code(
        exportWorkspace({ slug: "ws1", passphrase: PW, config, versionId: 3 })
      )
    ).toBe("KS_E_ARCHIVE_EXISTS");
    expect(fs.readFileSync(left, "utf8")).toBe("stale");
    await exportWorkspace({
      slug: "ws1",
      passphrase: PW,
      config,
      versionId: 3,
      overwrite: true,
    });
    expect(fs.statSync(left).size).toBeGreaterThan(5);
  });
  test("aborted signal throws KS_E_CANCELLED and onPhase fires", async () => {
    const phases = [];
    const ac = new AbortController();
    const c = await code(
      exportWorkspace({
        slug: "ws1",
        passphrase: PW,
        config,
        signal: ac.signal,
        onPhase: (p) => {
          phases.push(p);
          if (p === "pack") ac.abort();
        },
      })
    );
    expect(phases).toEqual(["pack"]);
    expect(c).toBe("KS_E_CANCELLED");
    expect(exportsList()).toEqual([]);
  });
  test("lockHeld skips the non-reentrant lock", async () => {
    await locks.withWorkspaceLock("ws1", "export", async () => {
      expect(
        await code(exportWorkspace({ slug: "ws1", passphrase: PW, config }))
      ).toBe("KS_E_BUSY");
      const res = await exportWorkspace({
        slug: "ws1",
        passphrase: PW,
        config,
        lockHeld: true,
      });
      expect(res.rowCount).toBe(2);
    });
  });
});
