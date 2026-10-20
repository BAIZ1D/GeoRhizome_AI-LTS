const os = require("os");
const path = require("path");
const fs = require("fs");

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ks-del-"));

const { createHarness, PASS } = require("../../../__mocks__/ksHarness");
const rel = require("../../../utils/knowledgeSync/releases");
const locks = require("../../../utils/knowledgeSync/locks");

let h;
beforeEach(() => {
  locks._resetForTests();
  h = createHarness();
});
const base = () => ({
  client: h.mem.client,
  deps: h.deps,
  config: h.cfg,
  passphrase: PASS,
});
const publish = (slug) =>
  rel.publishWorkspace({ slug, ...base(), ctx: h.ctx() });
const catalog = async () => (await rel.readLatestCatalog(base())).catalog;

test("catalog release is published before the version release is deleted", async () => {
  await publish("ws1");
  h.mem.calls.length = 0;
  await rel.deleteVersion({ slug: "ws1", version: 1, ...base() });
  const names = h.mem.calls.map((c) => c[0] + ":" + (c[1] || ""));
  const iCat = names.indexOf("publishCatalog:");
  const iDel = names.indexOf("deleteRelease:ks-aaaaaaa1-v1");
  expect(iCat).toBeGreaterThanOrEqual(0);
  expect(iDel).toBeGreaterThan(iCat);
  expect(h.mem.releases.some((r) => r.tag_name === "ks-aaaaaaa1-v1")).toBe(
    false
  );
});

test("catalog update is always a new release, never an asset replace/delete", async () => {
  await publish("ws1");
  const before = h.mem.releases.filter((r) =>
    r.tag_name.startsWith("ks-catalog-")
  ).length;
  await rel.deleteVersion({ slug: "ws1", version: 1, ...base() });
  const after = h.mem.releases.filter((r) =>
    r.tag_name.startsWith("ks-catalog-")
  ).length;
  expect(after).toBe(before + 1);
  expect(h.mem.calls.some((c) => /replaceAsset|deleteAsset/.test(c[0]))).toBe(
    false
  );
  expect(h.mem.client.replaceAsset).toBeUndefined();
});

test("deleting latest falls back to next-highest", async () => {
  await publish("ws1");
  await publish("ws1");
  await rel.deleteVersion({ slug: "ws1", version: 2, ...base() });
  const e = (await catalog()).entries[0];
  expect(e.latestVersion).toBe(1);
  expect(e.maxVersion).toBe(2);
});

test("deleting the last version leaves a tombstone entry", async () => {
  await publish("ws1");
  await rel.deleteVersion({ slug: "ws1", version: 1, ...base() });
  const e = (await catalog()).entries[0];
  expect(e).toMatchObject({ versions: [], latestVersion: 0, maxVersion: 1 });
});

test("tag deletion refusal does not fail deleteVersion", async () => {
  await publish("ws1");
  h.mem.fail.deleteTag = () => true;
  await expect(
    rel.deleteVersion({ slug: "ws1", version: 1, ...base() })
  ).resolves.toMatchObject({ version: 1 });
  expect((await catalog()).entries[0].versions).toEqual([]);
});

test("unknown version or slug is KS_E_NOT_FOUND and nothing changes", async () => {
  await publish("ws1");
  await expect(
    rel.deleteVersion({ slug: "ws1", version: 5, ...base() })
  ).rejects.toMatchObject({ code: "KS_E_NOT_FOUND" });
  await expect(
    rel.deleteVersion({ slug: "zzz", version: 1, ...base() })
  ).rejects.toMatchObject({ code: "KS_E_NOT_FOUND" });
  expect(
    h.mem.releases.filter((r) => r.tag_name.startsWith("ks-catalog-")).length
  ).toBe(1);
});
