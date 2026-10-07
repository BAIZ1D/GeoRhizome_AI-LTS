import os

filepath = 'georhizome-ai-source/frontend/src/pages/OnboardingFlow/Steps/LLMPreference/index.jsx'
with open(filepath, 'w', encoding='utf-8') as f:
    f.write("""import { useEffect, useRef } from "react";
import System from "@/models/system";
import paths from "@/utils/paths";
import showToast from "@/utils/toast";
import { useNavigate } from "react-router-dom";
import { Brain } from "@phosphor-icons/react";

export default function LLMPreference({
  setHeader,
  setForwardBtn,
  setBackBtn,
}) {
  const hiddenSubmitButtonRef = useRef(null);
  const navigate = useNavigate();

  const TITLE = "GeoRhizome Model Hub";
  const DESCRIPTION = "Hardware-Aware AI Model Serving";

  async function handleForward() {
    if (hiddenSubmitButtonRef.current) {
      hiddenSubmitButtonRef.current.click();
    }
  }

  function handleBack() {
    navigate(paths.onboarding.home());
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    const data = {};
    data.LLMProvider = "native";
    data.EmbeddingEngine = "native";
    data.VectorDB = "lancedb";

    const { error } = await System.updateSystem(data);
    if (error) {
      showToast(`Failed to save settings: ${error}`, "error");
      return;
    }
    navigate(paths.onboarding.userSetup());
  };

  useEffect(() => {
    setHeader({ title: TITLE, description: DESCRIPTION });
    setForwardBtn({ showing: true, disabled: false, onClick: handleForward });
    setBackBtn({ showing: true, disabled: false, onClick: handleBack });
  }, []);

  return (
    <div>
      <form onSubmit={handleSubmit} className="w-full">
        <div className="w-full relative border-theme-chat-input-border shadow border-2 rounded-lg text-white p-8 bg-[#050609]/70 backdrop-blur-md flex flex-col items-center text-center space-y-4">
          <Brain size={48} className="text-[#7bbd34]" />
          <h2 className="text-xl font-bold text-white tracking-tight">Model Selection is Automated</h2>
          <p className="text-zinc-400 text-sm max-w-md">
            Model downloading, quantization, and execution are fully managed via the 
            <strong className="text-[#7bbd34]"> GeoRhizome Local Model Hub </strong> 
            natively integrated into the chat interface.
          </p>
          <p className="text-zinc-500 text-xs">
            Please click continue to setup your Admin account.
          </p>
        </div>
        <button
          type="submit"
          ref={hiddenSubmitButtonRef}
          hidden
          aria-hidden="true"
        ></button>
      </form>
    </div>
  );
}
""")
