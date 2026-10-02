import {
  CircleNotch,
  FileCode,
  FileCsv,
  FileDoc,
  FileHtml,
  FileText,
  FileImage,
  FilePdf,
  WarningOctagon,
  X,
  Cpu,
  CheckCircle,
} from "@phosphor-icons/react";
import { useState, useEffect } from "react";
import { REMOVE_ATTACHMENT_EVENT } from "../../DnDWrapper";
import { openImageLightbox } from "@/components/ImageLightbox";

/**
 * @param {{attachments: import("../../DnDWrapper").Attachment[]}}
 * @returns
 */
export default function AttachmentManager({ attachments }) {
  if (attachments.length === 0) return null;

  function handleImageClick(attachment) {
    const imageAttachments = attachments
      .filter((a) => a.type === "attachment" && a.contentString)
      .map((a) => ({ contentString: a.contentString, name: a.file.name }));
    const idx = imageAttachments.findIndex(
      (img) => img.name === attachment.file?.name
    );
    if (idx !== -1) openImageLightbox(imageAttachments, idx);
  }

  return (
    <div className="flex flex-wrap gap-2 mt-2 mb-4">
      {attachments.map((attachment) => (
        <AttachmentItem
          key={attachment.uid}
          attachment={attachment}
          onImageClick={() => handleImageClick(attachment)}
        />
      ))}
    </div>
  );
}

/**
 * @param {{attachment: import("../../DnDWrapper").Attachment}}
 */
