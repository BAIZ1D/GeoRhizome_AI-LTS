import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import KnowledgeSync from "@/models/knowledgeSync";
import showToast from "@/utils/toast";
import { formatKsError } from "@/utils/knowledgeSyncErrors";

const TERMINAL = ["succeeded", "failed", "cancelled", "interrupted"];
const FALLBACK_POLL_MS = 1000; // only used until the server reports its own value
const START = {
  sync: KnowledgeSync.sync,
  publish: KnowledgeSync.publish,
  rollback: KnowledgeSync.rollback,
};

export const isTerminal = (job) => !!job && TERMINAL.includes(job.state);

/**
 * Tracks the job for a workspace: re-attaches on mount (D-06), polls with a
 * chained setTimeout at the server-provided interval, toasts once per
 * terminal transition (D-09).
 */
export default function useKsJob(slug, { onTerminal } = {}) {
  const { t } = useTranslation();
  const [job, setJob] = useState(null);
  const [startError, setStartError] = useState(null);
  const timer = useRef(null);
  const alive = useRef(true);
  const toasted = useRef(new Set());
  const watching = useRef(false); // true only for jobs this mount saw running
  const onTerminalRef = useRef(onTerminal);
  onTerminalRef.current = onTerminal;

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  const announce = useCallback(
    (j) => {
      if (!isTerminal(j) || toasted.current.has(j.id) || !watching.current)
        return;
      toasted.current.add(j.id);
      const action = t(`knowledgeSync.jobKind.${j.kind}`);
      if (j.state === "succeeded") {
        const key = {
          publish: "publishDone",
          rollback: "rollbackDone",
        }[j.kind];
        showToast(t(`knowledgeSync.toast.${key || "syncDone"}`), "success");
      } else if (j.state === "cancelled") {
        showToast(t("knowledgeSync.toast.cancelled"), "info");
      } else if (j.state === "interrupted") {
        showToast(t("knowledgeSync.toast.interrupted"), "warning");
      } else {
        showToast(
          t("knowledgeSync.toast.failed", {
            action,
            message: formatKsError(t, j.error),
          }),
          "error"
        );
      }
      onTerminalRef.current?.(j);
    },
    [t]
  );

  const poll = useCallback(
    async (id) => {
      clear();
      const res = await KnowledgeSync.job(id);
      if (!alive.current) return;
      if (!res.ok) {
        // Terminal client-side state so the UI offers Retry instead of hanging.
        setJob((prev) =>
          prev ? { ...prev, state: "failed", error: res.error } : prev
        );
        return;
      }
      const next = res.data.job;
      setJob(next);
      if (isTerminal(next)) {
        announce(next);
        return;
      }
      const ms = res.data.job_poll_interval_ms || FALLBACK_POLL_MS;
      timer.current = setTimeout(() => poll(id), ms);
    },
    [announce]
  );

  useEffect(() => {
    alive.current = true;
    if (!slug) return undefined;
    (async () => {
      const res = await KnowledgeSync.workspaceJob(slug);
      if (!alive.current || !res.ok || !res.data.job) return;
      const attached = res.data.job;
      setJob(attached);
      if (isTerminal(attached)) {
        toasted.current.add(attached.id);
        return;
      }
      watching.current = true;
      const ms = res.data.job_poll_interval_ms || FALLBACK_POLL_MS;
      timer.current = setTimeout(() => poll(attached.id), ms);
    })();
    return () => {
      alive.current = false;
      clear();
    };
  }, [slug, poll]);

  const start = useCallback(
    async (kind) => {
      setStartError(null);
      const begin = START[kind];
      if (!begin || !slug) return null;
      const res = await begin(slug);
      if (!res.ok) {
        setStartError(res.error);
        showToast(
          t("knowledgeSync.toast.failed", {
            action: t(`knowledgeSync.jobKind.${kind}`),
            message: formatKsError(t, res.error),
          }),
          "error"
        );
        return null;
      }
      watching.current = true;
      const id = res.data.jobId;
      setJob({ id, kind, slug, state: "running", phase: null, percent: null });
      poll(id);
      return id;
    },
    [slug, poll, t]
  );

  const retry = useCallback(
    () => (job ? start(job.kind) : Promise.resolve(null)),
    [job, start]
  );

  const confirm = useCallback(async () => {
    if (!job) return;
    const res = await KnowledgeSync.confirmJob(job.id);
    if (!res.ok) {
      setStartError(res.error);
      return;
    }
    poll(job.id);
  }, [job, poll]);

  const cancel = useCallback(async () => {
    if (!job) return;
    const res = await KnowledgeSync.cancelJob(job.id);
    if (!res.ok) {
      setStartError(res.error);
      return;
    }
    poll(job.id);
  }, [job, poll]);

  return { job, startError, start, retry, cancel, confirm };
}
