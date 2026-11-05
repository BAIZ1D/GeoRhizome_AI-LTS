/**
 * Reciprocal Rank Fusion. Pure and deterministic.
 * score(id) = sum over lists of 1 / (k + rank), rank 1-based, first
 * occurrence per list only. Ties: better (lower) best-rank, then better dense
 * rank, then id localeCompare.
 * @param {{name: string, ids: string[]}[]} lists
 * @param {number} k
 * @returns {{id: string, rrf: number, ranks: Record<string, number>}[]}
 */
function fuse(lists, k) {
  const kk = Number.isFinite(Number(k)) && Number(k) > 0 ? Number(k) : 60;
  const acc = new Map();
  for (const list of Array.isArray(lists) ? lists : []) {
    const ids = Array.isArray(list?.ids) ? list.ids : [];
    let rank = 0;
    for (const id of ids) {
      rank += 1;
      let e = acc.get(id);
      if (!e) {
        e = { id, rrf: 0, ranks: {} };
        acc.set(id, e);
      }
      if (e.ranks[list.name] !== undefined) continue;
      e.ranks[list.name] = rank;
      e.rrf += 1 / (kk + rank);
    }
  }
  const best = (e) => Math.min(...Object.values(e.ranks));
  const dense = (e) => e.ranks.dense ?? Infinity;
  return [...acc.values()].sort(
    (a, b) =>
      b.rrf - a.rrf ||
      best(a) - best(b) ||
      dense(a) - dense(b) ||
      String(a.id).localeCompare(String(b.id))
  );
}

module.exports = { fuse };
