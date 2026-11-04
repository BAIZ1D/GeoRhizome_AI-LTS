// Phase 11 spike: LanceDB 0.15.0 assumptions A1-A4 + typed create + rename probe + rewrite cost. No ML, temp dir only.
// Run: fnm exec --using=18.18.0 node scripts/spike_phase11_lance.mjs --out <result.json>
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(here, "../georhizome-ai-source/server");
const req = createRequire(path.join(serverDir, "package.json"));
const lancedb = req("@lancedb/lancedb");
const arrow = req("apache-arrow");

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outPath = outIdx >= 0 ? path.resolve(argv[outIdx + 1]) : null;

const U16L = () => new arrow.List(new arrow.Field("item", new arrow.Uint16(), true));
const F32L = () => new arrow.List(new arrow.Field("item", new arrow.Float32(), true));
const DIM = 4;
const vec = () => Array.from({ length: DIM }, () => Math.random());
const fieldType = (sch, n) => { const f = sch.fields.find((x) => x.name === n); return f ? `${f.type}${f.nullable ? "?" : ""}` : "(missing)"; };
const typedOk = (sch) => /List<Uint16>/.test(fieldType(sch, "sparse_idx")) && /List<Float32>/.test(fieldType(sch, "sparse_val"));
const mb = () => process.memoryUsage().rss / 1048576;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "p11-spike-"));
const result = { node: process.version };

async function runCase(key, fn) {
  try { result[key] = await fn(); } catch (e) { result[key] = { ok: false, detail: `threw: ${e.message}` }; }
}

