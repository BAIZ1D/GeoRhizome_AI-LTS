const KNOWN_CODES = [
  "KS_E_PASSPHRASE",
  "KS_E_PASSPHRASE_TOO_SHORT",
  "KS_E_PAT_INVALID",
  "KS_E_AUTH_TAG",
  "KS_E_TRUNCATED",
  "KS_E_MISSING_FINAL",
  "KS_E_PARAMS",
  "KS_E_UNSAFE_ENTRY",
  "KS_E_MANIFEST",
  "KS_E_UNKNOWN",
];

/**
 * Format a Knowledge Sync error as "<message> (<CODE>)".
 * Only the mapped translation and code are shown, never raw server text.
 * @param {Function} t i18next translate function
 * @param {{code?: string, status?: number}|null} error
 * @returns {string}
 */
export function formatKsError(t, error) {
  // Role middleware (flexUserRoleValid) refuses with 401, not 403.
  if (
    error?.status === 401 ||
    error?.status === 403 ||
    error?.code === "KS_E_FORBIDDEN"
  )
    return t("knowledgeSync.errors.forbidden");
  const code = KNOWN_CODES.includes(error?.code) ? error.code : "KS_E_UNKNOWN";
  return `${t(`knowledgeSync.errors.${code}`)} (${code})`;
}
