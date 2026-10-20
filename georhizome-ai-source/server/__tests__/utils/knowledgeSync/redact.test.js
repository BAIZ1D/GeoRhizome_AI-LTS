const crypto = require("crypto");
const path = require("path");
const {
  redact,
  registerSecret,
} = require("../../../utils/knowledgeSync/redact");
const {
  KnowledgeSyncError,
  toClientError,
} = require("../../../utils/knowledgeSync/errors");
const {
  stagingRoot,
  assertSafeSlug,
  assertWithin,
} = require("../../../utils/knowledgeSync/paths");

const rnd = (n) => crypto.randomBytes(n).toString("hex").slice(0, n);

test("redacts token shapes", () => {
  const t = "gh" + "p_" + rnd(36);
  const out = redact("token " + t);
  expect(out).toContain("[REDACTED]");
  expect(out).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  expect(redact("github" + "_pat_" + rnd(60))).toBe("[REDACTED]");
  expect(redact("Authorization: Bearer xyz")).not.toContain("xyz");
});
test("registered secrets, errors, nested", () => {
  const pw = "hunter2-" + rnd(8);
  registerSecret(pw);
  expect(redact(`a ${pw} b`)).not.toContain(pw);
  expect(redact(new Error(`bad ${pw}`)).message).not.toContain(pw);
  expect(JSON.stringify(redact({ a: { b: [pw] } }))).not.toContain(pw);
});
test("errors", () => {
  const e = new KnowledgeSyncError("KS_E_PASSPHRASE");
  expect(e.code).toBe("KS_E_PASSPHRASE");
  expect(e.name).toBe("KnowledgeSyncError");
  const c = toClientError(e);
  expect(Object.keys(c).sort()).toEqual(["code", "message"]);
  expect(toClientError(new Error("x")).code).toBe("KS_E_UNKNOWN");
});
test("slugs", () => {
  expect(assertSafeSlug("my-ws_1")).toBe("my-ws_1");
  for (const s of ["../x", "a b", "", "a".repeat(65)])
    expect(() => assertSafeSlug(s)).toThrow(KnowledgeSyncError);
});
test("posix containment", () => {
  const root = stagingRoot({ env: { STORAGE_DIR: "/data/storage" } });
  expect(root).toBe(path.join("/data/storage", "knowledge-sync-staging"));
  expect(() => assertWithin(root, root + "/../x")).toThrow();
  expect(assertWithin(root, path.join(root, "a"))).toBe(path.join(root, "a"));
});
test("windows paths", () => {
  const w = path.win32;
  const root = stagingRoot({
    pathImpl: w,
    env: { STORAGE_DIR: "C:\\Users\\a b\\storage" },
  });
  expect(root).toBe("C:\\Users\\a b\\storage\\knowledge-sync-staging");
  expect(() => assertWithin(root, "C:\\Users\\a b\\other", w)).toThrow();
  expect(() => assertWithin(root, "D:\\x", w)).toThrow();
  expect(() => assertWithin(root, root + "\\..\\x", w)).toThrow();
});
