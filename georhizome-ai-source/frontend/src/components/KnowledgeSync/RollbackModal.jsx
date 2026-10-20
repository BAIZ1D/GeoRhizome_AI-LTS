import { useEffect } from "react";
import { useTranslation } from "react-i18next";

export default function RollbackModal({ version, onConfirm, onClose }) {
  const { t } = useTranslation();

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
        <h3 className="text-lg font-semibold text-white mb-2">
          {t("knowledgeSync.rollbackModal.title", { version })}
        </h3>
        <p className="text-sm text-theme-text-secondary mb-6">
          {t("knowledgeSync.rollbackModal.body", { version })}
        </p>
        <div className="flex justify-end gap-x-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-semibold text-theme-text-secondary hover:text-white"
          >
            {t("knowledgeSync.actions.cancel")}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg bg-theme-button-primary"
          >
            {t("knowledgeSync.rollbackModal.confirm", { version })}
          </button>
        </div>
      </div>
    </div>
  );
}
