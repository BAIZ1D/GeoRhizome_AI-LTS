import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import KnowledgeSync from "@/models/knowledgeSync";
import showToast from "@/utils/toast";
import { formatKsError } from "@/utils/knowledgeSyncErrors";

export default function WipeModal({ slug, onClose, onDone }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

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
    const res = await KnowledgeSync.wipe(slug);
    setBusy(false);
    if (!res.ok) {
      showToast(formatKsError(t, res.error), "error", { clear: true });
      return;
    }
    showToast(t("knowledgeSync.toast.wipeDone"), "success", { clear: true });
    onDone?.();
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
          {t("knowledgeSync.wipe.title")}
        </h3>
        <p className="text-sm text-theme-text-secondary mb-6">
          {t("knowledgeSync.wipe.body")}
        </p>
        <div className="flex justify-end gap-x-2">
          <button
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
            className="px-4 py-2 text-sm font-semibold bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 disabled:opacity-50"
          >
            {busy
              ? t("knowledgeSync.actions.wiping")
              : t("knowledgeSync.actions.wipeThisMachine")}
          </button>
        </div>
      </div>
    </div>
  );
}