try {
  const db = await lancedb.connect(path.join(tmp, "db"));

  // 1. typed create via compose
  const N = 6;
  let tbl;
  await runCase("typedCreateCompose", async () => {
    const rows = Array.from({ length: N }, (_, i) => ({ id: `r${i}`, content_hash: `h${i}`, vector: vec() }));
    const base = lancedb.makeArrowTable(rows);
    const cols = {};
    for (const f of base.schema.fields) cols[f.name] = base.getChild(f.name);
    // rows 0,1,2 have sparse; 3,4,5 null
    cols.sparse_idx = arrow.vectorFromArray([[1, 2], [3], [4, 5, 6], null, null, null], U16L());
    cols.sparse_val = arrow.vectorFromArray([[0.5, 1], [2], [1, 2, 3], null, null, null], F32L());
    tbl = await db.createTable("composed", new arrow.Table(cols));
    const sch = await tbl.schema();
    return { ok: typedOk(sch), detail: `sparse_idx=${fieldType(sch, "sparse_idx")} sparse_val=${fieldType(sch, "sparse_val")}`, sparse_idx: fieldType(sch, "sparse_idx"), sparse_val: fieldType(sch, "sparse_val") };
  });

  // 2. add keeps types
  await runCase("addKeepsTypes", async () => {
    const t = tbl || (await db.openTable("composed"));
    const detail = [];
    let okA = false, okB = false;
    try { await t.add([{ id: "a0", content_hash: "ha0", vector: vec(), sparse_idx: [7, 8], sparse_val: [0.1, 0.2] }]); okA = true; } catch (e) { detail.push(`plain arrays: ${e.message}`); }
    try { await t.add([{ id: "b0", content_hash: "hb0", vector: vec(), sparse_idx: null, sparse_val: null }]); okB = true; } catch (e) { detail.push(`explicit null: ${e.message}`); }
    const sch = await t.schema();
    detail.push(`types=${fieldType(sch, "sparse_idx")}/${fieldType(sch, "sparse_val")}`);
    return { ok: okA && okB && typedOk(sch), plainArrays: okA, explicitNull: okB, detail: detail.join("; ") };
  });

  // 3/4. null filters. state now: 3 sparse + 3 null (composed) + 1 sparse (a0) + 1 null (b0) = 4 / 4
  const expNotNull = 4, expNull = 4;
  await runCase("nullFilterCountRows", async () => {
    const t = await db.openTable("composed");
    const nn = await t.countRows("sparse_idx IS NOT NULL");
    const n = await t.countRows("sparse_idx IS NULL");
    return { ok: nn === expNotNull && n === expNull, isNull: n, isNotNull: nn, expectedNull: expNull, expectedNotNull: expNotNull, detail: `IS NULL=${n} IS NOT NULL=${nn}` };
  });
  await runCase("nullFilterQueryWhere", async () => {
    const t = await db.openTable("composed");
    const total = await t.countRows();
    const a = await t.query().where("sparse_idx IS NULL").select(["id", "content_hash"]).limit(total).toArray();
    const b = await t.query().where("sparse_idx IS NOT NULL").select(["id", "content_hash"]).limit(total).toArray();
    return { ok: a.length === expNull && b.length === expNotNull, isNull: a.length, isNotNull: b.length, detail: `IS NULL=${a.length} IS NOT NULL=${b.length}` };
  });

  // 5. default scan limit
  await runCase("defaultScanLimit", async () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({ id: `s${i}`, content_hash: `sh${i}`, vector: vec() }));
    const t = await db.createTable("scan25", rows);
    let search = null, searchErr = "";
    try { search = (await t.search().select(["content_hash"]).toArray()).length; } catch (e) { searchErr = e.message; }
    const query = (await t.query().select(["content_hash"]).toArray()).length;
    const limited = (await t.query().select(["content_hash"]).limit(25).toArray()).length;
    return { ok: true, searchNoLimit: search, queryNoLimit: query, withLimit25: limited, defaultLimit: query, searchErr, detail: `search=${search}${searchErr ? " (" + searchErr + ")" : ""} query=${query} limit(25)=${limited}` };
  });

  // 6. typed addColumns
  await runCase("typedAddColumns", async () => {
    const attempts = [];
    const cands = [
      ["arrow_cast(NULL, 'List(UInt16)')", "arrow_cast(NULL, 'List(Float32)')"],
      ["arrow_cast(NULL, 'List(Field { name: \"item\", data_type: UInt16, nullable: true })')", "arrow_cast(NULL, 'List(Field { name: \"item\", data_type: Float32, nullable: true })')"],
      ["CAST(NULL AS ARRAY<SMALLINT UNSIGNED>)", "CAST(NULL AS ARRAY<FLOAT>)"],
      ["CAST(NULL AS SMALLINT UNSIGNED[])", "CAST(NULL AS FLOAT[])"],
      ["arrow_cast(make_array(), 'List(UInt16)')", "arrow_cast(make_array(), 'List(Float32)')"],
    ];
    let winner = null;
    for (let i = 0; i < cands.length; i++) {
      const name = `legacy${i}`;
      const t = await db.createTable(name, Array.from({ length: 3 }, (_, k) => ({ id: `l${k}`, content_hash: `lh${k}`, vector: vec() })));
      try {
        await t.addColumns([{ name: "sparse_idx", valueSql: cands[i][0] }, { name: "sparse_val", valueSql: cands[i][1] }]);
        const sch = await (await db.openTable(name)).schema();
        const typed = typedOk(sch);
        let addOk = false, addErr = "";
        if (typed) {
          try { await (await db.openTable(name)).add([{ id: "x", content_hash: "hx", vector: vec(), sparse_idx: [1, 2], sparse_val: [0.5, 0.25] }]); addOk = true; } catch (e) { addErr = e.message; }
        }
        attempts.push({ expr: cands[i][0], types: `${fieldType(sch, "sparse_idx")}/${fieldType(sch, "sparse_val")}`, typed, addOk, addErr });
        if (typed && addOk && !winner) winner = cands[i];
      } catch (e) { attempts.push({ expr: cands[i][0], error: e.message }); }
    }
    return { ok: !!winner, expression: winner ? winner[0] : null, expressionVal: winner ? winner[1] : null, attempts, detail: winner ? `works: ${winner[0]}` : "no candidate expression produced typed columns" };
  });

  // 6b. rename probe
  await runCase("renameProbe", async () => {
    const methods = [];
    for (const proto of [Object.getPrototypeOf(db), Object.getPrototypeOf(Object.getPrototypeOf(db))]) {
      if (proto) methods.push(...Object.getOwnPropertyNames(proto));
    }
    const t = await db.createTable("ren_src", [{ id: "1", vector: vec() }]);
    const cands = methods.filter((m) => /renam|move/i.test(m));
    let method = null, err = "";
    for (const m of cands) {
      try { await db[m]("ren_src", "ren_dst"); const names = await db.tableNames(); if (names.includes("ren_dst") && !names.includes("ren_src")) { method = m; break; } } catch (e) { err += `${m}: ${e.message}; `; }
    }
    return { ok: !!method, method, connectionMethods: methods.filter((m) => m !== "constructor"), detail: method ? `method ${method}` : `no rename/move method (${cands.join(",") || "none found"}) ${err}` };
  });

  // 7. rewrite cost
  await runCase("rewriteCost", async () => {
    const R = 20000, D = 768;
    const rows = new Array(R);
    for (let i = 0; i < R; i++) rows[i] = { id: `c${i}`, content_hash: `ch${i}`, text: `chunk text ${i}`, vector: Array.from({ length: D }, () => Math.random()) };
    let t = await db.createTable("big", rows);
    rows.length = 0;
    if (global.gc) global.gc();
    const rssBefore = mb();
    const t0 = Date.now();
    const n = await t.countRows();
    const tbl = await t.query().limit(n).toArrow();
    const cols = {};
    for (const f of tbl.schema.fields) cols[f.name] = tbl.getChild(f.name);
    cols.sparse_idx = arrow.vectorFromArray(Array(n).fill(null), U16L());
    cols.sparse_val = arrow.vectorFromArray(Array(n).fill(null), F32L());
    await db.createTable("big", new arrow.Table(cols), { mode: "overwrite" });
    const ms = Date.now() - t0;
    const rssPeak = mb();
    const sch = await (await db.openTable("big")).schema();
    const delta = rssPeak - rssBefore;
    return { ok: typedOk(sch), rows: n, ms, rssBeforeMB: Math.round(rssBefore), rssAfterMB: Math.round(rssPeak), rssDeltaMB: Math.round(delta), extrapolated100k: { ms: Math.round((ms / n) * 100000), rssDeltaMB: Math.round((delta / n) * 100000) }, detail: `${n} rows ${ms}ms rssDelta=${Math.round(delta)}MB` };
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const json = JSON.stringify(result, null, 2);
if (outPath) fs.writeFileSync(outPath, json + "\n");
console.log(json);
