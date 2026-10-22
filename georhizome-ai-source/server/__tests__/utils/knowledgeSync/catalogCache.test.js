const cache = require("../../../utils/knowledgeSync/catalogCache");
const { KnowledgeSyncError } = require("../../../utils/knowledgeSync/errors");
const { getKnowledgeSyncConfig } = require("../../../utils/knowledgeSync/config");

const TTL = getKnowledgeSyncConfig().catalog_cache_ttl_ms;
const CAT = {
  formatVersion: 2,
  entries: [
    {
      name: "WS",
      slug: "ws",
      randomId: "abcdef01",
      latestVersion: 3,
      maxVersion: 3,
      versions: [
        {
          version: 3,
          tag: "ks-abcdef01-v3",
          parts: 1,
          sizeBytes: 10,
          docCount: 1,
          publishedAt: "2026-01-01T00:00:00Z",
        },
      ],
    },
  ],
};

function setup(over = {}) {
  const clock = { t: 1000 };
  const d = {
    now: () => clock.t,
    secrets: {
      passphraseStatus: jest.fn(async () => ({ configured: true })),
      getPassphrase: jest.fn(async () => "pass-phrase-long"),
    },
    github: {
      readCatalogSeqHint: jest.fn(() => 2),
      fetchPublicCatalog: jest.fn(async () => ({
        seq: 2,
        buffer: Buffer.from("enc"),
      })),
      fetchPublicAsset: jest.fn(),
    },
    marker: {
      readMarker: jest.fn(async () => ({
        versionId: 2,
        sourceRandomId: "abcdef01",
      })),
    },
    crypto: {
      decryptBuffer: jest.fn(async () => Buffer.from(JSON.stringify(CAT))),
    },
    transport: { cryptoSemaphore: () => ({ run: (fn) => fn() }) },
    ...over,
  };
  cache._setDepsForTests(d);
  return { d, clock };
}

test("no passphrase: configured false, no network call", async () => {
  const { d } = setup({
    secrets: { passphraseStatus: async () => ({ configured: false }) },
  });
  const r = await cache.getCatalogStatus({});
  expect(r).toMatchObject({ configured: false, entries: [] });
  expect(d.github.fetchPublicCatalog).not.toHaveBeenCalled();
});

test("TTL hit and miss, updateAvailable, token-free fetch only", async () => {
  const { d, clock } = setup();
  const r = await cache.getCatalogStatus({});
  expect(r.entries[0]).toMatchObject({
    slug: "ws",
    updateAvailable: true,
    localVersion: 2,
  });
  expect(r.localVersions).toEqual({ ws: 2 });
  expect(d.github.fetchPublicCatalog).toHaveBeenCalledTimes(1);
  expect(d.github.fetchPublicCatalog.mock.calls[0][0].startSeq).toBe(2);
  expect(d.crypto.decryptBuffer.mock.calls[0][2].kind).toBe("catalog");
  clock.t += TTL - 1;
  await cache.getCatalogStatus({});
  expect(d.github.fetchPublicCatalog).toHaveBeenCalledTimes(1);
  clock.t += 2;
  await cache.getCatalogStatus({});
  expect(d.github.fetchPublicCatalog).toHaveBeenCalledTimes(2);
  await cache.refresh();
  expect(d.github.fetchPublicCatalog).toHaveBeenCalledTimes(3);
  cache.invalidate();
  await cache.getCatalogStatus({});
  expect(d.github.fetchPublicCatalog).toHaveBeenCalledTimes(4);
  const urls = JSON.stringify(d.github.fetchPublicCatalog.mock.calls);
  expect(urls).not.toContain("api.github.com");
});

test("no update when marker belongs to another source", async () => {
  setup({
    marker: {
      readMarker: async () => ({ versionId: 1, sourceRandomId: "deadbeef" }),
    },
  });
  const r = await cache.getCatalogStatus({});
  expect(r.entries[0].updateAvailable).toBe(false);
  expect(r.entries[0].localVersion).toBeNull();
});

test("stale fallback keeps last good cache; no cache gives error", async () => {
  const { d, clock } = setup();
  await cache.getCatalogStatus({});
  d.github.fetchPublicCatalog.mockRejectedValue(
    new KnowledgeSyncError("KS_E_GITHUB")
  );
  clock.t += TTL + 1;
  const r = await cache.getCatalogStatus({});
  expect(r.stale).toBe(true);
  expect(r.error.code).toBe("KS_E_CATALOG");
  expect(r.entries).toHaveLength(1);

  const { d: d2 } = setup();
  d2.crypto.decryptBuffer.mockRejectedValue(
    new KnowledgeSyncError("KS_E_PASSPHRASE")
  );
  const r2 = await cache.getCatalogStatus({});
  expect(r2.error.code).toBe("KS_E_PASSPHRASE");
  expect(r2.entries).toEqual([]);
});

test("readCatalogAuthoritative picks highest published seq", async () => {
  const { d } = setup();
  d.github.fetchPublicAsset.mockResolvedValue(Buffer.from("enc"));
  const client = {
    listReleasesByTagPrefix: async () => [
      { tag_name: "ks-catalog-0001", draft: false },
      { tag_name: "ks-catalog-0003", draft: false },
      { tag_name: "ks-catalog-0004", draft: true },
    ],
  };
  const r = await cache.readCatalogAuthoritative({ client });
  expect(r.seq).toBe(3);
  expect(d.github.fetchPublicAsset.mock.calls[0][0]).toBe("ks-catalog-0003");
  const empty = await cache.readCatalogAuthoritative({
    client: { listReleasesByTagPrefix: async () => [] },
  });
  expect(empty).toMatchObject({ seq: 0 });
});

test("empty catalog (none published) is success: checkedAt set, no error, cached", async () => {
  const { d, clock } = setup();
  d.github.fetchPublicCatalog.mockRejectedValue(
    new KnowledgeSyncError("KS_E_CATALOG", { phase: "empty" })
  );
  const r = await cache.getCatalogStatus({});
  expect(r).toMatchObject({
    configured: true,
    error: null,
    entries: [],
    stale: false,
  });
  expect(typeof r.checkedAt).toBe("string");
  await cache.getCatalogStatus({});
  expect(d.github.fetchPublicCatalog).toHaveBeenCalledTimes(1);
  clock.t += 1;
});

test("real catalog failure still reports error without checkedAt", async () => {
  const { d } = setup();
  d.github.fetchPublicCatalog.mockRejectedValue(
    new KnowledgeSyncError("KS_E_GITHUB")
  );
  const r = await cache.getCatalogStatus({});
  expect(r.error.code).toBe("KS_E_CATALOG");
  expect(r.checkedAt).toBeNull();
});
