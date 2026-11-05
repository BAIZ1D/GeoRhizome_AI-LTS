const VOCAB = 65536;

/**
 * Sparse leg scorer (HYB-01): full Arrow column scan of sparse_idx/sparse_val
 * with an explicit .limit(countRows). Never selects vector/text columns.
 * @returns {Promise<{id: string, score: number}[]>} score desc, id asc on ties
 */
async function scoreTable(table, qvec, topN) {
  const n = Math.max(0, Math.floor(Number(topN)) || 0);
  if (!table || !qvec || n === 0) return [];
  const rows = await table.countRows();
  if (rows === 0) return [];

  const qv = new Float32Array(VOCAB);
  const { indices = [], values = [] } = qvec;
  for (let i = 0; i < indices.length; i++) {
    const ix = indices[i];
    if (ix >= 0 && ix < VOCAB) qv[ix] += values[i];
  }

  const tbl = await table
    .query()
    .select(["id", "sparse_idx", "sparse_val"])
    .limit(rows)
    .toArrow();

  // Min-heap on (score asc, id desc): root is the worst kept entry.
  const hs = new Float64Array(n);
  const hi = new Int32Array(n);
  let hn = 0;
  const idCol = tbl.getChild("id");
  const worse = (sa, ia, sb, ib) => {
    if (sa !== sb) return sa < sb;
    return String(idCol.get(ia)) > String(idCol.get(ib));
  };
  const swapDown = (s, g) => {
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= hn) break;
      if (c + 1 < hn && worse(hs[c + 1], hi[c + 1], hs[c], hi[c])) c++;
      if (!worse(hs[c], hi[c], s, g)) break;
      hs[i] = hs[c];
      hi[i] = hi[c];
      i = c;
    }
    hs[i] = s;
    hi[i] = g;
  };
  const push = (s, g) => {
    if (hn < n) {
      let i = hn++;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (!worse(s, g, hs[p], hi[p])) break;
        hs[i] = hs[p];
        hi[i] = hi[p];
        i = p;
      }
      hs[i] = s;
      hi[i] = g;
    } else if (worse(hs[0], hi[0], s, g)) {
      swapDown(s, g);
    }
  };

  const ci = tbl.getChild("sparse_idx");
  const cv = tbl.getChild("sparse_val");
  let base = 0;
  for (let c = 0; c < ci.data.length; c++) {
    const di = ci.data[c];
    const dv = cv.data[c];
    const offI = di.valueOffsets;
    const offV = dv.valueOffsets;
    const vi = di.children[0].values;
    const vv = dv.children[0].values;
    for (let r = 0; r < di.length; r++) {
      if (!di.getValid(r) || !dv.getValid(r)) continue;
      let s = 0;
      for (let k = offI[r], kv = offV[r], e = offI[r + 1]; k < e; k++, kv++) {
        s += qv[vi[k]] * vv[kv];
      }
      if (s > 0) push(s, base + r);
    }
    base += di.length;
  }

  const out = [];
  for (let i = 0; i < hn; i++) {
    out.push({ id: String(idCol.get(hi[i])), score: hs[i] });
  }
  out.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : 1
  );
  return out;
}

module.exports = { scoreTable };