function AttachmentItem({ attachment, onImageClick }) {
  const { uid, file, status, error, document, type, contentString } =
    attachment;
  const { iconBgColor, Icon } = displayFromFile(file);

  const [progressPercent, setProgressPercent] = useState(10);
  const [stage, setStage] = useState("converting"); // "converting" -> "embedding" -> "complete"

  useEffect(() => {
    if (status === "in_progress") {
      setStage("converting");
      const interval = setInterval(() => {
        setProgressPercent((prev) => {
          if (prev < 65) return prev + Math.floor(Math.random() * 5) + 2;
          if (prev < 85) return prev + 1;
          return 85;
        });
      }, 200);
      return () => clearInterval(interval);
    } else if (
      status === "embedded" ||
      status === "added_context" ||
      status === "success"
    ) {
      setStage("embedding");
      setProgressPercent(95);
      const timeout = setTimeout(() => {
        setProgressPercent(100);
        setStage("complete");
      }, 600);
      return () => clearTimeout(timeout);
    }
  }, [status]);

  function removeFileFromQueue() {
    window.dispatchEvent(
      new CustomEvent(REMOVE_ATTACHMENT_EVENT, { detail: { uid, document } })
    );
  }

  if (status === "in_progress") {
    const isPdf = file?.name?.toLowerCase()?.endsWith(".pdf");
    return (
      <div className="relative flex flex-col gap-y-1.5 p-2 rounded-xl bg-zinc-900/90 light:bg-white border border-white/20 light:border-gray-300 w-[280px] shadow-lg group">
        <div className="flex items-center justify-between gap-x-2">
          <div className="flex items-center gap-x-2 truncate">
            <div
              className={`p-1 rounded-md ${
                stage === "converting"
                  ? "bg-blue-500/20 text-blue-400 animate-pulse"
                  : "bg-emerald-500/20 text-emerald-400 animate-pulse"
              }`}
            >
              {stage === "converting" ? (
                <FilePdf className="w-4 h-4" />
              ) : (
                <Cpu className="w-4 h-4" />
              )}
            </div>
            <p className="text-white light:text-gray-900 text-xs font-semibold truncate">
              {file.name}
            </p>
          </div>
          <CircleNotch
            size={14}
            weight="bold"
            className="text-blue-400 animate-spin flex-shrink-0"
          />
        </div>

        {/* Animated Multi-Stage Progress Bar */}
        <div className="w-full bg-zinc-800 light:bg-gray-200 h-1.5 rounded-full overflow-hidden">
          <div
            className={`h-full transition-all duration-300 rounded-full ${
              stage === "converting"
                ? "bg-gradient-to-r from-blue-500 via-indigo-500 to-purple-600 animate-pulse"
                : "bg-gradient-to-r from-cyan-400 to-emerald-500 animate-pulse"
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* Detailed Stage Status */}
        <p className="text-[10px] font-medium leading-none text-white/80 light:text-gray-700">
          {stage === "converting"
            ? isPdf
              ? "Stage 1: PDF → Markdown OCR Conversion..."
              : "Stage 1: Converting Document to Markdown..."
            : "Stage 2: Embedding Markdown into Workspace RAG..."}
        </p>
      </div>
    );
  }

  if (status === "failed") {
    return (
      <div
        data-tooltip-id="attachment-status-tooltip"
        data-tooltip-content={error}
        className={`relative flex items-center gap-x-1 rounded-lg bg-theme-attachment-error-bg border-none w-[180px] group`}
      >
        <div className="invisible group-hover:visible absolute -top-[5px] -right-[5px] w-fit h-fit z-[10]">
          <button
            onClick={removeFileFromQueue}
            type="button"
            className="bg-white hover:bg-error hover:text-theme-attachment-text rounded-full p-1 flex items-center justify-center hover:border-transparent border border-theme-attachment-bg"
          >
            <X size={10} className="flex-shrink-0" />
          </button>
        </div>
        <div
          className={`bg-error rounded-md flex items-center justify-center flex-shrink-0 h-[32px] w-[32px] m-1`}
        >
          <WarningOctagon size={24} className="text-theme-attachment-icon" />
        </div>
        <div className="flex flex-col w-[125px]">
          <p className="text-theme-attachment-text text-xs font-semibold truncate">
            {file.name}
          </p>
          <p className="text-theme-attachment-text-secondary text-[10px] leading-[14px] font-medium truncate">
            {error ?? "File not embedded!"}
          </p>
        </div>
      </div>
    );
  }

  if (type === "attachment") {
    if (contentString) {
      return (
        <div
          data-tooltip-id="attachment-status-tooltip"
          data-tooltip-content={`${file.name} will be attached to this prompt. It will not be embedded into the workspace permanently.`}
          className={`relative flex items-center gap-x-1 rounded-lg border-none group`}
        >
          <div className="invisible group-hover:visible absolute -top-[5px] -right-[5px] w-fit h-fit z-[10]">
            <button
              onClick={removeFileFromQueue}
              type="button"
              className="bg-white hover:bg-error hover:text-theme-attachment-text rounded-full p-1 flex items-center justify-center hover:border-transparent border border-theme-attachment-bg"
            >
              <X size={10} className="flex-shrink-0" />
            </button>
          </div>
          <button
            type="button"
            onClick={onImageClick}
            className="p-0 border-none bg-transparent cursor-pointer"
          >
            <img
              alt={`Preview of ${file.name}`}
              src={contentString}
              style={{ objectFit: "cover", objectPosition: "center" }}
              className={`${iconBgColor} w-[40px] h-[40px] rounded-lg flex items-center justify-center`}
            />
          </button>
        </div>
      );
    }

    return (
      <div
        data-tooltip-id="attachment-status-tooltip"
        data-tooltip-content={`${file.name} will be attached to this prompt. It will not be embedded into the workspace permanently.`}
        className={`relative flex items-center gap-x-1 rounded-lg bg-theme-attachment-success-bg border-none w-[180px] group`}
      >
        <div className="invisible group-hover:visible absolute -top-[5px] -right-[5px] w-fit h-fit z-[10]">
          <button
            onClick={removeFileFromQueue}
            type="button"
            className="bg-white hover:bg-error hover:text-theme-attachment-text rounded-full p-1 flex items-center justify-center hover:border-transparent border border-theme-attachment-bg"
          >
            <X size={10} className="flex-shrink-0" />
          </button>
        </div>
        <div
          className={`${iconBgColor} rounded-md flex items-center justify-center flex-shrink-0 h-[32px] w-[32px] m-1`}
        >
          <Icon size={24} className="text-theme-attachment-icon" />
        </div>
        <div className="flex flex-col w-[125px]">
          <p className="text-theme-attachment-text text-xs font-semibold truncate">
            {file.name}
          </p>
          <p className="text-theme-attachment-text-secondary text-[10px] leading-[14px] font-medium">
            Image attached!
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-tooltip-id="attachment-status-tooltip"
      data-tooltip-content={
        status === "embedded"
          ? `${file.name} was converted to Markdown via MarkItDown + Tesseract OCR and embedded into this workspace.`
          : `${file.name} will be used as context for this chat.`
      }
      className={`relative flex items-center gap-x-1 rounded-lg bg-theme-attachment-bg border-none w-[200px] group border border-emerald-500/30`}
    >
      <div className="invisible group-hover:visible absolute -top-[5px] -right-[5px] w-fit h-fit z-[10]">
        <button
          onClick={removeFileFromQueue}
          type="button"
          className="bg-white hover:bg-error hover:text-theme-attachment-text rounded-full p-1 flex items-center justify-center hover:border-transparent border border-theme-attachment-bg"
        >
          <X size={10} className="flex-shrink-0" />
        </button>
      </div>
      <div
        className={`${iconBgColor} rounded-md flex items-center justify-center flex-shrink-0 h-[32px] w-[32px] m-1`}
      >
        <Icon size={24} weight="light" className="text-theme-attachment-icon" />
      </div>
      <div className="flex flex-col w-[145px]">
        <p className="text-white text-xs font-semibold truncate">{file.name}</p>
        <p className="text-emerald-400 text-[10px] leading-[14px] font-semibold flex items-center gap-x-1">
          <CheckCircle size={12} />
          {status === "embedded" ? "Markdown Embedded!" : "Added as Context!"}
        </p>
      </div>
    </div>
  );
}

/**
 * @param {File} file
 * @returns {{iconBgColor:string, Icon: React.Component}}
 */
function displayFromFile(file) {
  const extension = file?.name?.split(".")?.pop()?.toLowerCase() ?? "txt";
  switch (extension) {
    case "pdf":
      return { iconBgColor: "bg-magenta", Icon: FilePdf };
    case "doc":
    case "docx":
      return { iconBgColor: "bg-royalblue", Icon: FileDoc };
    case "html":
      return { iconBgColor: "bg-purple", Icon: FileHtml };
    case "csv":
    case "xlsx":
      return { iconBgColor: "bg-success", Icon: FileCsv };
    case "json":
    case "sql":
    case "js":
    case "jsx":
    case "cpp":
    case "c":
      return { iconBgColor: "bg-warn", Icon: FileCode };
    case "png":
    case "jpg":
    case "jpeg":
      return { iconBgColor: "bg-royalblue", Icon: FileImage };
    default:
      return { iconBgColor: "bg-royalblue", Icon: FileText };
  }
}
