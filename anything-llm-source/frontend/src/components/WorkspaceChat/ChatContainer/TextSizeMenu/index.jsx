import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  SlidersHorizontal,
  Cpu,
  HardDrive,
  DownloadSimple,
  Play,
  Stop,
  CheckCircle,
  MagnifyingGlass,
  X,
  Brain,
  Ruler,
  Target,
  Sparkle,
  Funnel,
  ArrowsOut,
  Lightning,
  Trash,
} from "@phosphor-icons/react";
import { isMobile } from "react-device-detect";

export default function TextSizeMenu() {
  const { t } = useTranslation();
  const [showWindow, setShowWindow] = useState(false);
  const [activeTab, setActiveTab] = useState("current"); // current, generative, embedding, reranker, hf_search
  const [hardware, setHardware] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [loading, setLoading] = useState(false);
  const [activeProcesses, setActiveProcesses] = useState({});

  // Floating window position state for dragging
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef({ startX: 0, startY: 0, initialX: 0, initialY: 0 });

  // Filter state
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedQuant, setSelectedQuant] = useState("");

  // HuggingFace direct search tab state
  const [searchRepo, setSearchRepo] = useState("swallow");
  const [hfFiles, setHfFiles] = useState([]);
  const [searchingHf, setSearchingHf] = useState(false);

  const [downloadMsg, setDownloadMsg] = useState("");

  const [downloadedFiles, setDownloadedFiles] = useState([]);
  const [onboardingStatus, setOnboardingStatus] = useState("");
  const [liveDownload, setLiveDownload] = useState(null);

  const windowRef = useRef(null);

  useEffect(() => {
    if (!showWindow) return;
    fetchData(false);
    fetchDownloadedFiles();
    const interval = setInterval(() => {
      fetchData(true);
      fetchDownloadedFiles();
    }, 2500);
    return () => clearInterval(interval);
  }, [showWindow, activeTab, searchQuery, selectedQuant]);

  // Auto-search HuggingFace when switching to hf_search tab
  useEffect(() => {
    if (activeTab === "hf_search" && !searchQuery) {
      setSearchQuery("Qwen3");
    }
  }, [activeTab]);

  const fetchDownloadedFiles = async () => {
    try {
      const res = await fetch("/api/hardware/downloaded");
      const data = await res.json();
      if (data.status === "ok") {
        setDownloadedFiles(data.files || []);
      }
    } catch (e) {
      console.error("Failed fetching downloaded files:", e);
    }
  };

  const fetchData = async (isSilent = false) => {
    if (!isSilent) setLoading(true);
    try {
      const catParam = ["generative", "embedding", "reranker"].includes(
        activeTab
      )
        ? activeTab
        : "generative";
      let url = `/api/hardware/catalog?category=${catParam}`;
      if (searchQuery) url += `&search=${encodeURIComponent(searchQuery)}`;
      if (selectedQuant) url += `&quant=${encodeURIComponent(selectedQuant)}`;

      const res = await fetch(url);
      const data = await res.json();
      if (data.status === "ok") {
        setHardware(data.system);
        setCatalog(data.catalog);
      }

      const stRes = await fetch("/api/hardware/status");
      const stData = await stRes.json();
      if (stData.status === "ok") {
        setActiveProcesses(stData.active_processes || {});
        setLiveDownload(stData.downloads || null);
      }
    } catch (e) {
      console.error("Failed fetching hardware catalog:", e);
    } finally {
      if (!isSilent) setLoading(false);
    }
  };

  const handleServe = async (category, modelId, quant = "Q4_K_M") => {
    setOnboardingStatus(`Initiating download & onboarding for ${modelId}...`);
    try {
      const res = await fetch("/api/hardware/serve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, model_id: modelId, quant }),
      });
      const text = await res.text();
      let data = {};
      try {
        data = JSON.parse(text);
      } catch {
        data = { status: "error", error: text };
      }
      if (data.status === "ok") {
        setOnboardingStatus(`Download & onboarding initiated for ${modelId}!`);
        setTimeout(() => setOnboardingStatus(""), 4000);
        fetchData(true);
        fetchDownloadedFiles();
        window.dispatchEvent(new CustomEvent("save_llm_selector"));
      } else {
        setOnboardingStatus("");
        alert(data.error || data.message || "Failed to serve model");
      }
    } catch (e) {
      console.error("Error serving model:", e);
      setOnboardingStatus("");
    }
  };

  const handleDeleteDownloadedFile = async (filename) => {
    if (
      !confirm(
        `Are you sure you want to permanently delete ${filename} from disk?`
      )
    )
      return;
    try {
      const res = await fetch(
        `/api/hardware/downloaded/${encodeURIComponent(filename)}`,
        {
          method: "DELETE",
        }
      );
      const data = await res.json();
      if (data.status === "ok") {
        fetchDownloadedFiles();
      } else {
        alert(data.error || "Failed to delete file");
      }
    } catch (e) {
      console.error("Error deleting file:", e);
    }
  };

  const handleOffload = async (category) => {
    try {
      const res = await fetch("/api/hardware/offload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });
      const data = await res.json();
      if (data.status === "ok") {
        fetchData();
        window.dispatchEvent(new CustomEvent("save_llm_selector"));
      }
    } catch (e) {
      console.error("Error offloading model:", e);
    }
  };

  const handleCancelDownload = async () => {
    try {
      await fetch("/api/hardware/cancel_download", { method: "POST" });
      setLiveDownload(null);
      fetchData(true);
    } catch (e) {
      console.error("Cancel download error:", e);
    }
  };

  const handlePurgeCache = async () => {
    if (
      !confirm(
        "Are you sure you want to purge all downloaded model binaries and local caches?"
      )
    )
      return;
    try {
      await fetch("/api/hardware/purge_cache", { method: "POST" });
      setDownloadedFiles([]);
      fetchDownloadedFiles();
      fetchData(true);
    } catch (e) {
      console.error("Purge cache error:", e);
    }
  };

  const handleSearchHf = async (overrideQuery = null) => {
    const q = overrideQuery !== null ? overrideQuery : searchRepo;
    if (!q) return;
    setSearchingHf(true);
    try {
      const res = await fetch(
        `/api/hardware/hf-files?repo_id=${encodeURIComponent(q)}`
      );
      const data = await res.json();
      if (data.status === "ok") {
        setHfFiles(data.files || []);
      } else {
        setHfFiles([]);
      }
    } catch (e) {
      console.error("HF search error:", e);
      setHfFiles([]);
    } finally {
      setSearchingHf(false);
    }
  };

  const handleDownload = async (repoId, filename) => {
    setDownloadMsg(`Downloading ${filename || repoId}...`);
    try {
      const res = await fetch("/api/hardware/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repo_id: repoId, filename }),
      });
      const data = await res.json();
      if (data.status === "started") {
        setDownloadMsg(`Download task initiated for ${repoId}`);
        setTimeout(() => setDownloadMsg(""), 3500);
      }
    } catch {
      setDownloadMsg("Download failed");
    }
  };

  // Dragging logic for floating window
  const handleMouseDown = (e) => {
    if (
      e.target.closest("button") ||
      e.target.closest("input") ||
      e.target.closest("select")
    )
      return;
    setIsDragging(true);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initialX: position.x,
      initialY: position.y,
    };
  };

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isDragging) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPosition({
        x: dragRef.current.initialX + dx,
        y: dragRef.current.initialY + dy,
      });
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging]);

  if (isMobile) return null;

  return (
    <div className="absolute top-3 md:top-5 z-30 right-4 md:right-6">
      {/* Top Right Header Button */}
      <button
        type="button"
        onClick={() => setShowWindow(!showWindow)}
        title={t("modelHub.titleFull", { defaultValue: "GeoRhizome Local Model Hub" })}
        className={`group border-none cursor-pointer flex items-center justify-center w-[36px] h-[36px] rounded-full transition-all duration-300 ${
          showWindow
            ? "bg-[#7bbd34]/20 border border-[#7bbd34]/40 shadow-lg shadow-[#7bbd34]/10"
            : "bg-white/5 hover:bg-white/10 border border-white/10 hover:border-[#7bbd34]/40"
        }`}
      >
        <SlidersHorizontal
          size={18}
          className={
            showWindow
              ? "text-[#7bbd34]"
              : "text-zinc-400 group-hover:text-[#7bbd34] transition-colors"
          }
        />
      </button>

      {/* Floating & Resizable Model Hub Window (No Backdrop, Non-Blocking) */}
      {showWindow && (
        <div
          ref={windowRef}
          style={{
            transform: `translate(${position.x}px, ${position.y}px)`,
          }}
          className="fixed top-16 right-6 z-50 w-[600px] min-w-[360px] max-w-[92vw] h-[660px] min-h-[380px] max-h-[85vh] bg-[#0a0b14]/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden flex flex-col resize backdrop-blur-2xl transition-shadow"
        >
          {/* Draggable Window Header */}
          <div
            onMouseDown={handleMouseDown}
            className="flex items-center justify-between px-5 py-3 border-b border-white/10 bg-[#050609]/70 cursor-move select-none"
          >
            <div className="flex items-center gap-x-2.5">
              <div className="p-2 rounded-lg bg-[#7bbd34]/10 border border-[#7bbd34]/20 text-[#7bbd34]">
                <Cpu size={18} weight="bold" />
              </div>
              <div>
                <h3 className="text-sm font-bold text-white tracking-tight flex items-center gap-x-2">
                  {t("modelHub.title", { defaultValue: "GeoRhizome Model Hub" })}
                  <span className="text-[9px] px-2 py-0.5 rounded-full bg-[#7bbd34]/10 text-[#7bbd34] border border-[#7bbd34]/30 font-mono tracking-wider">
                    {t("modelHub.hardwareAware", { defaultValue: "HARDWARE-AWARE" })}
                  </span>
                </h3>
                <p className="text-[11px] text-zinc-400">
                  {t("modelHub.subtitle", { defaultValue: "Model serving, 1-click downloads, and RAM/VRAM resource manager" })}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-x-2">
              <span className="text-zinc-500 hover:text-zinc-300 text-[10px] flex items-center gap-x-1 font-mono">
                <ArrowsOut size={12} /> {t("modelHub.dragResize", { defaultValue: "Drag / Resize" })}
              </span>
              <button
                onClick={() => setShowWindow(false)}
                className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-white/5 transition-colors border-none cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {/* Hardware System Status Banner */}
          {hardware && (
            <div className="px-5 py-2 bg-[#7bbd34]/5 border-b border-[#7bbd34]/10 flex items-center justify-between text-[11px] text-zinc-300 font-mono">
              <div className="flex items-center gap-x-4">
                <span className="flex items-center gap-x-1 text-[#7bbd34] font-semibold">
                  <HardDrive size={13} />{" "}
                  {hardware.gpu_name || hardware.cpu_name}
                </span>
                <span>
                  {t("modelHub.ram", { defaultValue: "RAM:" })}{" "}
                  <strong className="text-white">
                    {hardware.total_ram_gb} GB
                  </strong>
                </span>
                <span>
                  V{t("modelHub.ram", { defaultValue: "RAM:" })}{" "}
                  <strong className="text-white">
                    {hardware.gpu_vram_gb} GB
                  </strong>
                </span>
                <span>
                  {t("modelHub.backend", { defaultValue: "BACKEND:" })}{" "}
                  <strong className="text-[#7bbd34] uppercase">
                    {hardware.backend}
                  </strong>
                </span>
              </div>
              <div className="text-zinc-400 flex items-center gap-x-1">
                <Sparkle size={12} className="text-[#7bbd34]" /> {t("modelHub.topSpeed", { defaultValue: "TOP SPEED:" })}{" "}
                <strong className="text-white">~9.8 t/s</strong>
              </div>
            </div>
          )}

          {/* Tab Navigation */}
          <div className="flex flex-col border-b border-white/10 px-5 bg-[#050609]/30">
            <div className="flex overflow-x-auto">
              {[
                { id: "current", label: t("modelHub.tabs.current", { defaultValue: "Current Models" }), icon: Lightning },
                {
                  id: "downloaded",
                  label: `${t("modelHub.tabs.downloaded", { defaultValue: "Downloaded Models" })} (${downloadedFiles.length})`,
                  icon: HardDrive,
                },
                { id: "generative", label: t("modelHub.tabs.chat", { defaultValue: "Chat & Reasoning" }), icon: Brain },
                { id: "embedding", label: t("modelHub.tabs.embedder", { defaultValue: "Embedder" }), icon: Ruler },
                { id: "reranker", label: t("modelHub.tabs.reranker", { defaultValue: "Reranker" }), icon: Target },
                {
                  id: "hf_search",
                  label: t("modelHub.tabs.hfSearch", { defaultValue: "HuggingFace Search" }),
                  icon: MagnifyingGlass,
                },
              ].map((tab) => {
                const IconComponent = tab.icon;
                return (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setActiveTab(tab.id);
                      setSearchQuery("");
                    }}
                    className={`flex items-center gap-x-1.5 px-3 py-2.5 text-xs font-semibold border-b-2 transition-all cursor-pointer bg-transparent whitespace-nowrap ${
                      activeTab === tab.id
                        ? "border-[#7bbd34] text-[#7bbd34]"
                        : "border-transparent text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    <IconComponent size={14} />
                    {tab.label}
                  </button>
                );
              })}
            </div>

            {/* Dynamic Filter Tools */}
            {activeTab !== "hf_search" &&
              activeTab !== "current" &&
              activeTab !== "downloaded" && (
                <div className="flex items-center justify-between gap-x-2 pb-2.5 pt-1">
                  <div className="relative flex-1">
                    <input
                      type="text"
                      placeholder={t("modelHub.filter", { defaultValue: "Filter models..." })}
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg pl-8 pr-3 py-1 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#7bbd34]/50"
                    />
                    <MagnifyingGlass
                      size={12}
                      className="absolute left-2.5 top-2 text-zinc-400"
                    />
                  </div>

                  <div className="flex items-center gap-x-1">
                    <Funnel size={12} className="text-zinc-400" />
                    <select
                      value={selectedQuant}
                      onChange={(e) => setSelectedQuant(e.target.value)}
                      className="bg-[#050609] border border-white/10 rounded-lg px-2 py-1 text-[11px] text-zinc-300 focus:outline-none focus:border-[#7bbd34]/50 font-mono cursor-pointer"
                    >
                      <option value="">{t("modelHub.quants.all", { defaultValue: "All Quants" })}</option>
                      <option value="Q4_K_M">{t("modelHub.quants.optimal", { defaultValue: "Q4_K_M (Optimal Fit)" })}</option>
                      <option value="Q8_0">{t("modelHub.quants.high", { defaultValue: "Q8_0 (High Quality)" })}</option>
                      <option value="Q2_K">{t("modelHub.quants.light", { defaultValue: "Q2_K (Ultra Light)" })}</option>
                      <option value="Q5_K_M">Q5_K_M</option>
                      <option value="FP16">FP16</option>
                    </select>
                  </div>
                </div>
              )}
          </div>

          {/* Live HuggingFace Download Progress Banner */}
          {liveDownload?.is_downloading && (
            <div className="mx-5 mt-3 p-3.5 rounded-xl bg-[#7bbd34]/20 border border-[#7bbd34]/50 text-white text-xs font-mono space-y-1.5 shadow-lg shadow-[#7bbd34]/10">
              <div className="flex items-center justify-between text-[#7bbd34] font-bold">
                <span className="flex items-center gap-x-2">
                  <DownloadSimple
                    size={16}
                    className="animate-bounce text-[#7bbd34]"
                  />
                  DOWNLOADING GGUF MODEL FROM HUGGINGFACE
                </span>
                <div className="flex items-center gap-x-3">
                  <span>{liveDownload.downloaded_formatted} Received</span>
                  <button
                    onClick={handleCancelDownload}
                    className="px-2 py-0.5 bg-red-500/20 hover:bg-red-500/40 text-red-300 border border-red-500/40 text-[10px] rounded-lg transition-colors cursor-pointer border-none font-mono"
                  >
                    Cancel
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-zinc-300 leading-normal">
                {liveDownload.status_text}
              </p>
            </div>
          )}

          {/* Onboarding Live Banner Notification */}
          {onboardingStatus && !liveDownload?.is_downloading && (
            <div className="mx-5 mt-3 p-3 rounded-xl bg-[#7bbd34]/15 border border-[#7bbd34]/40 text-[#7bbd34] text-xs font-mono flex items-center justify-between animate-pulse">
              <span className="flex items-center gap-x-2">
                <Lightning size={16} className="animate-spin text-[#7bbd34]" />
                {onboardingStatus}
              </span>
            </div>
          )}

          {/* Window Content */}
          <div className="p-5 overflow-y-auto flex-1 space-y-3">
            {loading ? (
              <div className="py-12 text-center text-zinc-400 font-mono text-xs animate-pulse">
                Querying active models & memory fit...
              </div>
            ) : activeTab === "current" ? (
              /* Current Models Active Status Tab */
              <div className="space-y-4">
                <div className="p-3.5 rounded-xl bg-[#7bbd34]/10 border border-[#7bbd34]/30 text-xs font-mono text-zinc-300 flex items-center justify-between">
                  <span>
                    Active Model Serving Slots (1-Click Onboard & Offload)
                  </span>
                  <span className="text-[#7bbd34] font-bold">3 / 3 Active</span>
                </div>

                {/* 1. Generative / Reasoning Active Slot */}
                <div className="p-4 rounded-xl bg-white/[0.02] border border-white/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-x-2">
                      <Brain size={18} className="text-[#7bbd34]" />
                      <h4 className="text-xs font-bold text-white tracking-tight">
                        Chat & Reasoning Model
                      </h4>
                      <span className="text-[9px] px-2 py-0.5 rounded bg-[#7bbd34]/10 text-[#7bbd34] border border-[#7bbd34]/30 font-mono">
                        LOADED
                      </span>
                    </div>
                    {activeProcesses.generative?.model_id &&
                      activeProcesses.generative?.model_id !== "Offloaded" && (
                        <button
                          onClick={() => handleOffload("generative")}
                          className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-semibold text-xs rounded-xl flex items-center gap-x-1 transition-colors border-none cursor-pointer"
                        >
                          <Stop size={13} /> {t("modelHub.actions.offloadModel", { defaultValue: "Offload Model" })}
                        </button>
                      )}
                  </div>
                  <div className="text-xs text-white font-mono">
                    {activeProcesses.generative?.name ||
                      activeProcesses.generative?.model_id ||
                      "MCZK/Llama-3-Swallow-8B-Instruct-v0.1-GGUF"}
                  </div>
                  <div className="text-[10px] text-zinc-400 font-mono flex items-center gap-x-4">
                    <span>
                      Quantization:{" "}
                      <strong className="text-white">
                        {activeProcesses.generative?.quant || "Q4_K_M"}
                      </strong>
                    </span>
                    <span>
                      Status:{" "}
                      <strong className="text-[#7bbd34]">
                        Active in Memory
                      </strong>
                    </span>
                  </div>
                </div>

                {/* 2. Embedder Active Slot */}
                <div className="p-4 rounded-xl bg-white/[0.02] border border-white/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-x-2">
                      <Ruler size={18} className="text-[#7bbd34]" />
                      <h4 className="text-xs font-bold text-white tracking-tight">
                        Embedder Model (Dense Vector)
                      </h4>
                      <span className="text-[9px] px-2 py-0.5 rounded bg-[#7bbd34]/10 text-[#7bbd34] border border-[#7bbd34]/30 font-mono">
                        PORT 8000
                      </span>
                    </div>
                    {activeProcesses.embedding?.model_id &&
                      activeProcesses.embedding?.model_id !== "Offloaded" && (
                        <button
                          onClick={() => handleOffload("embedding")}
                          className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-semibold text-xs rounded-xl flex items-center gap-x-1 transition-colors border-none cursor-pointer"
                        >
                          <Stop size={13} /> {t("modelHub.actions.offloadEmbedder", { defaultValue: "Offload Embedder" })}
                        </button>
                      )}
                  </div>
                  <div className="text-xs text-white font-mono">
                    {activeProcesses.embedding?.name ||
                      "BAAI BGE-M3 (Multilingual & Japanese 1024-dim)"}
                  </div>
                  <div className="text-[10px] text-zinc-400 font-mono flex items-center gap-x-4">
                    <span>
                      Port: <strong className="text-white">8000</strong>
                    </span>
                    <span>
                      Status:{" "}
                      <strong className="text-[#7bbd34]">
                        Active Local Fast-BGE
                      </strong>
                    </span>
                  </div>
                </div>

                {/* 3. Reranker Active Slot */}
                <div className="p-4 rounded-xl bg-white/[0.02] border border-white/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-x-2">
                      <Target size={18} className="text-[#7bbd34]" />
                      <h4 className="text-xs font-bold text-white tracking-tight">
                        Reranker Model (Cross-Encoder)
                      </h4>
                      <span className="text-[9px] px-2 py-0.5 rounded bg-[#7bbd34]/10 text-[#7bbd34] border border-[#7bbd34]/30 font-mono">
                        PORT 8001
                      </span>
                    </div>
                    {activeProcesses.reranker?.model_id &&
                      activeProcesses.reranker?.model_id !== "Offloaded" && (
                        <button
                          onClick={() => handleOffload("reranker")}
                          className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-semibold text-xs rounded-xl flex items-center gap-x-1 transition-colors border-none cursor-pointer"
                        >
                          <Stop size={13} /> {t("modelHub.actions.offloadReranker", { defaultValue: "Offload Reranker" })}
                        </button>
                      )}
                  </div>
                  <div className="text-xs text-white font-mono">
                    {activeProcesses.reranker?.name ||
                      "BAAI BGE Reranker Base (Lightweight CPU)"}
                  </div>
                  <div className="text-[10px] text-zinc-400 font-mono flex items-center gap-x-4">
                    <span>
                      Port: <strong className="text-white">8001</strong>
                    </span>
                    <span>
                      Status:{" "}
                      <strong className="text-[#7bbd34]">
                        Active Hardware Reranker
                      </strong>
                    </span>
                  </div>
                </div>
              </div>
            ) : activeTab === "downloaded" ? (
              /* Downloaded Models Tab */
              <div className="space-y-3">
                <div className="p-3.5 rounded-xl bg-white/[0.02] border border-white/10 text-xs font-mono text-zinc-300 flex items-center justify-between">
                  <span>
                    Downloaded GGUF Models on Local Storage (`models/`)
                  </span>
                  <div className="flex items-center gap-x-3">
                    <span className="text-[#7bbd34] font-bold">
                      {downloadedFiles.length} Files
                    </span>
                    <button
                      onClick={handlePurgeCache}
                      className="px-2.5 py-1 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 text-[11px] font-semibold rounded-lg flex items-center gap-x-1 transition-colors border-none cursor-pointer"
                    >
                      <Trash size={12} /> {t("modelHub.actions.purge", { defaultValue: "Purge All Caches" })}
                    </button>
                  </div>
                </div>

                {downloadedFiles.length === 0 ? (
                  <div className="py-12 text-center text-zinc-400 font-mono text-xs">
                    No GGUF models stored in `models/` directory yet. Click
                    1-Click Onboard on any model to download it!
                  </div>
                ) : (
                  downloadedFiles.map((file, idx) => (
                    <div
                      key={idx}
                      className="p-3.5 rounded-xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-all flex items-center justify-between"
                    >
                      <div className="space-y-1 max-w-[65%]">
                        <h4 className="text-xs font-bold text-white font-mono tracking-tight break-all">
                          {file.filename}
                        </h4>
                        <div className="text-[11px] text-zinc-400 font-mono flex items-center gap-x-3">
                          <span>
                            Size:{" "}
                            <strong className="text-[#7bbd34]">
                              {file.size_formatted}
                            </strong>
                          </span>
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#7bbd34]/10 text-[#7bbd34] border border-[#7bbd34]/30 font-mono">
                            DOWNLOADED
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-x-2">
                        <button
                          onClick={() =>
                            handleServe("generative", file.filename)
                          }
                          className="px-3 py-1.5 bg-[#7bbd34] hover:bg-[#90d441] text-[#050609] font-bold text-xs rounded-xl flex items-center gap-x-1 transition-colors border-none cursor-pointer"
                        >
                          <Play size={13} /> {t("modelHub.actions.onboardServe", { defaultValue: "Onboard & Serve" })}
                        </button>
                        <button
                          onClick={() =>
                            handleDeleteDownloadedFile(file.filename)
                          }
                          className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-semibold text-xs rounded-xl flex items-center gap-x-1 transition-colors border-none cursor-pointer"
                        >
                          <Trash size={13} /> Delete
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : activeTab === "hf_search" ? (
              /* HuggingFace Direct Search Tab */
              <div className="space-y-3">
                <div className="flex gap-x-2">
                  <input
                    type="text"
                    placeholder="Type model keyword (e.g. swallow, qwen) or exact Repo ID (e.g. MCZK/Llama-3-Swallow-8B-Instruct-v0.1-GGUF)"
                    value={searchRepo}
                    onChange={(e) => setSearchRepo(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSearchHf();
                    }}
                    className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-[#7bbd34]/50 font-mono"
                  />
                  <button
                    onClick={() => handleSearchHf()}
                    disabled={searchingHf}
                    className="px-4 py-2 bg-[#7bbd34] hover:bg-[#90d441] text-[#050609] font-bold text-xs rounded-xl flex items-center gap-x-1.5 transition-colors cursor-pointer border-none whitespace-nowrap"
                  >
                    <MagnifyingGlass size={14} />{" "}
                    {searchingHf ? "Searching..." : "Search HuggingFace"}
                  </button>
                </div>

                {downloadMsg && (
                  <div className="p-2.5 rounded-xl bg-[#7bbd34]/10 border border-[#7bbd34]/30 text-[#7bbd34] text-xs font-mono">
                    {downloadMsg}
                  </div>
                )}

                {searchingHf ? (
                  <div className="py-8 text-center text-zinc-400 font-mono text-xs animate-pulse">
                    Searching Hugging Face models & GGUF files...
                  </div>
                ) : (
                  <div className="space-y-2">
                    {hfFiles.length === 0 ? (
                      <div className="py-8 text-center text-zinc-400 text-xs font-mono">
                        No Hugging Face models found for "{searchRepo}". Try
                        searching "swallow" or "qwen".
                      </div>
                    ) : (
                      hfFiles.map((file, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-3 rounded-xl bg-white/[0.02] border border-white/5 hover:border-white/10 transition-all"
                        >
                          <div>
                            <div className="text-xs font-semibold text-white font-mono">
                              {file.filename || file.repo_id}
                            </div>
                            <div className="text-[11px] text-zinc-400 font-mono">
                              Repo:{" "}
                              <strong className="text-zinc-300">
                                {file.repo_id || searchRepo}
                              </strong>{" "}
                              | Quantization:{" "}
                              <strong className="text-white">
                                {file.quant}
                              </strong>{" "}
                              | Est Speed:{" "}
                              <strong className="text-[#7bbd34]">
                                {file.est_tps} t/s
                              </strong>
                            </div>
                          </div>
                          <button
                            onClick={() =>
                              handleServe(
                                "generative",
                                file.repo_id || searchRepo,
                                file.quant || "Q4_K_M"
                              )
                            }
                            className="px-3 py-1.5 bg-white/10 hover:bg-[#7bbd34] hover:text-[#050609] text-white text-xs font-semibold rounded-lg flex items-center gap-x-1 transition-colors border-none cursor-pointer whitespace-nowrap"
                          >
                            <DownloadSimple size={13} /> {t("modelHub.actions.downloadOnboard", { defaultValue: "Download & Onboard" })}
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ) : (
              /* Dynamic Ranked Models (Generative, Embedding, Reranker) */
              <div className="grid grid-cols-1 gap-3">
                {catalog &&
                  catalog[activeTab]?.map((item, idx) => {
                    const isActive =
                      activeProcesses[activeTab]?.model_id === item.repo_id ||
                      activeProcesses[activeTab]?.alive;

                    // Check if GGUF binary is downloaded on disk
                    const matchingFile = downloadedFiles.find((df) => {
                      if (item.files) {
                        return Object.values(item.files).some(
                          (fn) => df.filename === fn
                        );
                      }
                      return df.filename.includes(
                        item.repo_id.split("/").pop()
                      );
                    });
                    const isDownloaded = !!matchingFile;

                    return (
                      <div
                        key={idx}
                        className={`p-3.5 rounded-xl border transition-all flex items-start justify-between ${
                          isActive
                            ? "bg-[#7bbd34]/10 border-[#7bbd34]/40 shadow-lg shadow-[#7bbd34]/5"
                            : "bg-white/[0.02] border-white/5 hover:border-white/10"
                        }`}
                      >
                        <div className="space-y-1 max-w-[65%]">
                          <div className="flex items-center gap-x-2 flex-wrap gap-y-1">
                            <h4 className="text-xs font-bold text-white tracking-tight">
                              {item.name}
                            </h4>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-zinc-400 font-mono border border-white/5">
                              {item.repo_id}
                            </span>
                            <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#7bbd34]/10 text-[#7bbd34] border border-[#7bbd34]/30 flex items-center gap-x-1 font-mono">
                              <CheckCircle size={10} />{" "}
                              {item.fit_badge.toUpperCase()}
                            </span>
                            {isDownloaded && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#7bbd34]/20 text-[#7bbd34] border border-[#7bbd34]/50 flex items-center gap-x-1 font-mono font-bold">
                                DOWNLOADED ({matchingFile.size_formatted})
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-zinc-400 leading-normal">
                            {item.description}
                          </p>
                          <div className="text-[10px] text-zinc-500 font-mono flex items-center gap-x-3">
                            <span>
                              Quant:{" "}
                              <strong className="text-zinc-300 uppercase">
                                {item.quant}
                              </strong>
                            </span>
                            <span>
                              V{t("modelHub.ram", { defaultValue: "RAM:" })}{" "}
                              <strong className="text-white">
                                {item.required_gb} GB
                              </strong>
                            </span>
                            <span>
                              Speed:{" "}
                              <strong className="text-[#7bbd34]">
                                ~{item.est_tps} t/s
                              </strong>
                            </span>
                          </div>
                        </div>

                        {/* Onload / Offload / Delete Action Buttons */}
                        <div className="flex items-center gap-x-2">
                          {isDownloaded && !isActive && (
                            <button
                              onClick={() =>
                                handleDeleteDownloadedFile(
                                  matchingFile.filename
                                )
                              }
                              title="Delete downloaded GGUF file from disk"
                              className="px-2.5 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-semibold text-xs rounded-xl flex items-center gap-x-1 transition-colors border-none cursor-pointer"
                            >
                              <Trash size={13} /> Delete
                            </button>
                          )}
                          {isActive ? (
                            <button
                              onClick={() => handleOffload(activeTab)}
                              className="px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/30 font-semibold text-xs rounded-xl flex items-center gap-x-1 transition-colors border-none cursor-pointer"
                            >
                              <Stop size={13} /> Offload
                            </button>
                          ) : (
                            <button
                              onClick={() =>
                                handleServe(activeTab, item.repo_id, item.quant)
                              }
                              className="px-3 py-1.5 bg-[#7bbd34] hover:bg-[#90d441] text-[#050609] font-bold text-xs rounded-xl flex items-center gap-x-1 transition-colors border-none cursor-pointer shadow-md shadow-[#7bbd34]/10"
                            >
                              <Play size={13} />{" "}
                              {isDownloaded
                                ? t("modelHub.actions.onboardServe", { defaultValue: "Onboard & Serve" })
                                : t("modelHub.actions.downloadOnboard", { defaultValue: "Download & Onboard" })}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
              </div>
            )}
          </div>

          {/* Window Footer */}
          <div className="px-5 py-2.5 border-t border-white/10 bg-[#050609]/60 flex items-center justify-between text-[11px] text-zinc-400 font-mono">
            <span>{t("modelHub.footer", { defaultValue: "GeoRhizome AI Engine • Hardware-Aware" })}</span>
            <button
              onClick={() => setShowWindow(false)}
              className="px-3 py-1 bg-white/10 hover:bg-white/20 text-white font-semibold text-xs rounded-lg transition-colors border-none cursor-pointer"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
