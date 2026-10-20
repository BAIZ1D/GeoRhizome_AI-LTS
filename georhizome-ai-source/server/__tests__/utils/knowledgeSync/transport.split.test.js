const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  splitFile,
  reassemble,
} = require("../../../utils/knowledgeSync/transport");

test("split 2.5x partSize into 3 parts and reassemble identical", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-split-"));
  const src = path.join(dir, "a.bin");
  const buf = Buffer.alloc(2500, 7);
  buf[1234] = 1;
  fs.writeFileSync(src, buf);
  const parts = await splitFile(src, 1000, path.join(dir, "p"));
  expect(parts.map((p) => p.name)).toEqual([
    "part-0001.bin",
    "part-0002.bin",
    "part-0003.bin",
  ]);
  expect(parts.map((p) => p.size)).toEqual([1000, 1000, 500]);
  expect(parts.reduce((a, p) => a + p.size, 0)).toBe(2500);
  expect(parts[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  const dest = path.join(dir, "out.bin");
  await reassemble(path.join(dir, "p"), parts, dest);
  expect(fs.readFileSync(dest).equals(buf)).toBe(true);
});
