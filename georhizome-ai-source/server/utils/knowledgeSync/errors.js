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
  KS_E_BUSY: "Another operation is already running on this workspace.",
  KS_E_SYNCING: "This workspace is being synced. Try again shortly.",
  KS_E_DISK_SPACE: "Not enough free disk space for this operation.",
  KS_E_EMBEDDER_MISMATCH: "Archive was built with a different embedding model.",
  KS_E_DIM_MISMATCH: "Archive vector dimension does not match this system.",
  KS_E_NO_BACKUP: "No backup is available to roll back to.",
  KS_E_VERSION_STALE: "Archive version is not newer than the synced version.",
  KS_E_DOCID_CONFLICT:
    "A document in the archive already belongs to another workspace.",
  KS_E_EXPORT_INCOMPLETE:
    "Export failed because a referenced document is missing.",
  KS_E_SIZE_LIMIT: "Archive exceeds the allowed size.",
  KS_E_NOT_FOUND: "The requested item was not found.",
  KS_E_PREVIEW_INVALID: "Import preview is missing or expired.",
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
