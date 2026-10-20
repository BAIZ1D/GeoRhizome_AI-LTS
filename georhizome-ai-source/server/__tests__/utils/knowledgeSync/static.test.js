const fs = require("fs");
const path = require("path");

const serverRoot = path.resolve(__dirname, "../../..");
const repoRoot = path.resolve(serverRoot, "../..");

function walk(dir, skip, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, skip, out);
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

test("knowledgeSync code has no child_process or __dirname storage", () => {
  const dir = path.join(serverRoot, "utils/knowledgeSync");
  const files = walk(dir, new Set());
  const ep = path.join(serverRoot, "endpoints/knowledgeSync.js");
  if (fs.existsSync(ep)) files.push(ep);
  const bad = /child_process|execSync|\bexec\(|\bspawn\(/;
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    expect({ f, hit: bad.test(src) }).toEqual({ f, hit: false });
    expect({
      f,
      hit: /__dirname.*storage/.test(src) && !f.endsWith("paths.js"),
    }).toEqual({ f, hit: false });
    if (
      !f.endsWith(path.join("knowledgeSync", "config.js")) &&
      !f.endsWith("paths.js")
    ) {
      expect({ f, hit: src.includes("__dirname") }).toEqual({ f, hit: false });
    }
  }
});

test("no PAT-shaped tokens in working tree", () => {
  const skip = new Set([
    "node_modules",
    ".git",
    ".planning",
    "__pycache__",
    "graphify-out",
    "dist",
    "storage",
    ".venv",
  ]);
  const re1 = /gh[pousr]_[A-Za-z0-9]{36,}/;
  const re2 = /github_pat_[A-Za-z0-9_]{60,}/;
  const hits = [];
  for (const f of walk(repoRoot, skip)) {
    let st;
    try {
      st = fs.statSync(f);
    } catch (_e) {
      continue;
    }
    if (st.size > 2 * 1024 * 1024) continue;
    let s;
    try {
      s = fs.readFileSync(f, "latin1");
    } catch (_e) {
      continue;
    }
    if (re1.test(s) || re2.test(s)) hits.push(path.relative(repoRoot, f));
  }
  expect(hits).toEqual([]);
});

test("legacy token/exec usage is gone from knowledge-sync code and legacy routes", () => {
  const files = walk(path.join(serverRoot, "utils/knowledgeSync"), new Set());
  files.push(path.join(serverRoot, "endpoints/knowledgeSync.js"));
  files.push(path.join(serverRoot, "endpoints/system.js"));
  for (const f of files) {
    const src = fs.readFileSync(f, "utf8");
    expect({ f, hit: /GHCR_READ_TOKEN|\bexecSync\b/.test(src) }).toEqual({
      f,
      hit: false,
    });
  }
  const legacy =
    /\/(?:api\/)?system\/(upload-workspace|sync-workspace|workspace-vectors)/;
  const skip = new Set(["node_modules", "__tests__", "storage", "dist"]);
  // Frontend scan deferred: KnowledgeSync.jsx is rewritten in the UI plan (07-06+).
  const scan = [...walk(serverRoot, skip)].filter((f) => /\.(js|jsx)$/.test(f));
  const hits = scan.filter((f) => legacy.test(fs.readFileSync(f, "utf8")));
  expect(hits.map((f) => path.relative(repoRoot, f))).toEqual([]);
});
