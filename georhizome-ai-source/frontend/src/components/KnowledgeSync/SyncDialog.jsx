import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import { formatKsError } from "@/utils/knowledgeSyncErrors";

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Preview dialog for a sync job paused in awaiting_confirm (C1/IMP-07).
 * Confirm is blocked (aria-disabled) when incompatible or blocked.
 */
export default function SyncDialog({
  name,
  job,
  confirming,
  onConfirm,
  onClose,
  onWipe,
}) {
  const { t } = useTranslation();
  const preview = job?.preview || null;

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !confirming) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirming, onClose]);

  const compat = preview?.compatibility;
  const reasons = compat?.reasons || [];
  const blocking = preview?.blocking || [];
  const blocked = !!preview && (compat?.ok === false || blocking.length > 0);
  const disabled = !preview || blocked || confirming;
  const localOnly = preview?.localOnlyDocs || [];
  const firstCode = reasons[0]?.code || blocking[0];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
        <h3 className="text-lg font-semibold text-white mb-4">
          {t("knowledgeSync.syncDialog.title", {
            name: preview?.target?.name || name,
          })}
        </h3>
        {!preview ? (
          <p className="text-sm text-theme-text-secondary">
            {t("knowledgeSync.actions.loadingPreview")}
          </p>
        ) : (
          <div className="flex flex-col gap-y-2 text-sm text-white">
            <p>
              {t("knowledgeSync.syncDialog.version")}: {preview.versionId}
            </p>
            <p>
              {t("knowledgeSync.syncDialog.size")}:{" "}
              {formatSize(preview.archiveBytes ?? preview.sizeBytes)}
            </p>
            <p>
              {t("knowledgeSync.syncDialog.documents")}: {preview.docCount}
            </p>
            <p className="flex items-center gap-x-2">
              {blocked ? (
                <Warning size={16} weight="fill" className="text-red-400" />
              ) : (
                <CheckCircle
                  size={16}
                  weight="fill"
                  className="text-green-400"
                />
              )}
              <span>
                {t("knowledgeSync.syncDialog.compatibility")}:{" "}
                {blocked
                  ? t("knowledgeSync.syncDialog.incompatible")
                  : t("knowledgeSync.syncDialog.compatible")}
              </span>
            </p>
            {blocked && firstCode && (
              <p className="text-xs text-red-400">
                {formatKsError(t, { code: firstCode })}
              </p>
            )}
            {localOnly.length > 0 && (
              <details className="text-xs text-theme-text-secondary">
                <summary>
                  {t("knowledgeSync.syncDialog.localOnlyDocs", {
                    count: localOnly.length,
                  })}
                </summary>
                <ul className="max-h-40 overflow-y-auto mt-2">
                  {localOnly.map((d) => (
                    <li key={d.docId}>{d.filename || d.docpath}</li>
                  ))}
                </ul>
              </details>
            )}
            <p className="text-xs text-theme-text-secondary">
              {t("knowledgeSync.syncDialog.chatSettingsNote")}
            </p>
          </div>
        )}
        {onWipe && (
          <button
            type="button"
            onClick={onWipe}
            className="mt-4 px-3 py-1.5 text-xs font-semibold text-red-400 rounded-lg border border-red-400/50 hover:bg-red-400/10 focus:outline-none focus:ring-2 focus:ring-red-400 transition-colors"
          >
            {t("knowledgeSync.syncDialog.wipeLink")}
          </button>
        )}
        <div className="flex justify-end gap-x-2 mt-6">
          <button
            type="button"
            onClick={onClose}
            disabled={confirming}
            className="px-4 py-2 text-sm font-semibold text-theme-text-secondary hover:text-white"
          >
            {t("knowledgeSync.actions.cancel")}
          </button>
          <button
            type="button"
            aria-disabled={disabled ? "true" : "false"}
            onClick={() => !disabled && onConfirm?.()}
            className={`px-4 py-2 text-sm font-semibold text-white rounded-lg bg-theme-button-primary ${
              disabled ? "opacity-50 cursor-not-allowed" : ""
            }`}
          >
            {t("knowledgeSync.actions.confirmSync")}
          </button>
        </div>
      </div>
    </div>
  );
}
