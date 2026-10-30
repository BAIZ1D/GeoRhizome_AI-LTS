// Spike S2 exporter: read-only export of REAL Japanese chunks to JSONL.
// Rows: {"slug","text","source"}. Fixtures (ks-*, e2e) are excluded.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const require = createRequire(
  path.join(root, "georhizome-ai-source/server/package.json")
);

const args = process.argv.slice(2);
const getAll = (k) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === k) out.push(args[++i]);
  return out;
};
const getOne = (k, d) => getAll(k)[0] ?? d;

const lancedbDir = getOne(
  "--lancedb-dir",
  path.join(root, "georhizome-ai-source/server/storage/lancedb")
);
const docsDirs = getAll("--docs-dir");
if (docsDirs.length === 0)
  docsDirs.push(
    path.join(os.homedir(), ".georhizome/storage/documents/custom-documents")
  );
const corpusDirs = getAll("--corpus-dir");
const max = parseInt(getOne("--max", "3000"), 10);
const minN = parseInt(getOne("--min-n", "200"), 10);
const out = getOne(
  "--out",
  path.join(
    root,
    ".planning/phases/10-spike-gate-sparse-server/spike-data/chunks.jsonl"
  )
);

const EXCLUDE = /^ks-|(^|[-_.])e2e([-_.]|$)/i;
const CJK = /[぀-ヿ㐀-鿿]/g;
const cfg = JSON.parse(
  fs.readFileSync(path.join(root, "config/app_config.json"), "utf8")
);
const chunkSize = cfg.text_splitter.chunk_size;

const rows = [];
const sources = [];
const excluded = [];

function pushRow(slug, text, source) {
  if (rows.length >= max) return false;
  rows.push({ slug, text, source });
  return true;
}

function chunk(text) {
  const parts = [];
  for (let i = 0; i < text.length; i += chunkSize)
    parts.push(text.slice(i, i + chunkSize));
  return parts.filter((p) => p.trim().length > 0);
}

async function fromLance() {
  if (!fs.existsSync(lancedbDir)) return;
  let lancedb;
  try {
    lancedb = require("@lancedb/lancedb");
  } catch (e) {
    console.error("lancedb not loadable:", e.message);
    return;
  }
  const db = await lancedb.connect(lancedbDir);
  for (const name of await db.tableNames()) {
    if (EXCLUDE.test(name)) {
      excluded.push(name);
      continue;
    }
    const tbl = await db.openTable(name);
    const data = await tbl.query().select(["text"]).limit(max).toArray();
    let n = 0;
    for (const r of data) {
      const t = r.text;
      if (typeof t !== "string") continue;
      if ((t.match(CJK) || []).length < 20) continue;
      if (pushRow(name, t, `lance:${name}`)) n++;
    }
    sources.push({ kind: "lance", name, count: n });
  }
}

function walk(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (EXCLUDE.test(e.name)) excluded.push(p);
      else files.push(...walk(p));
    } else files.push(p);
  }
  return files;
}

function fromFiles(kind, dirs) {
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of walk(dir)) {
      const base = path.basename(f);
      if (!/\.(md|txt)$/i.test(base)) continue;
      if (EXCLUDE.test(base)) {
        excluded.push(base);
        continue;
      }
      const text = fs.readFileSync(f, "utf8");
      if ((text.match(CJK) || []).length < 20) {
        console.error("skip (<20 CJK):", base);
        continue;
      }
      let n = 0;
      for (const c of chunk(text)) if (pushRow(base, c, `${kind}:${base}`)) n++;
      sources.push({ kind, name: base, count: n });
    }
  }
}

await fromLance();
fromFiles("docs", docsDirs);
fromFiles("corpus-dir", corpusDirs);

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
const thin = rows.length < minN;
fs.writeFileSync(
  out.replace(/chunks\.jsonl$/, "chunks.provenance.json"),
  JSON.stringify(
    { sources, excluded, total_n: rows.length, min_n: minN, thin },
    null,
    2
  )
);
console.log(`EXPORTED_ROWS=${rows.length}`);
console.log(`THIN=${thin}`);
process.exit(rows.length === 0 ? 1 : 0);
