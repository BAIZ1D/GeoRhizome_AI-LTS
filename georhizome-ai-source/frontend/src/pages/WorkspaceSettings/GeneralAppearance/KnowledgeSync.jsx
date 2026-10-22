import { Link } from "react-router-dom";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CloudArrowUp, Trash } from "@phosphor-icons/react";
import KnowledgeSyncModel from "@/models/knowledgeSync";
import JobProgress from "@/components/KnowledgeSync/JobProgress";
import DeleteVersionModal from "@/components/KnowledgeSync/DeleteVersionModal";
import useKsJob from "@/components/KnowledgeSync/useKsJob";
import useKsCatalog from "@/components/KnowledgeSync/useKsCatalog";
import { humanFileSize } from "@/utils/numbers";
import useUser from "@/hooks/useUser";
import paths from "@/utils/paths";

function statusKey(entry) {
  if (!entry) return "localOnly";
  if (entry.localVersion == null) return "notOnMachine";
  return entry.localVersion >= entry.latestVersion
    ? "upToDate"
    : "updateAvailable";
}

export default function KnowledgeSync({ workspace }) {
  const { t } = useTranslation();
  const slug = workspace.slug;
  const { entries } = useKsCatalog();
  const entry = entries.find((e) => e.slug === slug) || null;
  const { user } = useUser();
  const admin = !user || user.role === "admin";
  const [versionsError, setVersionsError] = useState(null);
  const [hasPassphrase, setHasPassphrase] = useState(false);
  const [versions, setVersions] = useState([]);
  const [next, setNext] = useState(1);
  const [deleting, setDeleting] = useState(null);

  const loadVersions = useCallback(async () => {
    const res = await KnowledgeSyncModel.versions(slug);
    if (!res.ok) {
      setVersionsError(res.error?.code || "KS_E_UNKNOWN");
      return;
    }
    setVersionsError(null);
    setVersions(res.data.versions || []);
    setNext(res.data.next || 1);
  }, [slug]);

  const { job, startError, start, retry, cancel } = useKsJob(slug, {
    onTerminal: (j) => {
      if (j.kind === "publish") loadVersions();
    },
  });

  useEffect(() => {
    (async () => {
      const st = await KnowledgeSyncModel.status();
      setHasPassphrase(!!st.data?.passphrase?.configured);
      if (admin) loadVersions();
    })();
  }, [loadVersions, admin]);

  const running = job?.state === "running" || job?.state === "awaiting_confirm";
  const busy = running || startError?.code === "KS_E_BUSY";
  const canPublish = admin && hasPassphrase && !busy;
  const na = t("knowledgeSync.page.notAvailable");
  const latest = versions[versions.length - 1]?.version;
  const rows = [...versions].reverse();

  return (
    <div className="mt-8 flex flex-col gap-y-6">
      <div className="flex flex-col gap-y-2">
        <h2 className="text-lg font-semibold text-white">
          {t("knowledgeSync.tab.title")}
        </h2>
        <p className="text-sm text-theme-text-secondary">
          {t("knowledgeSync.tab.description")}
        </p>
      </div>

      <div className="rounded-lg border border-theme-border p-4 flex flex-col md:flex-row gap-4 md:gap-x-8">
        <div className="flex flex-col gap-y-1">
          <span className="text-xs text-theme-text-secondary">
            {t("knowledgeSync.tab.localVersion")}
          </span>
          <span className="text-base font-semibold text-white tabular-nums">
            {entry?.localVersion ?? na}
          </span>
        </div>
        <div className="flex flex-col gap-y-1">
          <span className="text-xs text-theme-text-secondary">
            {t("knowledgeSync.tab.publishedVersion")}
          </span>
          <span className="text-base font-semibold text-white tabular-nums">
            {entry?.latestVersion ?? na}
          </span>
        </div>
        <div className="flex flex-col gap-y-1">
          <span className="text-xs text-theme-text-secondary">&nbsp;</span>
          <span className="text-sm text-white">
            {t(`knowledgeSync.status.${statusKey(entry)}`)}
          </span>
        </div>
      </div>

      {!admin ? (
        <div
          role="note"
          className="rounded-lg border border-theme-border bg-theme-bg-primary p-4 text-sm text-theme-text-secondary"
        >
          {t("knowledgeSync.tab.readOnly")}
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-theme-border p-4 flex flex-col gap-y-3">
            <div>
              <button
                type="button"
                disabled={!canPublish}
                onClick={() => start("publish")}
                className="inline-flex items-center gap-x-2 px-4 py-2 rounded-lg bg-theme-button-primary text-white text-sm font-semibold disabled:opacity-50"
              >
                <CloudArrowUp size={16} />
                {t("knowledgeSync.actions.publish", { version: next })}
              </button>
            </div>
            <p className="text-xs text-theme-text-secondary">
              {hasPassphrase
                ? t("knowledgeSync.tab.publishHelper")
                : t("knowledgeSync.tab.noPassphrase")}
            </p>
            {versionsError && (
              <div
                role="alert"
                className="rounded-lg border border-yellow-600/60 p-3 flex flex-col gap-y-2"
              >
                <p className="text-sm text-white">
                  {t("knowledgeSync.tab.setupNeeded")}
                </p>
                <div>
                  <Link
                    to={paths.settings.knowledgeSync()}
                    className="inline-flex px-3 py-1.5 text-xs font-semibold text-white rounded-lg border border-theme-border hover:bg-theme-bg-primary focus:outline-none focus:ring-2 focus:ring-white"
                  >
                    {t("knowledgeSync.tab.openSettings")}
                  </Link>
                </div>
              </div>
            )}
            <JobProgress
              job={job?.kind === "publish" ? job : null}
              onCancel={cancel}
              onRetry={retry}
            />
          </div>

          <div className="flex flex-col gap-y-3">
            <h3 className="text-base font-semibold text-white">
              {t("knowledgeSync.versions.title")}
            </h3>
            {rows.length === 0 ? (
              <div className="flex flex-col gap-y-1">
                <p className="text-sm font-semibold text-white">
                  {t("knowledgeSync.versions.empty")}
                </p>
                <p className="text-sm text-theme-text-secondary">
                  {t("knowledgeSync.versions.emptyBody")}
                </p>
              </div>
            ) : (
              <>
                <table className="hidden md:table w-full text-sm text-white tabular-nums">
                  <thead>
                    <tr className="text-xs text-theme-text-secondary text-left">
                      <th className="py-2">
                        {t("knowledgeSync.versions.colVersion")}
                      </th>
                      <th>{t("knowledgeSync.versions.colPublished")}</th>
                      <th>{t("knowledgeSync.versions.colSize")}</th>
                      <th>{t("knowledgeSync.versions.colParts")}</th>
                      <th>{t("knowledgeSync.versions.colDocuments")}</th>
                      <th className="text-right">
                        {t("knowledgeSync.versions.colActions")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((v) => (
                      <tr
                        key={v.version}
                        className="border-t border-theme-border"
                      >
                        <td className="py-2 font-mono">
                          {v.version}
                          {v.version === latest && (
                            <span className="ml-2 text-xs text-theme-text-secondary">
                              {t("knowledgeSync.versions.latest")}
                            </span>
                          )}
                        </td>
                        <td>{new Date(v.publishedAt).toLocaleString()}</td>
                        <td>{humanFileSize(v.sizeBytes)}</td>
                        <td>{v.parts}</td>
                        <td>{v.docCount}</td>
                        <td className="text-right">
                          <button
                            type="button"
                            disabled={running}
                            onClick={() => setDeleting(v.version)}
                            className="inline-flex items-center gap-x-1 text-red-400 hover:text-red-300 disabled:opacity-50"
                          >
                            <Trash size={14} />
                            {t("knowledgeSync.actions.delete")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="md:hidden flex flex-col gap-y-2">
                  {rows.map((v) => (
                    <div
                      key={v.version}
                      className="rounded-lg border border-theme-border p-3 text-sm text-white tabular-nums flex flex-col gap-y-1"
                    >
                      <div className="font-mono">
                        {v.version}
                        {v.version === latest && (
                          <span className="ml-2 text-xs text-theme-text-secondary">
                            {t("knowledgeSync.versions.latest")}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-theme-text-secondary">
                        {new Date(v.publishedAt).toLocaleString()}
                      </div>
                      <div className="text-xs">
                        {humanFileSize(v.sizeBytes)} · {v.parts} · {v.docCount}
                      </div>
                      <button
                        type="button"
                        disabled={running}
                        onClick={() => setDeleting(v.version)}
                        className="self-start inline-flex items-center gap-x-1 text-red-400 disabled:opacity-50"
                      >
                        <Trash size={14} />
                        {t("knowledgeSync.actions.delete")}
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </>
      )}

      {deleting != null && (
        <DeleteVersionModal
          slug={slug}
          version={deleting}
          versions={versions}
          onClose={() => setDeleting(null)}
          onDone={loadVersions}
        />
      )}
    </div>
  );
}
