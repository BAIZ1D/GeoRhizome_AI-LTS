const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractArchive } = require("../../../utils/knowledgeSync/archive");

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

let root;
let sentinel;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-hostile-"));
  sentinel = path.join(root, "sentinel");
  fs.mkdirSync(sentinel);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const listAll = (d) =>
  fs.readdirSync(d, { recursive: true }).map(String).sort();

// Hostile entry placed AFTER a benign entry, plus variants not in archive.test.js.
const hostile = {
  "absolute path": { name: "/tmp/ks-hostile-abs", body: "x" },
  "dotdot segment": { name: "documents/../../escape", body: "x" },
  hardlink: { name: "db/h", type: "1", linkname: "../sentinel/target" },
  "symlink to outside": { name: "db/s", type: "2", linkname: "../sentinel" },
  "symlink then write through": {
    name: "documents/link",
    type: "2",
    linkname: "..",
  },
  "non-allow-listed top level": { name: "etc/passwd", body: "x" },
  "allow-list prefix lookalike": { name: "lancedb-evil/x", body: "x" },
  "dot-prefixed bypass": { name: "./../escape", body: "x" },
};

test.each(Object.keys(hostile))(
  "rejects %s, zero writes outside staging",
  async (k) => {
    const f = path.join(root, "bad.tar");
    fs.writeFileSync(
      f,
      rawTar([{ name: "lancedb/ok", body: "ok" }, hostile[k]])
    );
    const dest = path.join(root, "stage", "job");
    const before = listAll(root);
    await expect(extractArchive(f, dest, opts)).rejects.toMatchObject({
      code: "KS_E_UNSAFE_ENTRY",
    });
    expect(fs.existsSync(dest)).toBe(false);
    expect(listAll(root)).toEqual(before);
    expect(fs.readdirSync(sentinel)).toEqual([]);
  }
);

test("hostile entry first in archive also leaves nothing behind", async () => {
  const f = path.join(root, "bad2.tar");
  fs.writeFileSync(
    f,
    rawTar([hostile["dotdot segment"], { name: "db/ok", body: "ok" }])
  );
  const before = listAll(root);
  await expect(
    extractArchive(f, path.join(root, "stage", "job"), opts)
  ).rejects.toMatchObject({ code: "KS_E_UNSAFE_ENTRY" });
  expect(listAll(root)).toEqual(before);
});
