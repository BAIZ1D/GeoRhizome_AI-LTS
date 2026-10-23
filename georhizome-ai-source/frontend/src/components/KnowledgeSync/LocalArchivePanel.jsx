import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import KnowledgeSyncModel from "@/models/knowledgeSync";
import { formatKsError } from "@/utils/knowledgeSyncErrors";
import { humanFileSize } from "@/utils/numbers";

const BTN =
  "px-4 py-2 rounded-lg text-sm font-semibold text-white bg-theme-button-primary disabled:opacity-50 disabled:cursor-not-allowed";

/**
 * Local archive export + import (preview, then Confirm or Discard).
 * Export is shown only when `admin` (true for everyone in single-user mode).
 * Import is ungated in the UI; the backend enforces access and passphrase.
 */
export default function LocalArchivePanel({ slug, admin, onImported }) {
  const { t } = useTranslation();
  const [exporting, setExporting] = useState(false);
  const [exported, setExported] = useState(null);
  const [archiveName, setArchiveName] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const showError = (err) =>
    setError(formatKsError(t, { code: err?.code || "KS_E_UNKNOWN" }));

  async function doExport() {
    setExporting(true);
    setError(null);
    setDone(false);
    const res = await KnowledgeSyncModel.exportArchive(slug);
    setExporting(false);
    if (!res.ok) return showError(res.error);
    const a = res.data?.archive || {};
    setExported(a);
    if (a.name) setArchiveName(a.name);
  }

  async function doPreview() {
    const name = archiveName.trim();
    setError(null);
    setDone(false);
    if (!name || name.includes("/") || name.includes("\\")) {
      setError(t("knowledgeSync.localArchive.invalidName"));
      return;
    }
    setBusy(true);
    const res = await KnowledgeSyncModel.importPreview(name);
    setBusy(false);
    if (!res.ok) return showError(res.error);
    setPreview(res.data);
  }

  async function doConfirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    const res = await KnowledgeSyncModel.importConfirm(preview.previewId);
    setBusy(false);
    if (!res.ok) return showError(res.error);
    setPreview(null);
    setDone(true);
    onImported?.();
  }

  async function doDiscard() {
    if (!preview) return;
    const id = preview.previewId;
    setPreview(null);
    setError(null);
    await KnowledgeSyncModel.importDiscard(id);
  }

  const compat = preview?.compatibility;
  const reasons = compat?.reasons || [];
  const blocking = preview?.blocking || [];
  const blocked = !!preview && (compat?.ok === false || blocking.length > 0);
  const localOnly = preview?.localOnlyDocs || [];
  const firstCode = reasons[0]?.code || blocking[0];

  return (
    <div className="rounded-lg border border-theme-border p-4 flex flex-col gap-y-4">
      <div className="flex flex-col gap-y-1">
        <h3 className="text-base font-semibold text-white">
          {t("knowledgeSync.localArchive.title")}
        </h3>
        <p className="text-xs text-theme-text-secondary">
          {t("knowledgeSync.localArchive.description")}
        </p>
      </div>

      {admin && (
        <div className="flex flex-col gap-y-2">
          <div>
            <button
              type="button"
              disabled={exporting || busy}
              onClick={doExport}
              className={BTN}
            >
              {exporting
                ? t("knowledgeSync.localArchive.exporting")
                : t("knowledgeSync.localArchive.exportButton")}
            </button>
          </div>
          {exported && (
            <p className="text-xs text-white">
              {t("knowledgeSync.localArchive.exportDone", {
                name: exported.name,
                version: exported.versionId,
                size: humanFileSize(exported.bytes),
              })}
            </p>
          )}
        </div>
      )}

      <div className="flex flex-col gap-y-2">
        <label
          htmlFor="ks-archive-name"
          className="text-xs text-theme-text-secondary"
        >
          {t("knowledgeSync.localArchive.archiveNameLabel")}
        </label>
        <input
          id="ks-archive-name"
          type="text"
          value={archiveName}
          onChange={(e) => setArchiveName(e.target.value)}
          placeholder={t("knowledgeSync.localArchive.archiveNamePlaceholder")}
          autoComplete="off"
          className="w-full bg-theme-settings-input-bg text-white text-sm rounded-lg p-2.5 border border-theme-border"
        />
        <div>
          <button
            type="button"
            disabled={busy || exporting || !archiveName.trim()}
            onClick={doPreview}
            className={BTN}
          >
            {busy && !preview
              ? t("knowledgeSync.localArchive.previewing")
              : t("knowledgeSync.localArchive.previewButton")}
          </button>
        </div>
      </div>

      {preview && (
        <div className="rounded-lg border border-theme-border p-3 flex flex-col gap-y-2 text-sm text-white">
          <h4 className="font-semibold">
            {t("knowledgeSync.localArchive.previewTitle")}
          </h4>
          <p>
            {t("knowledgeSync.localArchive.previewVersion")}:{" "}
            {preview.versionId}
          </p>
          <p>
            {t("knowledgeSync.localArchive.previewDocs")}: {preview.docCount}
          </p>
          <p>
            {t("knowledgeSync.localArchive.previewSize")}:{" "}
            {humanFileSize(preview.archiveBytes ?? preview.sizeBytes)}
          </p>
          <p className="flex items-center gap-x-2">
            {blocked ? (
              <Warning size={16} weight="fill" className="text-red-400" />
            ) : (
              <CheckCircle size={16} weight="fill" className="text-green-400" />
            )}
            <span>
              {blocked
                ? t("knowledgeSync.localArchive.previewIncompatible")
                : t("knowledgeSync.localArchive.previewCompatible")}
            </span>
          </p>
          {blocked && (
            <p className="text-xs text-red-400">
              {t("knowledgeSync.localArchive.previewBlocking")}
              {firstCode ? `: ${formatKsError(t, { code: firstCode })}` : ""}
            </p>
          )}
          {localOnly.length > 0 && (
            <details className="text-xs text-theme-text-secondary">
              <summary>
                {t("knowledgeSync.localArchive.previewLocalOnly", {
                  count: localOnly.length,
                })}
              </summary>
              <ul className="max-h-40 overflow-y-auto mt-2">
                {localOnly.map((d) => (
                  <li key={d.docId || d.docpath}>{d.filename || d.docpath}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="flex gap-x-2 mt-2">
            <button
              type="button"
              disabled={busy || blocked}
              onClick={doConfirm}
              className={BTN}
            >
              {busy
                ? t("knowledgeSync.localArchive.confirming")
                : t("knowledgeSync.localArchive.confirmButton")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={doDiscard}
              className="px-4 py-2 text-sm font-semibold text-theme-text-secondary hover:text-white disabled:opacity-50"
            >
              {t("knowledgeSync.localArchive.discardButton")}
            </button>
          </div>
        </div>
      )}

      {done && (
        <p className="text-xs text-green-400">
          {t("knowledgeSync.localArchive.importDone")}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
