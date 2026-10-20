const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  packDirectory,
  extractArchive,
} = require("../../../utils/knowledgeSync/archive");

let root;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-arch-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// Minimal ustar header + body builder for hostile fixtures.
function rawTar(entries) {
  const bufs = [];
  for (const { name, type = "0", linkname = "", body = "" } of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write("0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(Buffer.byteLength(body).toString(8).padStart(11, "0") + "\0", 124);
    h.write("00000000000\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write(linkname, 157, 100);
    h.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    bufs.push(h);
    if (body) {
      const b = Buffer.from(body);
      bufs.push(b, Buffer.alloc((512 - (b.length % 512)) % 512));
    }
  }
  bufs.push(Buffer.alloc(1024));
  return Buffer.concat(bufs);
}

const cfg = {
  max_entries: 1000,
  max_extract_bytes: 1e9,
  staging_dir_name: "ks",
};
const opts = { enforceStagingRoot: false, config: cfg };

test("round trip", async () => {
  const src = path.join(root, "src");
  fs.mkdirSync(path.join(src, "lancedb"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "lancedb", "a.bin"),
    Buffer.from([1, 2, 3, 0])
  );
  fs.writeFileSync(path.join(src, "manifest.enc"), "hello");
  const out = path.join(root, "o.tar");
  await packDirectory(src, out, ["manifest.enc", "lancedb"]);
  const dest = path.join(root, "stage", "job");
  await extractArchive(out, dest, opts);
  expect(fs.readFileSync(path.join(dest, "lancedb", "a.bin"))).toEqual(
    Buffer.from([1, 2, 3, 0])
  );
  expect(fs.readFileSync(path.join(dest, "manifest.enc"), "utf8")).toBe(
    "hello"
  );
});

test("pack does not follow symlinks", async () => {
  const src = path.join(root, "src");
  fs.mkdirSync(path.join(src, "lancedb"), { recursive: true });
  fs.writeFileSync(path.join(root, "secret"), "s");
  fs.symlinkSync(path.join(root, "secret"), path.join(src, "lancedb", "l"));
  fs.writeFileSync(path.join(src, "lancedb", "ok"), "x");
  const out = path.join(root, "o.tar");
  await packDirectory(src, out, ["lancedb"]);
  const dest = path.join(root, "stage", "job");
  await extractArchive(out, dest, opts);
  expect(fs.existsSync(path.join(dest, "lancedb", "l"))).toBe(false);
  expect(fs.existsSync(path.join(dest, "lancedb", "ok"))).toBe(true);
});

const bads = {
  symlink: { name: "lancedb/l", type: "2", linkname: "/etc/passwd" },
  hardlink: { name: "lancedb/h", type: "1", linkname: "lancedb/x" },
  absolute: { name: "/etc/x", body: "x" },
  dotdot: { name: "../escape", body: "x" },
  nested: { name: "lancedb/../../x", body: "x" },
  prefix: { name: "other/x", body: "x" },
  chardev: { name: "lancedb/c", type: "3" },
  fifo: { name: "lancedb/f", type: "6" },
  drive: { name: "C:\\evil", body: "x" },
  unc: { name: "\\\\host\\share\\x", body: "x" },
  backslash: { name: "lancedb\\..\\..\\x", body: "x" },
};
test.each(Object.keys(bads))("rejects %s", async (k) => {
  const f = path.join(root, "bad.tar");
  fs.writeFileSync(f, rawTar([{ name: "lancedb/ok", body: "ok" }, bads[k]]));
  const stage = path.join(root, "stage");
  const dest = path.join(stage, "job");
  await expect(extractArchive(f, dest, opts)).rejects.toMatchObject({
    code: "KS_E_UNSAFE_ENTRY",
  });
  expect(fs.existsSync(dest)).toBe(false);
  expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
  expect(fs.existsSync(path.join(root, "x"))).toBe(false);
});

test("enforces staging root", async () => {
  const f = path.join(root, "a.tar");
  fs.writeFileSync(f, rawTar([{ name: "lancedb/ok", body: "ok" }]));
  await expect(
    extractArchive(f, path.join(root, "x"), { config: cfg })
  ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
});

test("entry and size caps", async () => {
  const f = path.join(root, "a.tar");
  fs.writeFileSync(
    f,
    rawTar([
      { name: "lancedb/a", body: "12345" },
      { name: "lancedb/b", body: "12345" },
    ])
  );
  await expect(
    extractArchive(f, path.join(root, "s1"), {
      ...opts,
      config: { ...cfg, max_entries: 1 },
    })
  ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
  await expect(
    extractArchive(f, path.join(root, "s2"), {
      ...opts,
      config: { ...cfg, max_extract_bytes: 6 },
    })
  ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
});
