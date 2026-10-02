import { useState, useEffect } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { isMobile } from "react-device-detect";
import useUser from "@/hooks/useUser";
import { useModal } from "@/hooks/useModal";
import LLMSelectorModal from "../PromptInput/LLMSelector/index";
import SetupProvider from "../PromptInput/LLMSelector/SetupProvider";
import {
  SAVE_LLM_SELECTOR_EVENT,
  PROVIDER_SETUP_EVENT,
} from "../PromptInput/LLMSelector/action";
import Workspace from "@/models/workspace";
import System from "@/models/system";
import { SIDEBAR_TOGGLE_EVENT } from "@/components/Sidebar/SidebarToggle";

function fetchModelName(slug, setModelName) {
  if (!slug) return;
  Promise.all([
    Workspace.bySlug(slug),
    System.keys(),
    fetch("/api/hardware/status")
      .then((r) => r.json())
      .catch(() => null),
  ])
    .then(([workspace, systemSettings, hwStatus]) => {
      const genProc = hwStatus?.active_processes?.generative;
      if (
        genProc &&
        (genProc.alive === false || genProc.model_id === "Offloaded")
      ) {
        setModelName("No Model Loaded (Offloaded)");
        return;
      }
      if (genProc?.model_id) {
        setModelName(genProc.model_id);
        return;
      }
      if (!workspace) {
        setModelName(systemSettings?.LLMModel ?? "");
        return;
      }
      const model = workspace.chatModel ?? systemSettings?.LLMModel ?? "";
      setModelName(model);
    })
    .catch((e) => {
      console.error("fetchModelName failed:", e);
    });
}

export default function WorkspaceModelPicker({ workspaceSlug = null }) {
  const { t } = useTranslation();
  const { slug: urlSlug } = useParams();
  const slug = urlSlug ?? workspaceSlug;
  const { user } = useUser();
  const [showSelector, setShowSelector] = useState(false);
  const [modelName, setModelName] = useState("");
  const {
    isOpen: isSetupProviderOpen,
    openModal: openSetupProviderModal,
    closeModal: closeSetupProviderModal,
  } = useModal();
  const [config, setConfig] = useState({ settings: {}, provider: null });
  const [refreshKey, setRefreshKey] = useState(0);
  const [, setSidebarOpen] = useState(
    () => window.localStorage.getItem("anythingllm_sidebar_toggle") !== "closed"
  );

  useEffect(() => {
    const handleToggle = (e) => setSidebarOpen(e.detail.open);
    window.addEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
    return () => window.removeEventListener(SIDEBAR_TOGGLE_EVENT, handleToggle);
  }, []);

  // Fetch current model name for display with 3s polling loop
  useEffect(() => {
    fetchModelName(slug, setModelName);
    const timer = setInterval(() => fetchModelName(slug, setModelName), 3000);
    return () => clearInterval(timer);
  }, [slug]);

  // Close selector and refresh model name when model is saved or changed
  useEffect(() => {
    function handleSave() {
      setShowSelector(false);
      fetchModelName(slug, setModelName);
    }
    window.addEventListener(SAVE_LLM_SELECTOR_EVENT, handleSave);
    window.addEventListener("save_llm_selector", handleSave);
    return () => {
      window.removeEventListener(SAVE_LLM_SELECTOR_EVENT, handleSave);
      window.removeEventListener("save_llm_selector", handleSave);
    };
  }, [slug]);

  // Handle provider setup request
  useEffect(() => {
    function handleProviderSetup(e) {
      const { provider, settings } = e.detail;
      setConfig({ settings, provider });
      setTimeout(() => openSetupProviderModal(), 300);
    }
    window.addEventListener(PROVIDER_SETUP_EVENT, handleProviderSetup);
    return () =>
      window.removeEventListener(PROVIDER_SETUP_EVENT, handleProviderSetup);
  }, []);

  // This feature is disabled for multi-user instances where the user is not an admin
  if (!!user && user.role !== "admin") return null;
  if (!slug || isMobile) return null;

  return (
    <>
      {showSelector && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setShowSelector(false)}
        />
      )}
      <div className="hidden md:block relative z-30">
        <button
          type="button"
          onClick={() => setShowSelector(!showSelector)}
          className={`group border-none cursor-pointer px-2.5 py-1 flex items-center rounded-full transition-all ${
            showSelector
              ? "bg-zinc-700 light:bg-slate-200"
              : "hover:bg-zinc-700 light:hover:bg-slate-200"
          }`}
        >
          <span
            className={`text-xs ${
              showSelector
                ? "text-white light:text-slate-800"
                : "text-zinc-500 light:text-slate-500 group-hover:text-white light:group-hover:text-slate-800"
            }`}
          >
            {modelName || t("chat_window.select_model")}
          </span>
        </button>

        {showSelector && (
          <div className="absolute left-0 top-full mt-1 bg-zinc-800 light:bg-white border border-zinc-700 light:border-slate-300 rounded-xl shadow-lg w-[620px] overflow-hidden">
            <LLMSelectorModal
              key={refreshKey}
              workspaceSlug={slug}
              initialProvider={config.provider?.value}
            />
          </div>
        )}
      </div>

      <SetupProvider
        isOpen={isSetupProviderOpen}
        closeModal={closeSetupProviderModal}
        postSubmit={() => {
          closeSetupProviderModal();
          setRefreshKey((k) => k + 1);
        }}
        settings={config.settings}
        llmProvider={config.provider}
      />
    </>
  );
}
