// S4: addColumns on a COPY of a populated table + real LanceDb.updateOrCreateCollection cases (a)-(d).
// Run under Node 18.18.0: fnm exec --using=18.18.0 node scripts/spike_lance_addcolumns.mjs --work-dir DIR [--src <slug>.lance]
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../georhizome-ai-source/server");
const liveDir = path.join(serverDir, "storage", "lancedb");
const indexPath = path.join(serverDir, "utils/vectorDbProviders/lance/index.js");
const req = createRequire(indexPath);
const lancedb = req("@lancedb/lancedb");
const arrow = req("apache-arrow");

const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const workRoot = path.resolve(a["work-dir"] || fs.mkdtempSync(path.join(os.tmpdir(), "s4-")));
if (workRoot.startsWith(path.join(serverDir, "storage"))) throw new Error("refusing live storage as work-dir");
fs.mkdirSync(workRoot, { recursive: true });

let failures = 0;
const check = (cond, msg) => { console.log(`  [${cond ? "ok" : "FAIL"}] ${msg}`); if (!cond) failures++; };

// ---- source table
let srcLance = a.src;
if (!srcLance && fs.existsSync(liveDir)) {
  const c = fs.readdirSync(liveDir).filter((n) => n.endsWith(".lance"));
  srcLance = c.length ? path.join(liveDir, c[0]) : null;
}
const slug = srcLance ? path.basename(srcLance, ".lance") : "standin";
const TABLE = slug;
console.log(`node=${process.version}`);
console.log(`source table slug sha256[:12]=${crypto.createHash("sha256").update(slug).digest("hex").slice(0, 12)}`);

let standin = false;
function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }

async function makeStandin(dst) {
  const db = await lancedb.connect(dst);
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `r${i}`, text: `t${i}`, vector: Array.from({ length: 768 }, () => Math.random()) }));
  await db.createTable(TABLE, rows);
}

