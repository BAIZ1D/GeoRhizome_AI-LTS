const { redact } = require("./redact");

const KS_CODES = Object.freeze({
  KS_E_PASSPHRASE: "Incorrect passphrase.",
  KS_E_AUTH_TAG: "Archive damaged or incomplete — re-download.",
  KS_E_TRUNCATED: "Archive damaged or incomplete — re-download.",
  KS_E_MISSING_FINAL: "Archive damaged or incomplete — re-download.",
  KS_E_PARAMS: "Archive uses unsupported encryption parameters.",
  KS_E_UNSAFE_ENTRY: "Archive or input contains an unsafe entry.",
  KS_E_MANIFEST: "Archive manifest is invalid.",
  KS_E_PASSPHRASE_TOO_SHORT: "Passphrase is too short.",
  KS_E_PAT_INVALID: "GitHub token is invalid.",
  KS_E_FORBIDDEN: "Operation not permitted.",
  KS_E_UNKNOWN: "Unexpected knowledge sync error.",
});

class KnowledgeSyncError extends Error {
  constructor(code, { phase, archiveId, versionId } = {}) {
    const known = Object.prototype.hasOwnProperty.call(KS_CODES, code);
    const c = known ? code : "KS_E_UNKNOWN";
    super(KS_CODES[c]);
    this.name = "KnowledgeSyncError";
    this.code = c;
    if (phase !== undefined) this.phase = phase;
    if (archiveId !== undefined) this.archiveId = archiveId;
    if (versionId !== undefined) this.versionId = versionId;
  }
}

const isKnowledgeSyncError = (e) => e instanceof KnowledgeSyncError;

function toClientError(err) {
  const e = isKnowledgeSyncError(err)
    ? err
    : new KnowledgeSyncError("KS_E_UNKNOWN");
  return { code: e.code, message: redact(e.message) };
}

module.exports = {
  KnowledgeSyncError,
  KS_CODES,
  isKnowledgeSyncError,
  toClientError,
};
