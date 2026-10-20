// Shared harness for knowledgeSync release/runner tests (no real GitHub/prisma).
const fs = require("fs");
const path = require("path");
const { createMemGithub } = require("./memGithub");

const PASS = "correct horse battery staple";
const RIDS = { ws1: "aaaaaaa1", ws2: "bbbbbbb2", ws3: "ccccccc3" };

function createHarness({ partSize = 10, archiveBytes = 25 } = {}) {
  const { getKnowledgeSyncConfig } = require("../utils/knowledgeSync/config");
  const {
    MANIFEST_FORMAT_VERSION,
  } = require("../utils/knowledgeSync/manifest");
  const { exportsDir } = require("../utils/knowledgeSync/paths");
  const base = getKnowledgeSyncConfig();
  const cfg = {
    ...base,
    part_size_bytes: partSize,
    scrypt: { ...base.scrypt, N: 1024 },
    allowedScryptParams: [{ N: 1024, r: base.scrypt.r, p: base.scrypt.p }],
    max_extract_bytes: 100000,
  };
  const mem = createMemGithub(cfg.catalog_tag_prefix);
  const github = require("../utils/knowledgeSync/github");
  const locks = require("../utils/knowledgeSync/locks");
  const exportCalls = [];
  const deps = {
    getOrCreateRandomId: async (s) => RIDS[s],
    getRandomId: async (s) => RIDS[s] || null,
    getPassphrase: async () => PASS,
    getPat: async () => "ghp_" + "x".repeat(30),
    getWorkspace: async (s) =>
      RIDS[s] ? { id: 1, name: "WS " + s, slug: s } : null,
    fetchPublicAsset: (tag, name, o) =>
      github.fetchPublicAsset(tag, name, { ...o, fetchImpl: mem.fetchImpl }),
    exportWorkspace: async (o) => {
      exportCalls.push(o);
      const run = async () => {
        if (mem.fail.export) throw new Error("export failed");
        const dir = exportsDir({ config: cfg });
        await fs.promises.mkdir(dir, { recursive: true });
        const archivePath = path.join(dir, `${o.slug}-v${o.versionId}.grks`);
        await fs.promises.writeFile(archivePath, Buffer.alloc(archiveBytes, 7));
        if (o.onPhase) {
          o.onPhase("pack");
          o.onPhase("encrypt");
        }
        return {
          archivePath,
          bytes: archiveBytes,
          versionId: o.versionId,
          manifest: {
            formatVersion: MANIFEST_FORMAT_VERSION,
            versionId: o.versionId,
            embedder: {
              modelId: "m",
              dimension: 4,
              normalization: true,
              prefixes: { query: "", document: "" },
            },
            createdAt: "2026-01-01T00:00:00.000Z",
            workspace: {
              name: "WS " + o.slug,
              slug: o.slug,
              randomId: RIDS[o.slug],
            },
            files: [{ path: "a", size: 11, sha256: "0".repeat(64) }],
          },
          docs: [{ docId: "d1", filename: "f.json", docpath: "f.json" }],
        };
      };
      // Mirrors the real exporter: non-reentrant lock unless lockHeld.
      return o.lockHeld
        ? run()
        : locks.withWorkspaceLock(o.slug, "export", run);
    },
  };
  const ctx = () => ({
    signal: new AbortController().signal,
    setPhase: jest.fn(),
    setPercent: jest.fn(),
    throwIfCancelled: jest.fn(),
    setPreview: jest.fn(),
    awaitConfirm: jest.fn(async () => {}),
  });
  return { cfg, mem, deps, ctx, exportCalls, PASS, RIDS };
}

module.exports = { createHarness, PASS, RIDS };
