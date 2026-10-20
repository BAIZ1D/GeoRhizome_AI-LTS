const locks = require("../../../utils/knowledgeSync/locks");
const marker = require("../../../utils/knowledgeSync/marker");

jest.mock("../../../utils/prisma", () => ({
  system_settings: { findFirst: jest.fn() },
}));

beforeEach(() => locks._resetForTests());

test("export while embed held is BUSY", () => {
  locks.acquire("a", "embed");
  expect(() => locks.acquire("a", "export")).toThrow(
    expect.objectContaining({ code: "KS_E_BUSY" })
  );
});

test("embed+embed shares, needs two releases", () => {
  locks.acquire("a", "embed");
  locks.acquire("a", "embed");
  locks.release("a", "embed");
  expect(locks.state("a").embedRefs).toBe(1);
  locks.release("a", "embed");
  expect(locks.state("a")).toBeNull();
});

test("import makes syncing true; assertNotSyncing throws", () => {
  locks.acquire("a", "import", "j1");
  expect(locks.syncing("a")).toBe(true);
  expect(() => locks.assertNotSyncing("a")).toThrow(
    expect.objectContaining({ code: "KS_E_SYNCING" })
  );
  expect(locks.heldCount()).toBe(1);
});

test("withWorkspaceLock releases on throw; release unheld is no-op", async () => {
  await expect(
    locks.withWorkspaceLock("a", "export", async () => {
      throw new Error("x");
    })
  ).rejects.toThrow("x");
  expect(locks.state("a")).toBeNull();
  expect(() => locks.release("zzz", "embed")).not.toThrow();
});

test("corrupt marker JSON returns null", async () => {
  require("../../../utils/prisma").system_settings.findFirst.mockResolvedValue({
    value: "{not json",
  });
  expect(await marker.readMarker("a")).toBeNull();
});
