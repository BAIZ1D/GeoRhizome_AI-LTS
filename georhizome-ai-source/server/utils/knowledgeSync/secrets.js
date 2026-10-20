const { SystemSettings } = require("../../models/systemSettings");
const { EncryptionManager } = require("../EncryptionManager");
const { KnowledgeSyncError } = require("./errors");
const { registerSecret, safeLog } = require("./redact");
const { getKnowledgeSyncConfig } = require("./config");

const PAT_LABEL = "ks_github_pat";
const PASS_LABEL = "ks_passphrase";
const PAT_RE = /^(ghp_|github_pat_)[A-Za-z0-9_]{20,}$/;

let _mgr = null;
const mgr = () => (_mgr ||= new EncryptionManager());

async function readSecret(label) {
  try {
    const row = await SystemSettings.get({ label });
    if (!row?.value) return null;
    const plain = mgr().decrypt(row.value);
    if (typeof plain !== "string" || !plain) return null;
    registerSecret(plain);
    return plain;
  } catch {
    safeLog("error", "secret read failed", { code: "KS_E_UNKNOWN" });
    return null;
  }
}

async function writeSecret(label, value) {
  registerSecret(value);
  const enc = mgr().encrypt(value);
  if (!enc) throw new KnowledgeSyncError("KS_E_UNKNOWN");
  await SystemSettings._updateSettings({ [label]: enc });
}

async function setPat(pat) {
  if (typeof pat !== "string" || !PAT_RE.test(pat))
    throw new KnowledgeSyncError("KS_E_PAT_INVALID");
  await writeSecret(PAT_LABEL, pat);
}
const clearPat = async () => {
  await SystemSettings.delete({ label: PAT_LABEL });
};
const getPat = () => readSecret(PAT_LABEL);
async function patStatus() {
  const pat = await getPat();
  return pat
    ? { configured: true, last4: pat.slice(-4) }
    : { configured: false, last4: null };
}

async function setPassphrase(p) {
  const min = getKnowledgeSyncConfig().passphrase_min_length;
  if (typeof p !== "string" || p.length < min)
    throw new KnowledgeSyncError("KS_E_PASSPHRASE_TOO_SHORT");
  await writeSecret(PASS_LABEL, p);
}
const clearPassphrase = async () => {
  await SystemSettings.delete({ label: PASS_LABEL });
};
const getPassphrase = () => readSecret(PASS_LABEL);
async function passphraseStatus() {
  return { configured: (await getPassphrase()) !== null };
}

module.exports = {
  setPat,
  clearPat,
  getPat,
  patStatus,
  setPassphrase,
  clearPassphrase,
  getPassphrase,
  passphraseStatus,
};
