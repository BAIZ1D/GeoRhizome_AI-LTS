import React, { useState, useEffect, memo } from "react";
import truncate from "truncate";
import { XCircle, FileText, Cpu, Check } from "@phosphor-icons/react";
import Workspace from "../../../../../../models/workspace";
import { humanFileSize, milliToHms } from "../../../../../../utils/numbers";
import { useTranslation } from "react-i18next";

function FileUploadProgressComponent({
  slug,
  uuid,
  file,
  setFiles,
  rejected = false,
  reason = null,
  onUploadSuccess,
  onUploadError,
  setLoading,
  setLoadingMessage,
}) {
  const [timerMs, setTimerMs] = useState(10);
  const [stage, setStage] = useState("converting"); // "converting" -> "embedding" -> "complete" -> "failed"
  const [status, setStatus] = useState("pending");
  const [error, setError] = useState("");
  const [isFadingOut, setIsFadingOut] = useState(false);
  const [progressPercent, setProgressPercent] = useState(10);
  const [ocrMessage, setOcrMessage] = useState("");
  const { t } = useTranslation();

  const fadeOut = (cb) => {
    setIsFadingOut(true);
    cb?.();
  };

  const beginFadeOut = () => {
    setIsFadingOut(false);
    setFiles((prev) => {
      return prev.filter((item) => item.uid !== uuid);
    });
  };

  useEffect(() => {
    async function uploadFile() {
      setLoading(true);
      setStage("converting");
      setLoadingMessage(
        "Converting PDF to Markdown (MarkItDown + Tesseract Japanese OCR)..."
      );
      const start = Number(new Date());

      // Progress animation ticker
      const timer = setInterval(() => {
        const elapsed = Number(new Date()) - start;
        setTimerMs(elapsed);
      }, 200);

      // Real-time API Polling for OCR progress
      const API_BASE = import.meta.env.VITE_API_BASE || "/api";
      const pollTimer = setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE}/workspace/${slug}/upload-progress?filename=${encodeURIComponent(file.name)}`, {
            headers: {
              "Authorization": `Bearer ${window.localStorage.getItem("anythingllm_authToken")}`
            }
          });
          if (res.ok) {
            const data = await res.json();
            if (data.message) {
              const parseMatch = data.message.match(/Parsing page (\d+) of (\d+)\.\.\. \(Tesseract OCR\)/);
              if (parseMatch) {
                setOcrMessage(t('upload.progress.parsing', { current: parseMatch[1], total: parseMatch[2], defaultValue: `Parsing page ${parseMatch[1]} of ${parseMatch[2]}... (Tesseract OCR)` }));
              } else {
                setOcrMessage(data.message);
              }
            }
            if (data.total && data.current) {
              const perc = Math.floor((data.current / data.total) * 88);
              setProgressPercent(perc > 10 ? perc : 10);
            } else {
              setProgressPercent((prev) => (prev < 20 ? prev + 1 : 20)); // Fake initial queue progress
            }
          }
        } catch (e) {}
      }, 1500);

      const formData = new FormData();
      formData.append("file", file, file.name);

      const { response, data } = await Workspace.uploadFile(slug, formData);
      if (!response.ok) {
        setStatus("failed");
        setStage("failed");
        clearInterval(timer);
        clearInterval(pollTimer);
        onUploadError(data.error);
        setError(data.error);
      } else {
        // Transition to Stage 2: Markdown RAG Embedding
        setStage("embedding");
        setLoadingMessage(
          "Embedding Markdown text into Workspace Vector Store (LanceDB)..."
        );
        setProgressPercent(92);

        setTimeout(() => {
          setProgressPercent(100);
          setLoading(false);
          setLoadingMessage("");
          setStatus("complete");
          setStage("complete");
          clearInterval(timer);
          clearInterval(pollTimer);
          onUploadSuccess();
        }, 800);
      }

      // Begin fadeout timer to clear uploader queue
      setTimeout(() => {
        fadeOut(() => setTimeout(() => beginFadeOut(), 300));
      }, 5000);
    }

    !!file && !rejected && uploadFile();
  }, []);

  if (rejected) {
    return (
      <div
        className={`${
          isFadingOut ? "file-upload-fadeout" : "file-upload"
        } h-16 px-3 py-2 flex items-center gap-x-4 rounded-xl bg-error/40 light:bg-error/30 light:border-solid light:border-error/40 border border-transparent`}
      >
        <div className="w-6 h-6 flex-shrink-0">
          <XCircle
            color="var(--theme-bg-primary)"
            className="w-6 h-6 stroke-white bg-error rounded-full p-1 w-full h-full"
          />
        </div>
        <div className="flex flex-col">
          <p className="text-white light:text-red-600 text-xs font-semibold">
            {truncate(file.name, 30)}
          </p>
          <p className="text-red-100 light:text-red-600 text-xs font-medium">
            {reason || "this file failed to upload"}
          </p>
        </div>
      </div>
    );
  }

  if (stage === "failed" || status === "failed") {
    return (
      <div
        className={`${
          isFadingOut ? "file-upload-fadeout" : "file-upload"
        } h-16 px-3 py-2 flex items-center gap-x-4 rounded-xl bg-error/40 light:bg-error/30 light:border-solid light:border-error/40 border border-transparent`}
      >
        <div className="w-6 h-6 flex-shrink-0">
          <XCircle
            color="var(--theme-bg-primary)"
            className="w-6 h-6 stroke-white bg-error rounded-full p-1 w-full h-full"
          />
        </div>
        <div className="flex flex-col">
          <p className="text-white light:text-red-600 text-xs font-semibold">
            {truncate(file.name, 30)}
          </p>
          <p className="text-red-100 light:text-red-600 text-xs font-medium">
            {error}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`${
        isFadingOut ? "file-upload-fadeout" : "file-upload"
      } flex flex-col p-3 rounded-xl bg-zinc-900/90 light:bg-white border border-white/15 light:border-gray-300 shadow-lg gap-y-2`}
    >
      <div className="flex items-center justify-between gap-x-3">
        <div className="flex items-center gap-x-2">
          {stage === "converting" && (
            <div className="p-1 rounded-md bg-blue-500/20 text-blue-400 animate-pulse">
              <FileText className="w-4 h-4" />
            </div>
          )}
          {stage === "embedding" && (
            <div className="p-1 rounded-md bg-emerald-500/20 text-emerald-400 animate-pulse">
              <Cpu className="w-4 h-4" />
            </div>
          )}
          {stage === "complete" && (
            <div className="p-1 rounded-md bg-green-500/20 text-green-400">
              <Check className="w-4 h-4" />
            </div>
          )}

          <span className="text-white light:text-gray-900 text-xs font-semibold">
            {truncate(file.name, 28)}
          </span>
        </div>

        <span className="text-white/60 light:text-gray-500 text-[10px] font-mono">
          {milliToHms(timerMs)}
        </span>
      </div>

      {/* Animated Multi-Stage Progress Bar */}
      <div className="w-full bg-zinc-800 light:bg-gray-200 h-2 rounded-full overflow-hidden relative">
        <div
          className={`h-full transition-all duration-300 rounded-full ${
            stage === "converting"
              ? "bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-600 animate-pulse"
              : stage === "embedding"
                ? "bg-gradient-to-r from-cyan-400 to-emerald-500 animate-pulse"
                : "bg-emerald-500"
          }`}
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* Stage Status Indicator Text */}
      <div className="flex items-center justify-between text-[11px] font-medium">
        <span className="text-white/80 light:text-gray-700 flex items-center gap-x-1">
          {stage === "converting" && (
            <span className="text-blue-400 font-semibold">
              {ocrMessage || t("upload.progress.stage1", { defaultValue: "Stage 1: PDF → Markdown OCR Conversion..." })}
            </span>
          )}
          {stage === "embedding" && (
            <span className="text-emerald-400 font-semibold">
              {t("upload.progress.stage2", { defaultValue: "Stage 2: Embedding Markdown into Workspace RAG..." })}
            </span>
          )}
          {stage === "complete" && (
            <span className="text-green-400 font-semibold">
              {t("upload.progress.complete", { defaultValue: "✅ 100% Converted & Embedded!" })}
            </span>
          )}
        </span>

        <span className="text-white/60 light:text-gray-500 text-[10px]">
          {humanFileSize(file.size)}
        </span>
      </div>
    </div>
  );
}

export default memo(FileUploadProgressComponent);
