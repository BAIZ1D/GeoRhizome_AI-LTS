import {
  parseChunkSource,
  SourceTypeCircle,
  getCustomImage,
} from "../../ChatHistory/Citation";
import { useTranslation } from "react-i18next";

export default function SourceItem({ source, onClick }) {
  const { t } = useTranslation();
  const info = parseChunkSource(source);
  const customImage = getCustomImage(info?.icon);
  const subtitle = info?.isUrl ? info?.text : t("chat_window.document");

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex flex-col gap-[8px] items-start w-full text-left p-3 rounded-xl bg-zinc-800/40 light:bg-slate-50 hover:bg-zinc-800/80 light:hover:bg-slate-100 border border-zinc-700/30 light:border-slate-200 hover:border-theme-green/30 hover:scale-[1.02] hover:shadow-[0_0_12px_rgba(123,189,52,0.1)] transition-all duration-300"
    >
      <div className="flex gap-[6px] items-center w-full">
        <SourceTypeCircle
          type={info.icon}
          size={18}
          iconSize={10}
          url={info.href}
          customImage={customImage}
        />
        <p className="flex-1 font-medium text-sm text-white light:text-slate-900 leading-[15px] truncate">
          {source.title}
        </p>
      </div>
      <div className="flex flex-col gap-[2px] pl-[24px] text-[10px] text-zinc-400 light:text-slate-500 leading-[14px] w-full">
        <p className="truncate max-w-[280px]">{subtitle}</p>
        <p>{t("chat_window.source_count", { count: source.references })}</p>
      </div>
    </button>
  );
}
