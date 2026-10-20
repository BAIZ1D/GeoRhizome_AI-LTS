const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  toClientError,
  KnowledgeSyncError,
} = require("../../../utils/knowledgeSync/errors");
const {
  getKnowledgeSyncConfig,
} = require("../../../utils/knowledgeSync/config");
const paths = require("../../../utils/knowledgeSync/paths");

const NEW = [
  "BUSY",
  "SYNCING",
  "DISK_SPACE",
  "EMBEDDER_MISMATCH",
  "DIM_MISMATCH",
  "NO_BACKUP",
  "VERSION_STALE",
  "DOCID_CONFLICT",
  "EXPORT_INCOMPLETE",
  "SIZE_LIMIT",
  "NOT_FOUND",
  "PREVIEW_INVALID",
].map((c) => "KS_E_" + c);

test.each(NEW)("%s round-trips", (code) => {
  expect(toClientError(new KnowledgeSyncError(code)).code).toBe(code);
});

function cfgWith(ks) {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ksc-")), "c.json");
  fs.writeFileSync(f, JSON.stringify({ knowledge_sync: ks }));
  return getKnowledgeSyncConfig({ configPath: f });
}

test("posNum accepts 2.5, rejects 0/string/NaN", () => {
  expect(cfgWith({ disk_preflight_factor: 2.5 }).disk_preflight_factor).toBe(
    2.5
  );
  for (const v of [0, "3", NaN, null])
    expect(cfgWith({ disk_preflight_factor: v }).disk_preflight_factor).toBe(3);
  expect(cfgWith({ stale_staging_hours: 1.5 }).stale_staging_hours).toBe(24);
});

test("lance root follows STORAGE_DIR even in development", () => {
  const env = { NODE_ENV: "development", STORAGE_DIR: "/x" };
  expect(paths.lancedbRoot({ env })).toBe("/x/lancedb");
  expect(paths.documentsRoot({ env })).toMatch(/server\/storage\/documents$/);
  expect(paths.documentsRoot({ env: { STORAGE_DIR: "/x" } })).toBe(
    "/x/documents"
  );
});

test("backupRoot rejects traversal; prefix helpers", () => {
  expect(() => paths.backupRoot("../x")).toThrow(KnowledgeSyncError);
  expect(paths.ksDocpathPrefix("abc")).toBe("custom-documents/ks-abc");
  expect(paths.lanceTablePath("abc", { env: { STORAGE_DIR: "/x" } })).toBe(
    "/x/lancedb/abc.lance"
  );
});

test("assertSameFilesystem passes in one temp dir", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ksfs-"));
  expect(() =>
    paths.assertSameFilesystem(path.join(d, "a"), path.join(d, "b", "c"))
  ).not.toThrow();
});
