import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { DotsThreeVertical } from "@phosphor-icons/react";
import paths from "@/utils/paths";
import useKsJob from "@/components/KnowledgeSync/useKsJob";
import SyncDialog from "@/components/KnowledgeSync/SyncDialog";
import WipeModal from "@/components/KnowledgeSync/WipeModal";

/**
 * Per-workspace Knowledge Sync affordances: update dot (D-02) and an item
 * menu with Sync / Wipe (this machine only) for every signed-in user (C8).
 */
export default function KnowledgeSyncItem({ workspace, entry, configured }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { job, start, cancel, confirm } = useKsJob(workspace.slug);
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [wipe, setWipe] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const waiting = job?.state === "awaiting_confirm";
  useEffect(() => {
    if (waiting) setDialog(true);
  }, [waiting]);

  if (!entry) return null;
  const hasUpdate =
    configured && entry.latestVersion > (entry.localVersion ?? 0);

  const startSync = async () => {
    setOpen(false);
    setDialog(true);
    const id = await start("sync");
    if (!id) setDialog(false);
  };

  return (
    <div className="relative flex items-center gap-x-1" ref={ref}>
      {hasUpdate && (
        <button
          type="button"
          aria-label={t("knowledgeSync.sidebar.updateAvailable")}
          title={t("knowledgeSync.sidebar.updateAvailable")}
          onClick={(e) => {
            e.stopPropagation();
            navigate(paths.knowledgeSyncPage());
          }}
          className="h-2 w-2 rounded-full bg-yellow-500"
        />
      )}
      <button
        type="button"
        aria-label={t("knowledgeSync.actions.openPage")}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md p-[2px] hover:bg-zinc-500"
      >
        <DotsThreeVertical size={18} className="text-zinc-400" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-8 z-30 flex flex-col min-w-[160px] rounded-lg border border-theme-border bg-theme-bg-secondary p-2"
        >
          {configured && (
            <button
              type="button"
              role="menuitem"
              onClick={startSync}
              className="px-2 py-2 text-left text-sm text-white rounded hover:bg-theme-bg-primary"
            >
              {t("knowledgeSync.actions.syncVersion")}
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setWipe(true);
            }}
            className="px-2 py-2 text-left text-sm text-white rounded hover:bg-theme-bg-primary"
          >
            {t("knowledgeSync.sidebar.wipeThisMachine")}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => navigate(paths.knowledgeSyncPage())}
            className="px-2 py-2 text-left text-sm text-white rounded hover:bg-theme-bg-primary"
          >
            {t("knowledgeSync.actions.openPage")}
          </button>
        </div>
      )}
      {dialog && (
        <SyncDialog
          name={workspace.name}
          job={job}
          confirming={confirming}
          onConfirm={async () => {
            setConfirming(true);
            await confirm();
            setConfirming(false);
            setDialog(false);
          }}
          onClose={async () => {
            setDialog(false);
            if (waiting) await cancel();
          }}
          onWipe={() => {
            setDialog(false);
            setWipe(true);
          }}
        />
      )}
      {wipe && (
        <WipeModal slug={workspace.slug} onClose={() => setWipe(false)} />
      )}
    </div>
  );
}