// fresh work copy whose connect() uri is <root>/lancedb (matches LanceDb.uri with STORAGE_DIR=<root>)
async function freshCopy(name) {
  const root = path.join(workRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  const uri = path.join(root, "lancedb");
  fs.mkdirSync(uri, { recursive: true });
  if (srcLance) copyDir(srcLance, path.join(uri, `${TABLE}.lance`)); else { standin = true; await makeStandin(uri); }
  return { root, uri };
}

const typeStr = (t) => String(t);
const isListU16 = (f) => f && /List<Uint16>/.test(typeStr(f.type)) && f.nullable;
const isListF32 = (f) => f && /List<Float32>/.test(typeStr(f.type)) && f.nullable;

async function addSparseColumns(uri) {
  const db = await lancedb.connect(uri);
  const t = await db.openTable(TABLE);
  const before = (await t.schema()).fields.map((f) => `${f.name}:${f.type}`);
  const rowsBefore = await t.countRows();
  let path_ = "addColumns-NULL";
  try {
    await t.addColumns([{ name: "sparse_idx", valueSql: "NULL" }, { name: "sparse_val", valueSql: "NULL" }]);
  } catch (e) { console.log(`  addColumns NULL threw: ${e.message}`); path_ = "rewrite-fallback"; }
  let sch = await (await db.openTable(TABLE)).schema();
  let ok = isListU16(sch.fields.find((f) => f.name === "sparse_idx")) && isListF32(sch.fields.find((f) => f.name === "sparse_val"));
  const afterNull = sch.fields.filter((f) => f.name.startsWith("sparse")).map((f) => `${f.name}:${f.type}${f.nullable ? "?" : ""}`);
  if (!ok) {
    path_ = "rewrite-fallback";
    // rewrite on the COPY only
    const cur = await db.openTable(TABLE);
    const n = await cur.countRows();
    const tbl = await cur.query().limit(n).toArrow();
    const keep = tbl.schema.fields.filter((f) => !f.name.startsWith("sparse_")).map((f) => f.name);
    const cols = {};
    for (const k of keep) cols[k] = tbl.getChild(k);
    cols.sparse_idx = arrow.vectorFromArray(Array(n).fill(null), new arrow.List(new arrow.Field("item", new arrow.Uint16(), true)));
    cols.sparse_val = arrow.vectorFromArray(Array(n).fill(null), new arrow.List(new arrow.Field("item", new arrow.Float32(), true)));
    await db.createTable(TABLE, new arrow.Table(cols), { mode: "overwrite" });
    sch = await (await db.openTable(TABLE)).schema();
    ok = isListU16(sch.fields.find((f) => f.name === "sparse_idx")) && isListF32(sch.fields.find((f) => f.name === "sparse_val"));
  }
  const t2 = await db.openTable(TABLE);
  return { path: path_, ok, before, afterNull, after: sch.fields.map((f) => `${f.name}:${f.type}${f.nullable ? "?" : ""}`), rowsBefore, rowsAfter: await t2.countRows() };
}

// ---- real module load with require.cache stubs
const resolve = (rel) => req.resolve(rel);
const stub = (rel, exports) => { const f = resolve(rel); req.cache[f] = { id: f, filename: f, loaded: true, exports, children: [], paths: [] }; };
stub("../../helpers", { toChunks() {}, getEmbeddingEngineSelection() {} });
stub("../../TextSplitter", { TextSplitter: class {} });
stub("../../../models/systemSettings", { SystemSettings: {} });
stub("../../files", { storeVectorResult() {}, cachedVectorInformation() {} });
stub("../../chats", { sourceIdentifier() {} });
stub("../../rerankerClient", {});
const { LanceDb } = req("./index.js");
const marker = req("../../knowledgeSync/marker");
const { KnowledgeSyncError } = req("../../knowledgeSync/errors");
console.log(`REAL_FUNCTION=${typeof LanceDb.prototype.updateOrCreateCollection === "function" && /dropTable/.test(LanceDb.prototype.updateOrCreateCollection.toString())}`);

// ---- run
console.log("\n## Schema step");
const base = await freshCopy("schema");
const sc = await addSparseColumns(base.uri);
console.log(`  rows before/after: ${sc.rowsBefore}/${sc.rowsAfter}`);
console.log(`  before types: ${sc.before.join(", ")}`);
console.log(`  after addColumns(NULL) sparse types: ${sc.afterNull.join(", ") || "(none)"}`);
console.log(`  final types: ${sc.after.filter((x) => /^(sparse|vector)/.test(x)).join(", ")}`);
console.log(`  PATH_PASSED=${sc.path}`);
check(sc.ok, "sparse_idx List<Uint16>? and sparse_val List<Float32>? nullable");
check(sc.rowsBefore === sc.rowsAfter, "row count preserved");

async function runCase(label, { synced, dim, expectThrow, expectDrops }) {
  console.log(`\n## Case ${label}: isSynced=${synced}, incoming dim=${dim}`);
  const { root, uri } = await freshCopy(`case-${label}`);
  // prepare schema on this fresh copy
  const prep = await addSparseColumns(uri);
  check(prep.ok, "schema prepared on fresh copy");
  process.env.STORAGE_DIR = root;
  const real = await lancedb.connect(uri);
  const tblBefore = await real.openTable(TABLE);
  const nBefore = await tblBefore.countRows();
  const sch0 = await tblBefore.schema();
  const dim0 = sch0.fields.find((f) => f.name === "vector").type.listSize;
  const tpl = (await tblBefore.query().limit(1).toArray())[0];
  const mk = (i, withSparse) => {
    const r = {};
    for (const f of sch0.fields) if (!f.name.startsWith("sparse_") && f.name !== "vector") r[f.name] = tpl[f.name];
    r.id = `spike-${label}-${i}`;
    r.vector = Array.from({ length: dim }, () => Math.random());
    if (withSparse) { r.sparse_idx = [3, 17, 900]; r.sparse_val = [0.5, 1.25, 2.0]; } else { r.sparse_idx = null; r.sparse_val = null; } // explicit null: lancedb 0.15 cannot convert rows with the key omitted
    return r;
  };
  const data = dim === dim0 ? [mk(0, true), mk(1, false)] : [mk(0, false), mk(1, false)];
  if (dim !== dim0) for (const r of data) { delete r.sparse_idx; delete r.sparse_val; }
  let drops = 0;
  const client = { openTable: (n) => real.openTable(n), createTable: (...x) => real.createTable(...x), dropTable: async (n) => { drops++; return real.dropTable(n); } };
  const ldb = new LanceDb();
  ldb.hasNamespace = async () => true;
  marker.isSynced = async () => synced;
  let thrown = null;
  try { await ldb.updateOrCreateCollection(client, data, TABLE); } catch (e) { thrown = e; }
  if (expectThrow) {
    check(thrown instanceof KnowledgeSyncError && thrown.code === "KS_E_DIM_MISMATCH", `throws KS_E_DIM_MISMATCH (got ${thrown && (thrown.code || thrown.message)})`);
  } else check(!thrown, `no throw (${thrown && thrown.message})`);
  check(drops === expectDrops, `dropTable calls == ${expectDrops} (got ${drops})`);
  const real2 = await lancedb.connect(uri);
  const t = await real2.openTable(TABLE);
  const n = await t.countRows();
  const sch = await t.schema();
  const vf = sch.fields.find((f) => f.name === "vector");
  if (dim === dim0) {
    check(n === nBefore + data.length, `row count ${nBefore} -> ${n} (+${data.length})`);
    check(vf.type.listSize === dim0, `vector listSize unchanged (${vf.type.listSize})`);
    check(isListU16(sch.fields.find((f) => f.name === "sparse_idx")), `sparse_idx stays ${sch.fields.find((f) => f.name === "sparse_idx")?.type}`);
    check(isListF32(sch.fields.find((f) => f.name === "sparse_val")), `sparse_val stays ${sch.fields.find((f) => f.name === "sparse_val")?.type}`);
    const rows = await t.query().where(`id LIKE 'spike-${label}-%'`).limit(10).toArray();
    const withS = rows.find((r) => r.id.endsWith("-0")), noS = rows.find((r) => r.id.endsWith("-1"));
    check(withS && Array.from(withS.sparse_idx).join() === "3,17,900", "sparse values round-trip on row with sparse");
    check(noS && noS.sparse_idx == null, "row without sparse stored as null");
    // checkDimensionAlignment comparison
    check(vf.type.listSize === dim, "checkDimensionAlignment-equivalent: no drift");
  } else if (expectThrow) {
    check(n === nBefore && vf.type.listSize === dim0, `table untouched (${n} rows, listSize ${vf.type.listSize})`);
  } else {
    check(vf.type.listSize === dim, `legacy heal recreated table at dim ${vf.type.listSize} (rows ${n}); documented expected behavior`);
  }
}

const DIM0 = (await (await (await lancedb.connect(base.uri)).openTable(TABLE)).schema()).fields.find((f) => f.name === "vector").type.listSize;
console.log(`\nsource vector listSize=${DIM0}, stand-in=${standin}`);
await runCase("a", { synced: true, dim: DIM0, expectThrow: false, expectDrops: 0 });
await runCase("b", { synced: false, dim: DIM0, expectThrow: false, expectDrops: 0 });
await runCase("c", { synced: true, dim: DIM0 === 384 ? 512 : 384, expectThrow: true, expectDrops: 0 });
await runCase("d", { synced: false, dim: DIM0 === 384 ? 512 : 384, expectThrow: false, expectDrops: 1 });

console.log(`\nS4_RESULT=${failures === 0 ? "PASS" : "FAIL"} (failures=${failures})`);
process.exit(failures === 0 ? 0 : 1);
