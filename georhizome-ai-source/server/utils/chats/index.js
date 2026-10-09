const { v4: uuidv4 } = require("uuid");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { resetMemory } = require("./commands/reset");
const { convertToPromptHistory } = require("../helpers/chat/responses");
const { SlashCommandPresets } = require("../../models/slashCommandsPresets");
const { SystemPromptVariables } = require("../../models/systemPromptVariables");

const VALID_COMMANDS = {
  "/reset": resetMemory,
};

async function grepCommand(message, user = null) {
  const userPresets = await SlashCommandPresets.getUserPresets(user?.id);
  const availableCommands = Object.keys(VALID_COMMANDS);

  // Check if the message starts with any built-in command
  for (let i = 0; i < availableCommands.length; i++) {
    const cmd = availableCommands[i];
    const re = new RegExp(`^(${cmd})`, "i");
    if (re.test(message)) {
      return cmd;
    }
  }

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of userPresets) {
    const regex = new RegExp(
      `(?:\\b\\s|^)(${preset.command})(?:\\b\\s|$)`,
      "g"
    );
    updatedMessage = updatedMessage.replace(regex, preset.prompt);
  }

  return updatedMessage;
}

/**
 * @description This function will do recursive replacement of all slash commands with their corresponding prompts.
 * @notice This function is used for API calls and is not user-scoped. THIS FUNCTION DOES NOT SUPPORT PRESET COMMANDS.
 * @returns {Promise<string>}
 */
async function grepAllSlashCommands(message) {
  const allPresets = await SlashCommandPresets.where({});

  // Replace all preset commands with their corresponding prompts
  // Allows multiple commands in one message
  let updatedMessage = message;
  for (const preset of allPresets) {
    const regex = new RegExp(
      `(?:\\b\\s|^)(${preset.command})(?:\\b\\s|$)`,
      "g"
    );
    updatedMessage = updatedMessage.replace(regex, preset.prompt);
  }

  return updatedMessage;
}

async function recentChatHistory({
  user = null,
  workspace,
  thread = null,
  messageLimit = 20,
  apiSessionId = null,
  currentPrompt = null,
}) {
  const rawHistory = (
    await WorkspaceChats.where(
      {
        workspaceId: workspace.id,
        user_id: user?.id || null,
        thread_id: thread?.id || null,
        api_session_id: apiSessionId || null,
        include: true,
      },
      messageLimit,
      { id: "desc" }
    )
  ).reverse();

  let processedHistory = rawHistory;
  try {
    const fs = require("fs");
    const path = require("path");
    const yaml = require("js-yaml");
    const { safeJsonParse } = require("../http");
    const containerPath = "/config/app_config.json";
    const localPath = path.resolve(__dirname, "../../../../../config/app_config.json");
    let retrievalCfg = { final_top_k: 8, reranker_server_url: "http://127.0.0.1:8001/rerank", reranker_enabled: false };
    
    let appConfig = null;
    if (fs.existsSync(containerPath)) {
      appConfig = JSON.parse(fs.readFileSync(containerPath, "utf8"));
    } else if (fs.existsSync(localPath)) {
      appConfig = JSON.parse(fs.readFileSync(localPath, "utf8"));
    }

    if (appConfig && appConfig.reranker) {
      retrievalCfg.reranker_enabled = appConfig.reranker.enabled !== false;
      retrievalCfg.reranker_server_url = appConfig.reranker.base_url || retrievalCfg.reranker_server_url;
    }
    if (retrievalCfg.reranker_enabled && rawHistory.length > 0 && currentPrompt) {
      const payload = {
        query: currentPrompt,
        documents: rawHistory.map((r, idx) => ({
          text: `User: ${r.prompt}\nAgent: ${safeJsonParse(r.response)?.text || ""}`,
          metadata: { original_index: idx },
        })),
      };
      const res = await fetch(retrievalCfg.reranker_server_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        const data = await res.json();
        if (data?.results && Array.isArray(data.results)) {
          const topResults = data.results.slice(0, retrievalCfg.final_top_k || 8);
          topResults.sort((a, b) => a.metadata.original_index - b.metadata.original_index);
          processedHistory = topResults.map(r => rawHistory[r.metadata.original_index]);
        }
      }
    }
  } catch (e) {
    console.error("Error in dual-stage reranking for recentChatHistory", e.message);
  }

  return { rawHistory: processedHistory, chatHistory: convertToPromptHistory(processedHistory) };
}

/**
 * Returns the base prompt for the chat. This method will also do variable
 * substitution on the prompt if there are any defined variables in the prompt.
 * @param {Object|null} workspace - the workspace object
 * @param {Object|null} user - the user object
 * @returns {Promise<string>} - the base prompt
 */
async function chatPrompt(workspace, user = null, answerLength = "default") {
  const { SystemSettings } = require("../../models/systemSettings");
  let basePrompt =
    workspace?.openAiPrompt ?? SystemSettings.saneDefaultSystemPrompt;
    
  if (answerLength === "concise") {
    basePrompt += "\n\nSystem Directive: Keep your answer very concise and short.";
  } else if (answerLength === "detailed") {
    basePrompt += "\n\nSystem Directive: Provide a highly detailed and comprehensive answer.";
  }


  // System-Wide Strict Factuality & Citation Constraints
  basePrompt += "\n\nSystem Directive:\n1. CRITICAL: You MUST answer in the EXACT SAME LANGUAGE as the user's prompt. If they ask in Japanese, answer in Japanese. If English, answer in English.\n2. Answer using only wording from the provided text. If the text doesn't state it, say so. Don't add information.\n3. For definition-type questions, quote the relevant sentence first and then summarize.";

  return await SystemPromptVariables.expandSystemPromptVariables(
    basePrompt,
    user?.id,
    workspace?.id
  );
}

// We use this util function to deduplicate sources from similarity searching
// if the document is already pinned.
// Eg: You pin a csv, if we RAG + full-text that you will get the same data
// points both in the full-text and possibly from RAG - result in bad results
// even if the LLM was not even going to hallucinate.
function sourceIdentifier(sourceDocument) {
  if (!sourceDocument?.title || !sourceDocument?.published) return uuidv4();
  return `title:${sourceDocument.title}-timestamp:${sourceDocument.published}`;
}

module.exports = {
  sourceIdentifier,
  recentChatHistory,
  chatPrompt,
  grepCommand,
  grepAllSlashCommands,
  VALID_COMMANDS,
};
