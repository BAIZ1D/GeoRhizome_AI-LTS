const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  getKnowledgeSyncConfig,
  DEFAULTS,
} = require("../../../utils/knowledgeSync/config");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-cfg-"));
const write = (name, content) => {
  const p = path.join(dir, name);
  fs.writeFileSync(
    p,
    typeof content === "string" ? content : JSON.stringify(content)
  );
  return p;
};
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

test("full block loaded", () => {
  const p = write("a.json", {
    knowledge_sync: {
      ...DEFAULTS,
      repo: "x/y",
      part_size_bytes: 5,
      scrypt: { N: 1024, r: 8, p: 1, maxmem_bytes: 99, salt_bytes: 16 },
    },
  });
  const c = getKnowledgeSyncConfig({ configPath: p });
  expect(c.repo).toBe("x/y");
  expect(c.part_size_bytes).toBe(5);
  expect(c.scrypt.N).toBe(1024);
  expect(c.allowedScryptParams[0]).toEqual({ N: 1024, r: 8, p: 1 });
});
test("missing block -> defaults", () => {
  const c = getKnowledgeSyncConfig({
    configPath: write("b.json", { other: 1 }),
  });
  expect(c.repo).toBe(DEFAULTS.repo);
  expect(c.scrypt).toEqual(DEFAULTS.scrypt);
});
test("invalid field falls back, others kept", () => {
  const c = getKnowledgeSyncConfig({
    configPath: write("c.json", {
      knowledge_sync: {
        chunk_size_bytes: -1,
        repo: "a/b",
        scrypt: { N: "big" },
      },
    }),
  });
  expect(c.chunk_size_bytes).toBe(DEFAULTS.chunk_size_bytes);
  expect(c.repo).toBe("a/b");
  expect(c.scrypt.N).toBe(DEFAULTS.scrypt.N);
});
test("bad JSON -> defaults", () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const c = getKnowledgeSyncConfig({ configPath: write("d.json", "{nope") });
  expect(c.repo).toBe(DEFAULTS.repo);
  warn.mockRestore();
});
