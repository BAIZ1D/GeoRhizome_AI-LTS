const { redact } = require("../knowledgeSync/redact");

/** Bilingual (ja first, en second) copy. Never include document text. */
const COPY = Object.freeze({
  SPARSE_E_UNAVAILABLE: ({ port } = {}) => ({
    ja: `スパース検索用サーバー（ポート${port}）に接続できないため、この文書は登録されませんでした。モデル管理画面でスパースモデルを起動してから、もう一度お試しください。`,
    en: `The sparse search server (port ${port}) is unavailable, so this document was not indexed. Start the sparse model in Model Hub and retry.`,
  }),
  SPARSE_E_TOO_LARGE: () => ({
    ja: "文書の一部が長すぎてスパースインデックスを作成できないため、この文書は登録されませんでした。",
    en: "Part of the document is too long to build the sparse index, so it was not indexed.",
  }),
  SPARSE_E_DEGRADED: () => ({
    ja: "スパースモデルが正常に動作していないため、この文書は登録されませんでした。モデル管理画面で状態を確認してください。",
    en: "The sparse model is not working correctly, so this document was not indexed. Check Model Hub.",
  }),
  SPARSE_E_BUSY: () => ({
    ja: "スパース検索用サーバーが混み合っているため、この文書は登録されませんでした。しばらくしてからもう一度お試しください。",
    en: "The sparse search server is busy, so this document was not indexed. Retry later.",
  }),
  SPARSE_E_BAD_RESPONSE: () => ({
    ja: "スパース検索用サーバーから無効な応答が返されたため、この文書は登録されませんでした。",
    en: "The sparse search server returned an invalid response, so this document was not indexed.",
  }),
  SPARSE_E_UNKNOWN: () => ({
    ja: "スパースインデックスの作成中に予期しないエラーが発生しました。",
    en: "Unexpected sparse index error.",
  }),
});

class SparseError extends Error {
  constructor(code, opts = {}) {
    const known = Object.prototype.hasOwnProperty.call(COPY, code);
    const c = known ? code : "SPARSE_E_UNKNOWN";
    const { ja, en } = COPY[c](opts);
    super(`${ja}\n${en}`);
    this.name = "SparseError";
    this.code = c;
    this.ja = ja;
    this.en = en;
  }
}

const isSparseError = (e) => e instanceof SparseError;

function toClientError(err) {
  const e = isSparseError(err) ? err : new SparseError("SPARSE_E_UNKNOWN");
  return {
    code: e.code,
    message: redact(e.message),
    ja: redact(e.ja),
    en: redact(e.en),
  };
}

module.exports = {
  SparseError,
  SPARSE_CODES: Object.freeze(Object.keys(COPY)),
  isSparseError,
  toClientError,
};
