import { useTranslation } from "react-i18next";
import {
  CheckCircle,
  CircleNotch,
  Circle,
  WarningCircle,
} from "@phosphor-icons/react";
import { formatKsError } from "@/utils/knowledgeSyncErrors";

const PHASES = {
  publish: ["pack", "encrypt", "upload"],
  sync: ["preview", "download", "verify", "import"],
  rollback: ["verify", "import"],
};
const CANCELLABLE = ["preview", "pack", "encrypt", "upload", "download"];
const RETRY_KEY = { sync: "retrySync", publish: "retryPublish" };

function StepIcon({ status }) {
  if (status === "done")
    return <CheckCircle size={16} weight="fill" className="text-green-400" />;
  if (status === "running")
    return (
      <CircleNotch size={16} className="animate-spin text-white" aria-hidden />
    );
  if (status === "failed")
    return <WarningCircle size={16} weight="fill" className="text-red-400" />;
  return <Circle size={16} className="text-theme-text-secondary" />;
}

export default function JobProgress({ job, onCancel, onRetry, onConfirm }) {
  const { t } = useTranslation();
  if (!job || job.state === "succeeded") return null;

  const phases = PHASES[job.kind] || [];
  const idx = phases.indexOf(job.phase);
  const failed = ["failed", "cancelled", "interrupted"].includes(job.state);
  const waiting = job.state === "awaiting_confirm";
  const statusOf = (i) => {
    if (idx === -1) return failed || i > 0 ? "pending" : "running";
    if (i < idx) return "done";
    if (i === idx) return failed ? "failed" : waiting ? "done" : "running";
    return "pending";
  };
  const hasPercent = typeof job.percent === "number";
  const pct = hasPercent
    ? Math.max(0, Math.min(100, Math.round(job.percent)))
    : 0;
  const running = job.state === "running";
  const canCancel =
    running && (job.phase === null || CANCELLABLE.includes(job.phase));
  const phaseLabel = job.phase ? t(`knowledgeSync.phases.${job.phase}`) : "";

  return (
    <div className="flex flex-col gap-y-2 w-full">
      <div role="status" aria-live="polite" className="sr-only">
        {phaseLabel}
      </div>
      <ol className="flex flex-col md:flex-row md:items-center gap-y-2 md:gap-x-4">
        {phases.map((p, i) => {
          const status = statusOf(i);
          return (
            <li
              key={p}
              className="flex items-center gap-x-1"
              aria-current={status === "running" ? "step" : undefined}
            >
              <StepIcon status={status} />
              <span
                className={`text-xs font-semibold ${
                  status === "pending"
                    ? "text-theme-text-secondary"
                    : "text-white"
                }`}
              >
                {t(`knowledgeSync.phases.${p}`)}
              </span>
            </li>
          );
        })}
      </ol>

      {running && hasPercent && (
        <div className="flex items-center gap-x-2 w-full">
          <div
            role="progressbar"
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={pct}
            aria-label={phaseLabel}
            className="h-1.5 rounded-full bg-theme-bg-primary flex-1 overflow-hidden"
          >
            <div
              className="h-1.5 rounded-full bg-theme-button-primary transition-[width] duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs tabular-nums text-white text-opacity-60">
            {t("knowledgeSync.job.percent", { percent: pct })}
          </span>
        </div>
      )}

      {waiting && (
        <div className="flex items-center gap-x-2">
          <span className="text-xs text-theme-text-secondary">
            {t("knowledgeSync.job.awaitingConfirm")}
          </span>
          {onConfirm && (
            <button
              type="button"
              onClick={onConfirm}
              className="px-4 py-2 text-sm font-semibold text-white rounded-lg bg-theme-button-primary"
            >
              {t("knowledgeSync.actions.confirmSync")}
            </button>
          )}
        </div>
      )}

      {running && onCancel && (
        <div>
          {canCancel ? (
            <button
              type="button"
              onClick={onCancel}
              className="text-sm font-semibold text-theme-text-secondary hover:text-white"
            >
              {t("knowledgeSync.actions.cancel")}
            </button>
          ) : (
            <span className="text-xs text-theme-text-secondary">
              {t("knowledgeSync.actions.cancelDisabledImporting")}
            </span>
          )}
        </div>
      )}

      {failed && (
        <div className="flex flex-col gap-y-2">
          {job.state === "cancelled" && (
            <p className="text-sm text-theme-text-secondary">
              {t("knowledgeSync.job.cancelled")}
            </p>
          )}
          {job.state === "interrupted" && (
            <p className="text-xs text-theme-text-secondary">
              {t("knowledgeSync.job.interrupted")}
            </p>
          )}
          {job.state === "failed" && (
            <p className="text-sm text-red-400">
              {formatKsError(t, job.error)}
            </p>
          )}
          {onRetry && (
            <div>
              <button
                type="button"
                onClick={onRetry}
                className="px-4 py-2 text-sm font-semibold text-white rounded-lg border border-theme-border hover:bg-theme-bg-primary"
              >
                {t(`knowledgeSync.actions.${RETRY_KEY[job.kind] || "retry"}`)}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
