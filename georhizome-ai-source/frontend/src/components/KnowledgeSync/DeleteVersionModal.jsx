import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import KnowledgeSync from "@/models/knowledgeSync";
import showToast from "@/utils/toast";
import { formatKsError } from "@/utils/knowledgeSyncErrors";

// versions: ascending list of published version records for the workspace.
export default function DeleteVersionModal({
  slug,
  version,
  versions,
  onClose,
  onDone,
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const cancelRef = useRef(null);

  const isLast = versions.length <= 1;
  const latest = versions[versions.length - 1]?.version;
  const isLatest = version === latest;
  const fallback = versions[versions.length - 2]?.version;

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !busy) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    const res = await KnowledgeSync.deleteVersion(slug, version);
    setBusy(false);
    if (!res.ok) {
      showToast(
        t("knowledgeSync.toast.failed", {
          action: t("knowledgeSync.actions.deleteVersion"),
          message: formatKsError(t, res.error),
        }),
        "error",
        { clear: true }
      );
      return;
    }
    showToast(t("knowledgeSync.toast.deleteDone"), "success", { clear: true });
    onDone?.(version);
    onClose?.();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
        <h3 className="text-lg font-semibold text-white mb-2">
          {t("knowledgeSync.deleteVersion.title", { version })}
        </h3>
        <p className="text-sm text-theme-text-secondary mb-2">
          {t("knowledgeSync.deleteVersion.bodyPlain", { version })}
        </p>
        {isLast ? (
          <p className="text-sm text-white mb-6">
            {t("knowledgeSync.deleteVersion.bodyLast")}
          </p>
        ) : isLatest ? (
          <p className="text-sm text-white mb-6">
            {t("knowledgeSync.deleteVersion.bodyLatest", { fallback })}
          </p>
        ) : (
          <div className="mb-6" />
        )}
        <div className="flex justify-end gap-x-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm font-semibold text-theme-text-secondary hover:text-white"
          >
            {t("knowledgeSync.actions.cancel")}
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="px-4 py-2 text-sm font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 disabled:opacity-50"
          >
            {busy
              ? t("knowledgeSync.actions.deleting")
              : t("knowledgeSync.actions.deleteVersion")}
          </button>
        </div>
      </div>
    </div>
  );
}
