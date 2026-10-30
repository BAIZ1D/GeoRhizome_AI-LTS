// S3: synthetic sparse column-scan latency. Run under Node 18.18.0.
// usage: node spike_lance_scan.mjs --rows 10000 [--queries 20 --topn 50 --qnnz 60 --dnnz 107 --vocab 32768 --out-dir DIR]
import { createRequire } from "node:module";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../georhizome-ai-source/server");
const req = createRequire(path.join(serverDir, "package.json"));
const lancedb = req("@lancedb/lancedb");
const arrow = req("apache-arrow");

const a = {};
for (let i = 2; i < process.argv.length; i += 2) a[process.argv[i].replace(/^--/, "")] = process.argv[i + 1];
const ROWS = +(a.rows || 10000), NQ = +(a.queries || 20), TOPN = +(a.topn || 50);
const QNNZ = +(a.qnnz || 60), DNNZ = +(a.dnnz || 107), VOCAB = +(a.vocab || 32768), DIM = 768, BATCH = 500;
const outDir = a["out-dir"] || fs.mkdtempSync(path.join(os.tmpdir(), "s3-"));
if (path.resolve(outDir).includes(path.join("server", "storage"))) throw new Error("refusing live storage");
fs.mkdirSync(outDir, { recursive: true });

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const text = "あ".repeat(1024);

function makeBatch(n) {
  const ids = [], idx = [], val = [], vecs = new Float32Array(n * DIM), texts = [];
  for (let r = 0; r < n; r++) {
    ids.push(randomUUID()); texts.push(text);
    const ii = new Uint16Array(DIM > 0 ? DNNZ : 0), vv = new Float32Array(DNNZ);
    for (let k = 0; k < DNNZ; k++) { ii[k] = Math.floor(rnd() * VOCAB); vv[k] = rnd() * 3; }
    idx.push(ii); val.push(vv);
    for (let d = 0; d < DIM; d++) vecs[r * DIM + d] = rnd();
  }
  const f32 = new arrow.Float32();
  const vecType = new arrow.FixedSizeList(DIM, new arrow.Field("item", f32, true));
  const vecData = arrow.makeData({ type: vecType, length: n, nullCount: 0,
    child: arrow.makeData({ type: f32, length: n * DIM, data: vecs }) });
  return new arrow.Table({
    id: arrow.vectorFromArray(ids, new arrow.Utf8()),
    vector: new arrow.Vector([vecData]),
    text: arrow.vectorFromArray(texts, new arrow.Utf8()),
    sparse_idx: arrow.vectorFromArray(idx, new arrow.List(new arrow.Field("item", new arrow.Uint16(), true))),
    sparse_val: arrow.vectorFromArray(val, new arrow.List(new arrow.Field("item", f32, true))),
  });
}

const pct = (s, p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
const swap = () => { try { return fs.existsSync("/usr/sbin/sysctl") ? (req("child_process").execSync("sysctl vm.swapusage").toString().trim()) : ""; } catch { return ""; } };

const db = await lancedb.connect(outDir);
console.log(`<!-- node ${process.version} rows ${ROWS} outDir ${outDir} -->`);
const swapBefore = swap();
let table, writeMs = [];
for (let done = 0; done < ROWS; done += BATCH) {
  const b = makeBatch(Math.min(BATCH, ROWS - done));
  const t0 = performance.now();
  if (!table) table = await db.createTable("s3", b); else await table.add(b);
  writeMs.push(performance.now() - t0);
}
const schema = await table.schema();
const types = schema.fields.map((f) => `${f.name}:${f.type}`).join(", ");

function topNScan(tbl, qv) {
  // min-heap of [score,id] size TOPN
  const heapS = new Float64Array(TOPN), heapI = new Int32Array(TOPN); let hn = 0, base = 0;
  const push = (s, gi) => {
    if (hn < TOPN) { let i = hn++; while (i > 0) { const p = (i - 1) >> 1; if (heapS[p] <= s) break; heapS[i] = heapS[p]; heapI[i] = heapI[p]; i = p; } heapS[i] = s; heapI[i] = gi; }
    else if (s > heapS[0]) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= hn) break; if (c + 1 < hn && heapS[c + 1] < heapS[c]) c++; if (heapS[c] >= s) break; heapS[i] = heapS[c]; heapI[i] = heapI[c]; i = c; } heapS[i] = s; heapI[i] = gi; }
  };
  const ci = tbl.getChild("sparse_idx"), cv = tbl.getChild("sparse_val");
  for (let c = 0; c < ci.data.length; c++) {
    const di = ci.data[c], dv = cv.data[c];
    const offI = di.valueOffsets, offV = dv.valueOffsets;
    const vi = di.children[0].values, vv = dv.children[0].values;
    const len = di.length;
    for (let r = 0; r < len; r++) {
      let s = 0;
      for (let k = offI[r], kv = offV[r], e = offI[r + 1]; k < e; k++, kv++) s += qv[vi[k]] * vv[kv];
      push(s, base + r);
    }
    base += len;
  }
  return hn;
}

const queries = [];
for (let q = 0; q < NQ + 1; q++) { const qv = new Float32Array(VOCAB); for (let k = 0; k < QNNZ; k++) qv[Math.floor(rnd() * VOCAB)] = rnd() * 3; queries.push(qv); }

async function timedSelect(cols) { const t0 = performance.now(); const t = await table.query().select(cols).limit(ROWS).toArrow(); if (t.numRows !== ROWS) throw new Error(`scan returned ${t.numRows} rows, expected ${ROWS}`); return [performance.now() - t0, t]; }
const [tAll] = await timedSelect(["id", "vector", "sparse_idx", "sparse_val"]);
const [tSparseOnlyRead] = await timedSelect(["id", "sparse_idx", "sparse_val"]);

const lat = [], readMs = [], scoreMs = []; let peak = 0;
for (let q = 0; q < NQ + 1; q++) {
  const t0 = performance.now();
  const [rm, t] = await timedSelect(["id", "sparse_idx", "sparse_val"]);
  const t1 = performance.now();
  topNScan(t, queries[q]);
  const t2 = performance.now();
  peak = Math.max(peak, process.memoryUsage().rss);
  if (q > 0) { lat.push(t2 - t0); readMs.push(rm); scoreMs.push(t2 - t1); }
}
lat.sort((x, y) => x - y);
const swapAfter = swap();
const f = (x) => x.toFixed(1);
const mean = (x) => x.reduce((s, y) => s + y, 0) / x.length;
console.log(`## Scan result rows=${ROWS}
- node: ${process.version}
- schema: ${types}
- timed queries: ${NQ} (+1 warm-up), topN=${TOPN}, qnnz=${QNNZ}, dnnz=${DNNZ}, vocab=${VOCAB}
- latency ms p50/p95/max: ${f(pct(lat, 0.5))} / ${f(pct(lat, 0.95))} / ${f(lat[lat.length - 1])}
- mean read ms: ${f(mean(readMs))}, mean score ms: ${f(mean(scoreMs))}
- select-all(id,vector,sparse) ${f(tAll)} ms vs select-sparse ${f(tSparseOnlyRead)} ms (projection pushdown evidence)
- one ${BATCH}-row add() with sparse columns: mean ${f(mean(writeMs))} ms, max ${f(Math.max(...writeMs))} ms (${writeMs.length} batches)
- peak RSS: ${(peak / 1048576).toFixed(0)} MB
- swap before: ${swapBefore}
- swap after: ${swapAfter}
- verdict p95<=300ms: ${pct(lat, 0.95) <= 300 ? "PASS" : "FAIL"}`);
