const fs = require("fs");

function scanText(text, pat) {
  const s = String(text || "");
  if (/ghp_[A-Za-z0-9]{20,}/.test(s)) return true;
  if (/github_pat_[A-Za-z0-9_]{20,}/.test(s)) return true;
  return !!(pat && pat.length >= 4 && s.includes(pat));
}

function scanFiles(paths, pat) {
  const hits = [];
  for (const p of paths) {
    let t;
    try {
      t = fs.readFileSync(p, "utf8");
    } catch (_) {
      continue;
    }
    if (scanText(t, pat)) hits.push(p);
  }
  return hits;
}

module.exports = { scanText, scanFiles };
