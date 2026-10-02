import { useState, useRef } from "react";
import { Gear } from "@phosphor-icons/react";
import { Tooltip } from "react-tooltip";
import { useTheme } from "@/hooks/useTheme";

export default function AnswerLengthMenuButton() {
  const tooltipRef = useRef(null);

  const { theme } = useTheme();

  const toggleTooltip = () => {
    if (!tooltipRef.current) return;
    tooltipRef.current.isOpen
      ? tooltipRef.current.close()
      : tooltipRef.current.open();
  };

  return (
    <>
      <div
        id="answer-length-btn"
        data-tooltip-id="tooltip-answer-length-btn"
        aria-label="Answer Length"
        onClick={toggleTooltip}
        className="border-none flex justify-center items-center cursor-pointer p-2 rounded-full transition-all ml-2 hover:bg-zinc-700 light:hover:bg-slate-200 text-zinc-300 light:text-slate-600 hover:text-white light:hover:text-slate-800"
      >
        <Gear weight="fill" className="w-[20px] h-[20px] pointer-events-none" />
      </div>
      <Tooltip
        ref={tooltipRef}
        id="tooltip-answer-length-btn"
        place="bottom"
        opacity={1}
        clickable={true}
        delayShow={0}
        delayHide={300}
        arrowColor={
          theme === "light"
            ? "var(--theme-modal-border)"
            : "var(--theme-bg-primary)"
        }
        className="z-[99] !w-[180px] !bg-theme-bg-secondary !px-[5px] !rounded-lg !pointer-events-auto light:border-2 light:border-theme-modal-border shadow-2xl glass backdrop-blur-xl border border-white/10"
      >
        <AnswerLengthMenu tooltipRef={tooltipRef} />
      </Tooltip>
    </>
  );
}

function AnswerLengthMenu({ tooltipRef }) {
  const [selectedLength, setSelectedLength] = useState(
    window.localStorage.getItem("anythingllm_answer_length_pref") || "default"
  );

  const handleLengthChange = (length) => {
    setSelectedLength(length);
    window.localStorage.setItem("anythingllm_answer_length_pref", length);
    tooltipRef.current?.close();
  };

  return (
    <div className="flex flex-col justify-start items-stretch gap-1 p-2">
      <div className="text-xs text-zinc-400 light:text-slate-500 px-2 pb-1 font-semibold tracking-wider uppercase">
        回答の長さ
      </div>
      <button
        onClick={(e) => {
          e.preventDefault();
          handleLengthChange("concise");
        }}
        className={`border-none w-full hover:cursor-pointer px-3 py-2 rounded-md flex items-center group transition-all ${
          selectedLength === "concise"
            ? "bg-[var(--theme-green)] text-[#1C1E21] font-bold shadow-md"
            : "hover:bg-zinc-700/50 light:hover:bg-slate-100 text-zinc-300 light:text-slate-800"
        }`}
      >
        <div className="text-sm">簡潔</div>
      </button>

      <button
        onClick={(e) => {
          e.preventDefault();
          handleLengthChange("default");
        }}
        className={`border-none w-full hover:cursor-pointer px-3 py-2 rounded-md flex items-center group transition-all ${
          selectedLength === "default"
            ? "bg-[var(--theme-green)] text-[#1C1E21] font-bold shadow-md"
            : "hover:bg-zinc-700/50 light:hover:bg-slate-100 text-zinc-300 light:text-slate-800"
        }`}
      >
        <div className="text-sm">標準</div>
      </button>

      <button
        onClick={(e) => {
          e.preventDefault();
          handleLengthChange("detailed");
        }}
        className={`border-none w-full hover:cursor-pointer px-3 py-2 rounded-md flex items-center group transition-all ${
          selectedLength === "detailed"
            ? "bg-[var(--theme-green)] text-[#1C1E21] font-bold shadow-md"
            : "hover:bg-zinc-700/50 light:hover:bg-slate-100 text-zinc-300 light:text-slate-800"
        }`}
      >
        <div className="text-sm">詳細</div>
      </button>
    </div>
  );
}
