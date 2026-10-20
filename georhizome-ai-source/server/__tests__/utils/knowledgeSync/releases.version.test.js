const os = require("os");
const path = require("path");
const fs = require("fs");

process.env.STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ks-ver-"));

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

test("nextVersion takes max over maxVersion, latestVersion and all tags incl drafts", async () => {
  await h.mem.client.createDraftRelease({ tag: "ks-aaaaaaa1-v9" });
  await h.mem.client.createDraftRelease({ tag: "ks-bbbbbbb2-v40" });
  const entry = { maxVersion: 4, latestVersion: 3 };
  expect(await rel.nextVersion(h.mem.client, entry, "aaaaaaa1")).toBe(10);
  expect(await rel.nextVersion(h.mem.client, entry, "ccccccc3")).toBe(5);
  expect(await rel.nextVersion(h.mem.client, null, "ccccccc3")).toBe(1);
});

test("deleted latest number is never reused (publish 1, delete 1, publish -> 2)", async () => {
  await publish("ws1");
  await rel.deleteVersion({ slug: "ws1", version: 1, ...base() });
  const cat = (await rel.readLatestCatalog({ ...base() })).catalog;
  expect(cat.entries[0]).toMatchObject({
    versions: [],
    maxVersion: 1,
    latestVersion: 0,
  });
  const r = await publish("ws1");
  expect(r.versionId).toBe(2);
});

test("listVersions returns latest, versions and drafts", async () => {
  await publish("ws1");
  await publish("ws1");
  await h.mem.client.createDraftRelease({ tag: "ks-aaaaaaa1-v9" });
  const l = await rel.listVersions({ slug: "ws1", ...base() });
  expect(l.latest).toBe(2);
  expect(l.versions.map((v) => v.version)).toEqual([1, 2]);
  expect(l.drafts).toEqual([{ tag: "ks-aaaaaaa1-v9" }]);
});
