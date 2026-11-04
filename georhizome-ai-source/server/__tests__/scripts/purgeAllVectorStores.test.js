const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT = path.resolve(
  __dirname,
  "../../../../scripts/purge_all_vector_stores.sh"
);

function have(bin) {
  return spawnSync("which", [bin]).status === 0;
}
const d = have("sqlite3") && have("python3") ? describe : describe.skip;

function makeRoot(paths) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "purge-"));
  fs.mkdirSync(path.join(root, "config"), { recursive: true });
  const src = path.join(root, "georhizome-ai-source", "server");
  fs.mkdirSync(path.join(src, "storage", "lancedb", "t.lance"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(src, "storage", "vector-cache"), { recursive: true });
  fs.writeFileSync(path.join(src, "storage", "lancedb", "t.lance", "a"), "x");
  fs.writeFileSync(path.join(src, "storage", "vector-cache", "c.json"), "x");
  fs.writeFileSync(
    path.join(root, "config", "app_config.json"),
    JSON.stringify({
      paths: paths || {
        lancedb_dir: "server/storage/lancedb",
        vector_cache_dir: "server/storage/vector-cache",
      },
    })
  );
  const db = path.join(src, "storage", "anythingllm.db");
  const r = spawnSync("sqlite3", [
    db,
    "create table document_vectors(id int); insert into document_vectors values(1),(2); create table other(id int); insert into other values(1);",
  ]);
  expect(r.status).toBe(0);
  return { root, src, db };
}

function run(args, env = {}) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, STORAGE_DIR: "", ...env },
  });
}
const count = (db, t) =>
  Number(spawnSync("sqlite3", [db, `select count(*) from ${t};`]).stdout);

d("purge_all_vector_stores.sh", () => {
  test("dry-run changes nothing and prints targets", () => {
    const { root, src, db } = makeRoot();
    const r = run(["--root", root, "--dry-run"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("would remove: " + path.join(src, "storage", "lancedb"));
    expect(r.stdout).toContain("would clear table: document_vectors");
    expect(fs.existsSync(path.join(src, "storage", "lancedb", "t.lance", "a"))).toBe(true);
    expect(count(db, "document_vectors")).toBe(2);
  });

  test("real run empties dirs and clears only document_vectors; warns ja+en", () => {
    const { root, src, db } = makeRoot();
    const r = run(["--root", root, "--skip-port-check"]);
    expect(r.status).toBe(0);
    expect(fs.readdirSync(path.join(src, "storage", "lancedb"))).toEqual([]);
    expect(fs.readdirSync(path.join(src, "storage", "vector-cache"))).toEqual([]);
    expect(count(db, "document_vectors")).toBe(0);
    expect(count(db, "other")).toBe(1);
    expect(r.stdout).toContain("再アップロード");
    expect(r.stdout).toContain("re-upload");
  });

  test.each([[""], ["/"], ["../x"]])("rejects unsafe lancedb_dir %p", (bad) => {
    const { root, src } = makeRoot({
      lancedb_dir: bad,
      vector_cache_dir: "server/storage/vector-cache",
    });
    const r = run(["--root", root, "--skip-port-check"]);
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(src, "storage", "vector-cache", "c.json"))).toBe(true);
    expect(fs.existsSync(path.join(src, "storage", "lancedb", "t.lance", "a"))).toBe(true);
  });

  test("port default from SERVER_PORT in server/.env", async () => {
    const { root, src } = makeRoot();
    const server = net.createServer();
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    fs.writeFileSync(path.join(src, ".env"), `SERVER_PORT=${port}\n`);
    const r = await new Promise((res) => {
      const { spawn } = require("child_process");
      const p = spawn("bash", [SCRIPT, "--root", root], {
        env: { ...process.env, STORAGE_DIR: "" },
      });
      let err = "";
      p.stderr.on("data", (c) => (err += c));
      p.on("close", (code) => res({ code, err }));
    });
    server.close();
    expect(r.code).toBe(3);
    expect(r.err).toContain(String(port));
  });

  test("listening port via --port refuses without --skip-port-check", async () => {
    const { root, src } = makeRoot();
    const server = net.createServer();
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    const r = await new Promise((res) => {
      const { spawn } = require("child_process");
      const p = spawn("bash", [SCRIPT, "--root", root, "--port", String(port)], {
        env: { ...process.env, STORAGE_DIR: "" },
      });
      p.on("close", (code) => res({ code }));
    });
    server.close();
    expect(r.code).toBe(3);
    expect(fs.existsSync(path.join(src, "storage", "vector-cache", "c.json"))).toBe(true);
  });
});
