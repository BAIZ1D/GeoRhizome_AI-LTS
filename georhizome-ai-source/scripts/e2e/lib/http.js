const fs = require("fs");
const { redact } = require("../../../server/utils/knowledgeSync/redact");

const SECRET_ENVS = ["KS_E2E_PAT", "KS_E2E_PASSPHRASE", "KS_E2E_WRONG_PASSPHRASE"];

function mask(text) {
  let out = redact(String(text));
  for (const k of SECRET_ENVS) {
    const v = process.env[k];
    if (v && v.length >= 1) out = out.split(v).join("[REDACTED]");
  }
  return out;
}

function log(line, file) {
  const out = mask(line);
  if (file) fs.appendFileSync(file, out + "\n");
  console.log(out);
  return out;
}

async function request(base, path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, {
    method: opts.method || "GET",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch (_) {
    json = null;
  }
  return { status: res.status, ok: res.ok, json };
}

module.exports = { request, log, mask };
