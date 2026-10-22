import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isMobile } from "react-device-detect";
import { CheckCircle, Warning } from "@phosphor-icons/react";
import { Link } from "react-router-dom";
import paths from "@/utils/paths";
import Sidebar from "@/components/SettingsSidebar";
import KnowledgeSync from "@/models/knowledgeSync";
import showToast from "@/utils/toast";
import { formatKsError } from "@/utils/knowledgeSyncErrors";
import { PASSPHRASE_MIN_LENGTH } from "@/components/KnowledgeSync/PassphrasePromptModal";

export default function KnowledgeSyncSettings() {
  const { t } = useTranslation();
  const [status, setStatus] = useState(null);

  const refetch = useCallback(async () => {
    const { ok, data } = await KnowledgeSync.status();
    if (ok) setStatus(data);
  }, []);

  useEffect(() => {
    refetch();
  }, [refetch]);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full px-1 md:pl-6 md:pr-[50px] md:pt-6 pb-8">
          <p className="text-lg font-semibold text-theme-text-primary border-white light:border-theme-sidebar-border border-b-2 border-opacity-10 py-4">
            {t("knowledgeSync.title")}
          </p>
          <p className="text-xs leading-[18px] text-white text-opacity-60 mt-2">
            {t("knowledgeSync.description")}
          </p>
          <p className="text-xs leading-[18px] text-white text-opacity-60 mt-1">
            <Link
              to={paths.knowledgeSyncPage()}
              className="underline hover:text-white"
            >
              {t("knowledgeSync.sidebar.toSync")}
            </Link>
          </p>
          {status && (
            <>
              {status.pat && (
                <PatSection
                  pat={status.pat}
                  autoFocus={
                    !status.pat.configured && status.passphrase?.configured
                  }
                  onChanged={refetch}
                />
              )}
              <PassphraseSection
                configured={!!status.passphrase?.configured}
                autoFocus={
                  !status.passphrase?.configured &&
                  (!status.pat || status.pat.configured)
                }
                onChanged={refetch}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusRow({ configured, label }) {
  const { t } = useTranslation();
  return configured ? (
    <div className="flex items-center gap-x-2 text-sm font-semibold text-green-400">
      <CheckCircle size={18} weight="fill" />
      {label}
    </div>
  ) : (
    <div className="text-sm font-semibold text-theme-text-secondary">
      {t("knowledgeSync.notConfigured")}
    </div>
  );
}

function ConfirmModal({
  title,
  body,
  keepLabel,
  confirmLabel,
  onKeep,
  onConfirm,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onKeep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onKeep]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-theme-bg-secondary p-6 rounded-lg shadow-xl w-full max-w-md border border-theme-border">
        <h3 className="text-lg font-semibold text-white mb-2">{title}</h3>
        <p className="text-sm text-theme-text-secondary mb-4">{body}</p>
        <div className="flex justify-end gap-x-2">
          <button
            type="button"
            onClick={onKeep}
            className="px-4 py-2 text-sm font-semibold text-theme-text-secondary hover:text-white transition-all"
          >
            {keepLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-4 py-2 text-sm font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 transition-all"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function PatSection({ pat, autoFocus, onChanged }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => () => setValue(""), []);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!value.trim() || saving) return;
    setSaving(true);
    const { ok, error } = await KnowledgeSync.setPat(value.trim());
    setSaving(false);
    setValue("");
    if (!ok)
      return showToast(formatKsError(t, error), "error", { clear: true });
    showToast(t("knowledgeSync.saved"), "success", { clear: true });
    onChanged();
  };

  const handleRemove = async () => {
    setConfirming(false);
    const { ok, error } = await KnowledgeSync.clearPat();
    if (!ok)
      return showToast(formatKsError(t, error), "error", { clear: true });
    showToast(t("knowledgeSync.saved"), "success", { clear: true });
    onChanged();
  };

  return (
    <form onSubmit={handleSave} className="mt-8 flex flex-col gap-y-4 max-w-xl">
      <h2 className="text-base font-semibold text-white">
        {t("knowledgeSync.pat.heading")}
      </h2>
      <StatusRow
        configured={pat.configured}
        label={t("knowledgeSync.pat.configured", { last4: pat.last4 || "" })}
      />
      <div className="flex flex-col gap-y-1">
        <input
          type="password"
          autoComplete="off"
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={t("knowledgeSync.pat.placeholder")}
          className="w-full bg-theme-bg-primary text-white text-sm border border-theme-border rounded-lg px-4 py-2 outline-none focus:border-blue-500"
        />
        <p className="text-xs leading-[18px] text-white text-opacity-60">
          {t("knowledgeSync.pat.hint")}
        </p>
      </div>
      <div className="flex gap-x-2">
        <button
          type="submit"
          disabled={!value.trim() || saving}
          className="px-4 py-2 text-sm font-semibold bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-all disabled:opacity-50"
        >
          {saving ? t("knowledgeSync.saving") : t("knowledgeSync.pat.save")}
        </button>
        {pat.configured && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="px-4 py-2 text-sm font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 transition-all"
          >
            {t("knowledgeSync.pat.remove")}
          </button>
        )}
      </div>
      {confirming && (
        <ConfirmModal
          title={t("knowledgeSync.pat.removeTitle")}
          body={t("knowledgeSync.pat.removeBody")}
          keepLabel={t("knowledgeSync.pat.keep")}
          confirmLabel={t("knowledgeSync.pat.remove")}
          onKeep={() => setConfirming(false)}
          onConfirm={handleRemove}
        />
      )}
    </form>
  );
}

function PassphraseSection({ configured, autoFocus, onChanged }) {
  const { t } = useTranslation();
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const valid = value.length >= PASSPHRASE_MIN_LENGTH;

  useEffect(() => () => setValue(""), []);

  const handleSave = async (e) => {
    e.preventDefault();
    if (!valid || saving) return;
    setSaving(true);
    const { ok, error } = await KnowledgeSync.setPassphrase(value);
    setSaving(false);
    setValue("");
    if (!ok)
      return showToast(formatKsError(t, error), "error", { clear: true });
    showToast(t("knowledgeSync.saved"), "success", { clear: true });
    onChanged();
  };

  const handleClear = async () => {
    setConfirming(false);
    const { ok, error } = await KnowledgeSync.clearPassphrase();
    if (!ok)
      return showToast(formatKsError(t, error), "error", { clear: true });
    showToast(t("knowledgeSync.saved"), "success", { clear: true });
    onChanged();
  };

  return (
    <form onSubmit={handleSave} className="mt-6 flex flex-col gap-y-4 max-w-xl">
      <h2 className="text-base font-semibold text-white">
        {t("knowledgeSync.passphrase.heading")}
      </h2>
      <StatusRow
        configured={configured}
        label={t("knowledgeSync.passphrase.configured")}
      />
      {configured && (
        <div className="flex items-start gap-x-2 rounded-lg bg-yellow-600 bg-opacity-20 px-4 py-2 text-xs leading-[18px] text-yellow-400">
          <Warning size={16} weight="fill" className="flex-shrink-0 mt-0.5" />
          <span>{t("knowledgeSync.passphrase.changeWarning")}</span>
        </div>
      )}
      <div className="flex flex-col gap-y-1">
        <input
          type="password"
          autoComplete="new-password"
          minLength={PASSPHRASE_MIN_LENGTH}
          autoFocus={autoFocus}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full bg-theme-bg-primary text-white text-sm border border-theme-border rounded-lg px-4 py-2 outline-none focus:border-blue-500"
        />
        <p className="text-xs leading-[18px] text-white text-opacity-60">
          {value.length > 0 && !valid
            ? t("knowledgeSync.passphrase.tooShort")
            : t("knowledgeSync.passphrase.hint")}
        </p>
      </div>
      <div className="flex gap-x-2">
        <button
          type="submit"
          disabled={!valid || saving}
          className="px-4 py-2 text-sm font-semibold bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-all disabled:opacity-50"
        >
          {saving
            ? t("knowledgeSync.saving")
            : t("knowledgeSync.passphrase.save")}
        </button>
        {configured && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="px-4 py-2 text-sm font-semibold bg-red-500 text-white rounded-lg hover:bg-red-600 transition-all"
          >
            {t("knowledgeSync.passphrase.clear")}
          </button>
        )}
      </div>
      {confirming && (
        <ConfirmModal
          title={t("knowledgeSync.passphrase.clearTitle")}
          body={t("knowledgeSync.passphrase.clearBody")}
          keepLabel={t("knowledgeSync.passphrase.keep")}
          confirmLabel={t("knowledgeSync.passphrase.clear")}
          onKeep={() => setConfirming(false)}
          onConfirm={handleClear}
        />
      )}
    </form>
  );
}
