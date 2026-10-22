/**
 * Pinned sampling for the local (generic-openai / llama_cpp.server) LLM.
 *
 * Policy (08.1 A-01, user confirmed): ALWAYS send temperature/top_p/top_k/min_p
 * from config/app_config.json `llm.sampling` on every local chat request.
 * 0.6B thinking models loop under greedy decoding, so temperature <= 0 is never
 * allowed. Consequence: the workspace `openAiTemp` setting is inert for the
 * local provider; it is ignored and replaced by the pinned value.
 *
 * llama_cpp.server (llama-cpp-python 0.3.19) has no sampling CLI flags, so the
 * launcher cannot set these; enforcement happens per request here instead.
 * repeat_penalty is intentionally left at the llama default.
 */
const fs = require("fs");
const path = require("path");

const FALLBACK = { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 };

function resolveConfigPath() {
  const containerPath = "/config/app_config.json";
  if (fs.existsSync(containerPath)) return containerPath;
  return path.resolve(__dirname, "../../../../config/app_config.json");
}

function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * @param {string} [configPath] optional app_config.json path (tests)
 * @returns {{temperature:number, top_p:number, top_k?:number, min_p?:number}}
 */
function loadLlmSampling(configPath) {
  let cfg = {};
  try {
    const p = configPath || resolveConfigPath();
    if (fs.existsSync(p))
      cfg = JSON.parse(fs.readFileSync(p, "utf-8"))?.llm?.sampling || {};
  } catch {
    cfg = {};
  }
  let temperature = num(cfg.temperature, FALLBACK.temperature);
  if (temperature <= 0) temperature = FALLBACK.temperature; // never greedy
  const out = {
    temperature,
    top_p: num(cfg.top_p, FALLBACK.top_p),
  };
  if (cfg.send_llamacpp_fields !== false) {
    out.top_k = num(cfg.top_k, FALLBACK.top_k);
    out.min_p = num(cfg.min_p, FALLBACK.min_p);
  }
  return out;
}

module.exports = { loadLlmSampling };
