const os = require("os");
const path = require("path");
const fs = require("fs");

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ks-run-"));

const { createHarness, PASS } = require("../../../__mocks__/ksHarness");
const runners = require("../../../utils/knowledgeSync/runners");
const { encryptBuffer } = require("../../../utils/knowledgeSync/crypto");
const {
  buildPublicIndex,
} = require("../../../utils/knowledgeSync/publicIndex");
const {
  MANIFEST_FORMAT_VERSION,
} = require("../../../utils/knowledgeSync/manifest");
const paths = require("../../../utils/knowledgeSync/paths");

const manifest = {
  formatVersion: MANIFEST_FORMAT_VERSION,
  versionId: 3,
  embedder: { modelId: "m", dimension: 4 },
  createdAt: "2026-01-01T00:00:00.000Z",
  files: [{ path: "a", size: 11, sha256: "0".repeat(64) }],
};
const docs = [{ docId: "d1", filename: "f.json", docpath: "f.json" }];
const COMPAT = { ok: true, reasons: [] };

let h, order, d, assets, ctx, previewResult;

async function setup(over = {}) {
  h = createHarness();
  order = [];
  const index = buildPublicIndex(manifest, [
    { size: 10, sha256: "1".repeat(64) },
    { size: 5, sha256: "2".repeat(64) },
  ]);
  const previewEnc = await encryptBuffer(
    Buffer.from(JSON.stringify({ manifest, docs })),
    PASS,
    { kind: "catalog", config: h.cfg }
  );
  assets = {
    "index.json": Buffer.from(JSON.stringify(index)),
    "preview.bin": previewEnc,
  };
  previewResult = {
    previewId: null,
    versionId: 3,
    compatibility: COMPAT,
    blocking: [],
  };
  ctx = h.ctx();
  ctx.setPhase.mockImplementation((p) => order.push("phase:" + p));
  d = {
    getPassphrase: async () => PASS,
    getCatalogStatus: async () => ({
      entries: [
        {
          slug: "ws1",
          randomId: "aaaaaaa1",
          latestVersion: 3,
          maxVersion: 3,
          versions: [{ version: 3, tag: "ks-aaaaaaa1-v3" }],
        },
      ],
    }),
    fetchPublicAsset: jest.fn(async (tag, name, o) => {
      order.push("fetch:" + name);
      return assets[name];
    }),
    effectiveEmbedder: () => ({ modelId: "m", dimension: 4 }),
    previewFromManifest: jest.fn(async () => previewResult),
    downloadPart: jest.fn(async (tag, part, dir, o) => {
      order.push("download:" + part.name);
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(
        path.join(dir, part.name),
        Buffer.alloc(part.size, 1)
      );
      o.onBytes(part.size);
    }),
    previewImport: jest.fn(async ({ archiveName }) => {
      order.push("previewImport");
      const st = fs.statSync(
        path.join(paths.exportsDir({ config: h.cfg }), archiveName)
      );
      expect(st.size).toBe(15);
      return { previewId: "pid-1", versionId: 3, compatibility: COMPAT };
    }),
    confirmImport: jest.fn(async () => {
      order.push("confirmImport");
      return { ok: true };
    }),
    discardStaged: jest.fn(async () => {}),
    ...over,
  };
}
const run = (o = {}) =>
  runners.syncRunner({
    slug: "ws1",
    userId: 7,
    ctx,
    config: h.cfg,
    deps: d,
    accessCtx: { multiUser: false },
    ...o,
  });
