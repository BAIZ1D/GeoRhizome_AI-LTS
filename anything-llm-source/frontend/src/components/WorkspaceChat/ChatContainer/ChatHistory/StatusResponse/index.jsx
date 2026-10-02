import React, { useState } from "react";
import { CaretDown } from "@phosphor-icons/react";

import RhizomeLoader from "@/components/RhizomeLoader";

export default function StatusResponse({ messages = [], isThinking = false }) {
  const [isExpanded, setIsExpanded] = useState(true);
  const currentThought = messages[messages.length - 1];
  const previousThoughts = messages.slice(0, -1);

  React.useEffect(() => {
    if (messages.length > 1) setIsExpanded(true);
  }, [messages.length]);

  function handleExpandClick() {
    if (!previousThoughts.length > 0) return;
    setIsExpanded(!isExpanded);
  }

  return (
    <div className="flex justify-center w-full pr-4">
      <div className="w-full flex flex-col">
        <div className="w-full">
          <div
            onClick={handleExpandClick}
            style={{
              transition: "all 0.1s ease-in-out",
              borderRadius: "16px",
            }}
            className="relative bg-zinc-800 light:bg-slate-100 p-4"
          >
            <div className="absolute top-4 left-4 w-[18px] h-[18px] flex items-center justify-center">
              <div
                data-tooltip-id="agent-thinking"
                data-tooltip-content={
                  isThinking
                    ? "Agent is thinking..."
                    : "Agent has finished thinking"
                }
                aria-label={
                  isThinking
                    ? "Agent is thinking..."
                    : "Agent has finished thinking"
                }
              >
                <RhizomeLoader size="sm" label={null} animate={isThinking} />
              </div>
            </div>
            {previousThoughts?.length > 0 && (
              <button
                onClick={handleExpandClick}
                className="absolute top-4 right-4 border-none text-zinc-200 light:text-slate-800 transition-colors"
                data-tooltip-id="expand-cot"
                data-tooltip-content={
                  isExpanded ? "Hide thought chain" : "Show thought chain"
                }
                aria-label={
                  isExpanded ? "Hide thought chain" : "Show thought chain"
                }
              >
                <CaretDown
                  className={`w-4 h-4 transform transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                />
              </button>
            )}
            <div
              className={`ml-[28px] mr-[26px] transition-[max-height] duration-300 ease-in-out origin-top ${isExpanded ? "" : "overflow-hidden max-h-[18px]"}`}
            >
              <div className="text-zinc-200 light:text-slate-800 font-mono text-sm leading-[18px]">
                {!isExpanded ? (
                  <span className="block w-full truncate">
                    {currentThought.content}
                  </span>
                ) : (
                  <>
                    {previousThoughts.map((thought, index) => (
                      <div
                        key={`cot-${thought.uuid || index}`}
                        className="mb-2"
                      >
                        {thought.content}
                      </div>
                    ))}
                    <div>{currentThought.content}</div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
