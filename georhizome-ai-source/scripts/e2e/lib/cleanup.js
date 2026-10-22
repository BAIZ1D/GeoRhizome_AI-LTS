function planCleanup(beforeTags, afterTags, protectedTags) {
  const before = new Set(beforeTags || []);
  const prot = new Set((protectedTags || []).filter(Boolean));
  const out = [];
  for (const t of afterTags || []) {
    if (before.has(t)) continue;
    if (prot.has(t)) continue;
    if (!out.includes(t)) out.push(t);
  }
  return out.map((tag) => ({ steps: ["release", "tag"], tag }));
}

module.exports = { planCleanup };
