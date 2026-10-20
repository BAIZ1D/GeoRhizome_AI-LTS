const os = require("os");
const path = require("path");
const fs = require("fs");

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ks-pub-"));

const { createHarness, PASS } = require("../../../__mocks__/ksHarness");
const rel = require("../../../utils/knowledgeSync/releases");
const locks = require("../../../utils/knowledgeSync/locks");
const github = require("../../../utils/knowledgeSync/github");

let h;
beforeEach(() => {
  locks._resetForTests();
  h = createHarness();
});

const publish = (slug, extra = {}) =>
  rel.publishWorkspace({
    slug,
    client: h.mem.client,
    deps: h.deps,
    config: h.cfg,
    passphrase: PASS,
    ctx: h.ctx(),
    ...extra,
  });

const catalogOf = async () =>
  (
    await rel.readLatestCatalog({
      client: h.mem.client,
      deps: h.deps,
      config: h.cfg,
      passphrase: PASS,
    })
  ).catalog;

test("order is draft -> uploads -> publish -> catalog last; reaches upload under real lock", async () => {
  const onCat = jest.fn();
  const r = await publish("ws1", { onCatalogChanged: onCat });
  expect(r.versionId).toBe(1);
  const seq = h.mem.calls.map((c) => c[0] + ":" + (c[1] || ""));
  const iDraft = seq.indexOf("createDraft:ks-aaaaaaa1-v1");
  const iPub = seq.indexOf("publish:ks-aaaaaaa1-v1");
  const iCat = seq.indexOf("publishCatalog:");
  expect(iDraft).toBeGreaterThanOrEqual(0);
  expect(
    seq.slice(iDraft, iPub).filter((s) => s.startsWith("upload:part-")).length
  ).toBe(3);
  expect(seq).toContain("upload:index.json");
  expect(seq).toContain("upload:preview.bin");
  expect(iPub).toBeGreaterThan(iDraft);
  expect(iCat).toBeGreaterThan(iPub);
  expect(h.exportCalls[0]).toMatchObject({
    lockHeld: true,
    versionId: 1,
    overwrite: true,
  });
  expect(onCat).toHaveBeenCalledTimes(1);
  const cat = await catalogOf();
  expect(cat.entries[0]).toMatchObject({
    slug: "ws1",
    latestVersion: 1,
    maxVersion: 1,
  });
  expect(cat.entries[0].versions[0]).toMatchObject({
    parts: 3,
    docCount: 1,
    sizeBytes: 11,
  });
  expect(locks.heldCount()).toBe(0);
});

test("catalog release seq increments with config prefix", async () => {
  await publish("ws1");
  await publish("ws1");
  const tags = h.mem.releases
    .filter((r) => r.tag_name.startsWith("ks-catalog-"))
    .map((r) => r.tag_name);
  expect(tags).toEqual(["ks-catalog-0001", "ks-catalog-0002"]);
});

test("part 2 failure leaves catalog and published releases unchanged", async () => {
  await publish("ws1");
  const before = h.mem.releases.filter((r) => !r.draft).map((r) => r.tag_name);
  let n = 0;
  h.mem.fail.upload = (name) => name.startsWith("part-") && ++n === 2;
  await expect(publish("ws1")).rejects.toThrow();
  expect(h.mem.releases.filter((r) => !r.draft).map((r) => r.tag_name)).toEqual(
    before
  );
  expect((await catalogOf()).entries[0].latestVersion).toBe(1);
  expect(locks.heldCount()).toBe(0);
});

test("catalog publish failure deletes the version release and keeps prior catalog", async () => {
  await publish("ws1");
  h.mem.fail.publishCatalog = () => true;
  await expect(publish("ws1")).rejects.toThrow();
  expect(h.mem.releases.some((r) => r.tag_name === "ks-aaaaaaa1-v2")).toBe(
    false
  );
  expect(
    h.mem.calls.some(
      (c) => c[0] === "deleteRelease" && c[1] === "ks-aaaaaaa1-v2"
    )
  ).toBe(true);
  h.mem.fail.publishCatalog = null;
  expect((await catalogOf()).entries[0].latestVersion).toBe(1);
});

test("stale drafts for the workspace are deleted, published never", async () => {
  await publish("ws1");
  await h.mem.client.createDraftRelease({ tag: "ks-aaaaaaa1-v7" });
  await h.mem.client.createDraftRelease({ tag: "ks-bbbbbbb2-v3" });
  await publish("ws1");
  const tags = h.mem.releases.map((r) => r.tag_name);
  expect(tags).not.toContain("ks-aaaaaaa1-v7");
  expect(tags).toContain("ks-bbbbbbb2-v3");
  expect(tags).toContain("ks-aaaaaaa1-v1");
  expect(tags).toContain("ks-aaaaaaa1-v8");
});

test("concurrent publishes for different slugs both land in the catalog", async () => {
  await Promise.all([publish("ws1"), publish("ws2")]);
  const cat = await catalogOf();
  expect(cat.entries.map((e) => e.slug).sort()).toEqual(["ws1", "ws2"]);
});

test("leftover catalog draft is cleaned and fetchPublicCatalog returns newest published seq", async () => {
  await publish("ws1");
  await h.mem.client.createDraftRelease({ tag: "ks-catalog-0004" });
  await publish("ws2");
  expect(
    h.mem.releases.some((r) => r.tag_name === "ks-catalog-0004" && r.draft)
  ).toBe(false);
  const found = await github.fetchPublicCatalog({
    config: h.cfg,
    fetchImpl: h.mem.fetchImpl,
    persistHint: false,
  });
  expect(found.seq).toBe(2);
});

test("preflight failures: no passphrase, unknown workspace", async () => {
  await expect(
    rel.publishWorkspace({
      slug: "ws1",
      client: h.mem.client,
      config: h.cfg,
      deps: { ...h.deps, getPassphrase: async () => null },
    })
  ).rejects.toMatchObject({ code: "KS_E_PASSPHRASE" });
  await expect(publish("nope")).rejects.toMatchObject({
    code: "KS_E_NOT_FOUND",
  });
});
