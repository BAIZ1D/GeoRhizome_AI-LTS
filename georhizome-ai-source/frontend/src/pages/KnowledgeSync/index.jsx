import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { isMobile } from "react-device-detect";
import Sidebar from "@/components/SettingsSidebar";
import Workspace from "@/models/workspace";
import useKsCatalog from "@/components/KnowledgeSync/useKsCatalog";
import useKsJob, { isTerminal } from "@/components/KnowledgeSync/useKsJob";
import JobProgress from "@/components/KnowledgeSync/JobProgress";
import SyncDialog from "@/components/KnowledgeSync/SyncDialog";
import WipeModal from "@/components/KnowledgeSync/WipeModal";
import RollbackModal from "@/components/KnowledgeSync/RollbackModal";
import PassphrasePromptModal from "@/components/KnowledgeSync/PassphrasePromptModal";
import { resetKsCatalogCache } from "@/components/KnowledgeSync/useKsCatalog";

function statusKey(row, job, configured) {
  if (job?.state === "interrupted") return "interrupted";
  if (!configured) return row.catalog ? "setPassphrase" : "localOnly";
  if (!row.catalog) return "localOnly";
  if (!row.workspace) return "notOnMachine";
  if (row.catalog.localVersion == null) return "notSynced";
  return row.catalog.latestVersion > row.catalog.localVersion
    ? "updateAvailable"
    : "upToDate";
}

function Row({ row, configured, onChanged }) {
  const { t } = useTranslation();
  const slug = row.slug;
  const { job, start, retry, cancel, confirm } = useKsJob(slug, {
    onTerminal: onChanged,
  });
  const [dialog, setDialog] = useState(false);
  const [wipe, setWipe] = useState(false);
  const [rollback, setRollback] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const waiting = job?.state === "awaiting_confirm";
  const busy = !!job && !isTerminal(job);
  const key = statusKey(row, job, configured);
  const cat = row.catalog;
  const canSync = configured && !!cat && !busy;

  useEffect(() => {
    if (waiting) setDialog(true);
    if (!busy) setConfirming(false);
  }, [waiting, busy]);

  const startSync = async () => {
    setDialog(true);
    const id = await start("sync");
    if (!id) setDialog(false);
  };

  const closeDialog = async () => {
    setDialog(false);
    if (waiting) await cancel();
  };

  const doConfirm = async () => {
    setConfirming(true);
    await confirm();
    setDialog(false);
  };

  const backupVersion =
    cat?.backupVersion ?? Math.max(1, (cat?.localVersion ?? 2) - 1);

  return (
    <li className="flex flex-col gap-y-2 p-4 rounded-lg border border-theme-border">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <p className="text-sm font-semibold text-white">
            {row.workspace?.name || cat?.name || slug}
          </p>
          <p className="text-xs text-theme-text-secondary">
            {t(`knowledgeSync.status.${key}`)}
            {cat && (
              <>
                {" · "}
                {t("knowledgeSync.page.localVersion")}:{" "}
                {cat.localVersion ?? t("knowledgeSync.page.notAvailable")}
                {" · "}
                {t("knowledgeSync.page.publishedVersion")}: {cat.latestVersion}
              </>
            )}
          </p>
        </div>
        <div className="flex items-center gap-x-2">
          {canSync && (
            <button
              type="button"
              onClick={startSync}
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg bg-theme-button-primary"
            >
              {t("knowledgeSync.actions.syncVersion")}
            </button>
          )}
          {cat?.backupExists && !busy && (
            <button
              type="button"
              onClick={() => setRollback(true)}
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg border border-theme-border hover:bg-theme-bg-primary"
            >
              {t("knowledgeSync.actions.rollback", { version: backupVersion })}
            </button>
          )}
        </div>
      </div>
      {job && !isTerminal(job) && !waiting && (
        <JobProgress job={job} onCancel={cancel} />
      )}
      {job && isTerminal(job) && job.state !== "succeeded" && (
        <JobProgress job={job} onRetry={retry} />
      )}
      {row.workspace && cat && (
        <div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setWipe(true)}
            className="px-4 py-2 text-sm font-semibold text-white rounded-lg bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50"
          >
            {t("knowledgeSync.actions.wipe")}
          </button>
        </div>
      )}
      {dialog && (
        <SyncDialog
          name={row.workspace?.name || cat?.name || slug}
          job={job}
          confirming={confirming}
          onConfirm={doConfirm}
          onClose={closeDialog}
          onWipe={
            row.workspace
              ? () => {
                  setDialog(false);
                  setWipe(true);
                }
              : undefined
          }
        />
      )}
      {wipe && (
        <WipeModal
          slug={slug}
          onClose={() => setWipe(false)}
          onDone={onChanged}
        />
      )}
      {rollback && (
        <RollbackModal
          version={backupVersion}
          onClose={() => setRollback(false)}
          onConfirm={() => {
            setRollback(false);
            start("rollback");
          }}
        />
      )}
    </li>
  );
}

