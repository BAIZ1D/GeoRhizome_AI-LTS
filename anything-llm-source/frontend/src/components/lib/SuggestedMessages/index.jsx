export default function SuggestedMessages({
  suggestedMessages = [],
  sendCommand,
}) {
  if (!suggestedMessages?.length) return null;

  return (
    <div className="flex flex-col w-full max-w-[650px] mt-6 px-4">
      {suggestedMessages.map((msg, index) => {
        const text = msg.heading?.trim()
          ? `${msg.heading.trim()} ${msg.message?.trim() || ""}`
          : msg.message?.trim() || "";
        if (!text) return null;

        return (
          <div key={index} className="mb-2.5">
            <button
              type="button"
              onClick={() => sendCommand({ text, autoSubmit: true })}
              className="w-full text-left py-3 px-4 text-white/80 text-sm font-normal leading-5 hover:text-white bg-zinc-800/15 light:bg-slate-50 hover:bg-zinc-800/50 light:hover:bg-slate-100 border border-zinc-700/20 light:border-slate-200 hover:border-theme-green/30 hover:scale-[1.01] hover:shadow-[0_0_10px_rgba(123,189,52,0.08)] transition-all duration-300 rounded-xl"
            >
              {text}
            </button>
          </div>
        );
      })}
    </div>
  );
}
