const PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(Authorization|authorization)\s*[:=]\s*\S+( \S+)?/g,
];
const secrets = new Set();

function registerSecret(s) {
  if (typeof s === "string" && s.length >= 4) secrets.add(s);
}
function unregisterSecret(s) {
  secrets.delete(s);
}

function scrubString(str) {
  let out = str;
  for (const s of secrets) out = out.split(s).join("[REDACTED]");
  for (const re of PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
}

function redact(value, seen = new WeakSet()) {
  if (typeof value === "string") return scrubString(value);
  if (value instanceof Error) {
    const e = new Error(scrubString(value.message));
    e.name = value.name;
    if (value.code !== undefined) e.code = value.code;
    e.stack = scrubString(String(value.stack || ""));
    return e;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, seen));
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    const o = {};
    for (const [k, v] of Object.entries(value)) o[k] = redact(v, seen);
    return o;
  }
  return value;
}

function safeLog(level, msg, ctx) {
  const fn =
    typeof console[level] === "function" ? console[level] : console.log;
  const args = [`[KnowledgeSync] ${redact(String(msg))}`];
  if (ctx !== undefined) args.push(redact(ctx));
  fn.apply(console, args);
}

module.exports = { redact, registerSecret, unregisterSecret, safeLog };