const exportsLeft = () => {
  const dir = paths.exportsDir({ config: h.cfg });
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

beforeEach(() => setup());

test("preview shown before any part download; confirm then download->verify->import", async () => {
  let downloadsAtConfirm = -1;
  ctx.awaitConfirm.mockImplementation(async () => {
    downloadsAtConfirm = d.downloadPart.mock.calls.length;
    order.push("awaitConfirm");
  });
  const r = await run();
  expect(r).toEqual({ ok: true });
  expect(downloadsAtConfirm).toBe(0);
  expect(ctx.setPreview).toHaveBeenCalledWith(previewResult);
  expect(order).toEqual([
    "phase:preview",
    "fetch:index.json",
    "fetch:preview.bin",
    "awaitConfirm",
    "phase:download",
    "download:part-0001.bin",
    "download:part-0002.bin",
    "phase:verify",
    "previewImport",
    "phase:import",
    "confirmImport",
  ]);
  expect(d.confirmImport.mock.calls[0][0]).toMatchObject({
    previewId: "pid-1",
    userId: 7,
    passphrase: PASS,
  });
  expect(exportsLeft()).toEqual([]);
});

test("incompatible preview fails before any download or confirm wait", async () => {
  previewResult = {
    ...previewResult,
    compatibility: { ok: false, reasons: [{ code: "KS_E_EMBEDDER_MISMATCH" }] },
    blocking: ["KS_E_EMBEDDER_MISMATCH"],
  };
  await expect(run()).rejects.toMatchObject({ code: "KS_E_EMBEDDER_MISMATCH" });
  expect(d.downloadPart).not.toHaveBeenCalled();
  expect(ctx.awaitConfirm).not.toHaveBeenCalled();
  expect(ctx.setPreview).toHaveBeenCalled();
});

test("index embedder mismatch fails before preview asset or download", async () => {
  d.effectiveEmbedder = () => ({ modelId: "other", dimension: 4 });
  await expect(run()).rejects.toMatchObject({ code: "KS_E_EMBEDDER_MISMATCH" });
  d.effectiveEmbedder = () => ({ modelId: "m", dimension: 8 });
  await expect(run()).rejects.toMatchObject({ code: "KS_E_DIM_MISMATCH" });
  expect(d.downloadPart).not.toHaveBeenCalled();
});

test("oversized index or part fails before download", async () => {
  const small = { ...h.cfg, part_size_bytes: 8 };
  await expect(run({ config: small })).rejects.toMatchObject({
    code: "KS_E_SIZE_LIMIT",
  });
  expect(d.downloadPart).not.toHaveBeenCalled();
});

test("no token or Authorization passed to any download function", async () => {
  await run();
  const all = JSON.stringify([
    d.fetchPublicAsset.mock.calls.map((c) => c.slice(0, 3)),
    d.downloadPart.mock.calls.map((c) => [c[0], c[1], c[2], Object.keys(c[3])]),
  ]);
  expect(all).not.toMatch(/token|authorization|ghp_/i);
  const src = fs.readFileSync(
    require.resolve("../../../utils/knowledgeSync/runners"),
    "utf8"
  );
  expect(src).not.toMatch(/createGithubClient|getPat/);
});

test("cancel during download cleans partial parts and archive", async () => {
  const cancel = Object.assign(new Error("c"), { code: "KS_E_CANCELLED" });
  d.downloadPart.mockImplementationOnce(async (tag, part, dir) => {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, part.name), "partial");
    throw cancel;
  });
  await expect(run()).rejects.toBe(cancel);
  const stg = paths.stagingRoot({ config: h.cfg });
  expect(
    fs.existsSync(stg)
      ? fs.readdirSync(stg).filter((n) => n.startsWith("dl-"))
      : []
  ).toEqual([]);
  expect(exportsLeft()).toEqual([]);
  expect(d.confirmImport).not.toHaveBeenCalled();
});

test("verify mismatch discards staged preview and never imports", async () => {
  d.previewImport = jest.fn(async () => ({
    previewId: "pid-2",
    versionId: 99,
    compatibility: COMPAT,
  }));
  await expect(run()).rejects.toMatchObject({ code: "KS_E_MANIFEST" });
  expect(d.discardStaged).toHaveBeenCalledWith("pid-2", expect.anything());
  expect(d.confirmImport).not.toHaveBeenCalled();
  expect(exportsLeft()).toEqual([]);
});

test("unknown catalog entry is KS_E_NOT_FOUND", async () => {
  await expect(run({ slug: "nope" })).rejects.toMatchObject({
    code: "KS_E_NOT_FOUND",
  });
});

test("rollbackRunner runs verify then import around rollbackWorkspace", async () => {
  const rollbackWorkspace = jest.fn(async () => {
    order.push("rollback");
    return { slug: "ws1" };
  });
  const r = await runners.rollbackRunner({
    slug: "ws1",
    userId: 7,
    ctx,
    accessCtx: { multiUser: false },
    deps: { rollbackWorkspace },
  });
  expect(r).toEqual({ slug: "ws1" });
  expect(order).toEqual(["phase:verify", "phase:import", "rollback"]);
});

test("publishRunner delegates to releases.publishWorkspace", async () => {
  const releases = require("../../../utils/knowledgeSync/releases");
  const spy = jest
    .spyOn(releases, "publishWorkspace")
    .mockResolvedValue({ versionId: 1 });
  expect(await runners.publishRunner({ slug: "ws1" })).toEqual({
    versionId: 1,
  });
  expect(spy).toHaveBeenCalledWith({ slug: "ws1" });
  spy.mockRestore();
});
