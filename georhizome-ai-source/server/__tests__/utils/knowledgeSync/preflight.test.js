const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  requireFreeSpace,
  estimateBytes,
} = require("../../../utils/knowledgeSync/preflight");
const {
  computeIdHashFromArray,
} = require("../../../utils/knowledgeSync/vectorIdHash");

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-pre-"));
});
afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
const cfg = { disk_preflight_factor: 3 };

test("refuses when free space tiny", async () => {
  jest.spyOn(fs.promises, "statfs").mockResolvedValue({ bavail: 1, bsize: 1 });
  await expect(
    requireFreeSpace(root, 100, { config: cfg })
  ).rejects.toMatchObject({ code: "KS_E_DISK_SPACE" });
});
test("passes when large", async () => {
  jest
    .spyOn(fs.promises, "statfs")
    .mockResolvedValue({ bavail: 1e9, bsize: 4096 });
  await expect(
    requireFreeSpace(root, 100, { config: cfg })
  ).resolves.toBeUndefined();
});
test("fails closed when statfs missing", async () => {
  const orig = fs.promises.statfs;
  fs.promises.statfs = undefined;
  try {
    await expect(
      requireFreeSpace(root, 1, { config: cfg })
    ).rejects.toMatchObject({ code: "KS_E_DISK_SPACE" });
  } finally {
    fs.promises.statfs = orig;
  }
});
test("float factor honoured", async () => {
  jest.spyOn(fs.promises, "statfs").mockResolvedValue({ bavail: 24, bsize: 10 });
  const c = { disk_preflight_factor: 2.5 };
  await expect(requireFreeSpace(root, 100, { config: c })).rejects.toMatchObject(
    { code: "KS_E_DISK_SPACE" }
  );
  await expect(
    requireFreeSpace(root, 96, { config: c })
  ).resolves.toBeUndefined();
});
test("estimateBytes sums and rejects symlinks", async () => {
  fs.writeFileSync(path.join(root, "a"), "12345");
  expect(await estimateBytes([root])).toBe(5);
  fs.symlinkSync(path.join(root, "a"), path.join(root, "l"));
  await expect(estimateBytes([root])).rejects.toMatchObject({
    code: "KS_E_UNSAFE_ENTRY",
  });
});
test("id hash stable across order, differs on change, hex64", () => {
  const a = computeIdHashFromArray(["b", "a", "c"]);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(computeIdHashFromArray(["c", "b", "a"])).toBe(a);
  expect(computeIdHashFromArray(["c", "b", "x"])).not.toBe(a);
});