function KnowledgeSyncInner({ onPassphraseSaved }) {
  const { t } = useTranslation();
  const { entries, configured, lastChecked, refresh, loading } = useKsCatalog();
  const [workspaces, setWorkspaces] = useState([]);
  const [prompt, setPrompt] = useState(false);

  const loadWorkspaces = useCallback(async () => {
    setWorkspaces((await Workspace.all()) || []);
  }, []);
  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  const onChanged = useCallback(() => {
    loadWorkspaces();
    refresh();
  }, [loadWorkspaces, refresh]);

  const rows = useMemo(() => {
    const bySlug = new Map(workspaces.map((w) => [w.slug, w]));
    const out = entries.map((e) => ({
      slug: e.slug,
      workspace: bySlug.get(e.slug) || null,
      catalog: e,
    }));
    const known = new Set(entries.map((e) => e.slug));
    workspaces
      .filter((w) => !known.has(w.slug))
      .forEach((w) => out.push({ slug: w.slug, workspace: w, catalog: null }));
    return out;
  }, [entries, workspaces]);

  return (
    <div className="w-screen h-screen overflow-hidden bg-theme-bg-container flex">
      <Sidebar />
      <div
        style={{ height: isMobile ? "100%" : "calc(100% - 32px)" }}
        className="relative md:ml-[2px] md:mr-[16px] md:my-[16px] md:rounded-[16px] bg-theme-bg-secondary w-full h-full overflow-y-scroll p-4 md:p-0"
      >
        <div className="flex flex-col w-full max-w-4xl px-1 md:pl-6 md:pr-[50px] md:pt-6 pb-8">
          <div className="flex items-center justify-between border-white border-b-2 border-opacity-10 py-4">
            <p className="text-lg font-semibold text-theme-text-primary">
              {t("knowledgeSync.page.title")}
            </p>
            <div className="flex items-center gap-x-4">
              <span className="text-xs text-white text-opacity-60">
                {lastChecked
                  ? t("knowledgeSync.page.lastChecked", {
                      time: new Date(lastChecked).toLocaleString(),
                    })
                  : t("knowledgeSync.page.neverChecked")}
              </span>
              <button
                type="button"
                disabled={!configured || loading}
                onClick={refresh}
                className="px-4 py-2 text-sm font-semibold text-white rounded-lg border border-theme-border hover:bg-theme-bg-primary disabled:opacity-50"
              >
                {loading
                  ? t("knowledgeSync.actions.checking")
                  : t("knowledgeSync.actions.refresh")}
              </button>
            </div>
          </div>
          <p className="text-xs leading-[18px] text-white text-opacity-60 mt-2">
            {t("knowledgeSync.page.description")}
          </p>

          {!configured && (
            <div className="mt-4 p-4 rounded-lg border border-theme-border flex items-center justify-between gap-x-4">
              <div>
                <p className="text-sm font-semibold text-white">
                  {t("knowledgeSync.page.passphraseBannerTitle")}
                </p>
                <p className="text-xs text-theme-text-secondary">
                  {t("knowledgeSync.page.passphraseBannerBody")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPrompt(true)}
                className="px-4 py-2 text-sm font-semibold text-white rounded-lg bg-theme-button-primary"
              >
                {t("knowledgeSync.actions.setPassphrase")}
              </button>
            </div>
          )}

          {rows.length === 0 ? (
            <div className="mt-8">
              <p className="text-sm font-semibold text-white">
                {t("knowledgeSync.page.empty")}
              </p>
              <p className="text-xs text-theme-text-secondary">
                {t("knowledgeSync.page.emptyBody")}
              </p>
            </div>
          ) : (
            <ul className="mt-4 flex flex-col gap-y-3">
              {rows.map((row) => (
                <Row
                  key={row.slug}
                  row={row}
                  configured={configured}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          )}
          <p className="mt-8 text-sm font-semibold text-white">
            {t("knowledgeSync.page.dangerZone")}
          </p>
          <p className="text-xs text-theme-text-secondary">
            {t("knowledgeSync.page.dangerZoneBody")}
          </p>
        </div>
      </div>
      {prompt && (
        <PassphrasePromptModal
          onCancel={() => setPrompt(false)}
          onSaved={() => {
            setPrompt(false);
            onPassphraseSaved();
          }}
        />
      )}
    </div>
  );
}

export default function KnowledgeSyncPage() {
  const [gen, setGen] = useState(0);
  return (
    <KnowledgeSyncInner
      key={gen}
      onPassphraseSaved={() => {
        resetKsCatalogCache();
        setGen((g) => g + 1);
      }}
    />
  );
}
