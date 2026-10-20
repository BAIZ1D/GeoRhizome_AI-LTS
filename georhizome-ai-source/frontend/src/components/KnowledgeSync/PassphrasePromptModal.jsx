import React, { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import KnowledgeSync from "@/models/knowledgeSync";
import showToast from "@/utils/toast";
import { formatKsError } from "@/utils/knowledgeSyncErrors";

export const PASSPHRASE_MIN_LENGTH = 12;

export default function PassphrasePromptModal({ onSaved, onCancel }) {
  const { t } = useTranslation();
  const [passphrase, setPassphrase] = useState("");
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);
  const valid = passphrase.length >= PASSPHRASE_MIN_LENGTH;

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e) => {
      if (e.key === "Escape") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      setPassphrase("");
    };
  }, [onCancel]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    const { ok, error } = await KnowledgeSync.setPassphrase(passphrase);
    setSaving(false);
    if (!ok) {
      showToast(formatKsError(t, error), "error", { clear: true });
      return;
    }
    setPassphrase("");
    onSaved?.();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
        <h3 className="text-lg font-semibold text-white mb-2">
          {t("knowledgeSync.prompt.title")}
        </h3>
        <p className="text-sm text-theme-text-secondary mb-4">
          {t("knowledgeSync.prompt.body")}
        </p>
        <form onSubmit={handleSubmit}>
          <input
            ref={inputRef}
            type="password"
            autoComplete="new-password"
            minLength={PASSPHRASE_MIN_LENGTH}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            className="w-full bg-theme-bg-primary text-white text-sm border border-theme-border rounded-lg px-4 py-2 mb-2 outline-none focus:border-blue-500"
          />
          <p className="text-xs leading-[18px] text-white text-opacity-60 mb-4">
            {t("knowledgeSync.passphrase.hint")}
          </p>
          <div className="flex justify-end gap-x-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 text-sm font-semibold text-theme-text-secondary hover:text-white transition-all"
            >
              {t("knowledgeSync.prompt.dismiss")}
            </button>
            <button
              type="submit"
              disabled={!valid || saving}
              className="px-4 py-2 text-sm font-semibold bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-all disabled:opacity-50"
            >
              {saving
                ? t("knowledgeSync.saving")
                : t("knowledgeSync.prompt.save")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
