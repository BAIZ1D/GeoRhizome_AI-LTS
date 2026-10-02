const pluralize = require("pluralize");
const {
  WorkspaceAgentInvocation,
} = require("../../models/workspaceAgentInvocation");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { Workspace } = require("../../models/workspace");

/**
 * In-memory cache for attachments associated with agent invocations.
 * Attachments are stored here when grepAgents creates an invocation,
 * then retrieved by AgentHandler when the websocket connects.
 * @type {Map<string, Array>}
 */
const invocationAttachmentsCache = new Map();

/**
 * Store attachments for an invocation UUID
 * @param {string} uuid - The invocation UUID
 * @param {Array} attachments - The attachments array
 */
function cacheInvocationAttachments(uuid, attachments = []) {
  if (attachments.length > 0) {
    invocationAttachmentsCache.set(uuid, attachments);
  }
}

/**
 * Retrieve and remove attachments for an invocation UUID
 * @param {string} uuid - The invocation UUID
 * @returns {Array} The attachments array (empty if none cached)
 */
function getAndClearInvocationAttachments(uuid) {
  const attachments = invocationAttachmentsCache.get(uuid) || [];
  invocationAttachmentsCache.delete(uuid);
  return attachments;
}

async function grepAgents({
  uuid,
  response,
  message,
  workspace,
  user = null,
  thread = null,
  attachments = [],
}) {
  let nativeToolingEnabled = false;

  // If the workspace is in automatic mode, check if the workspace supports native tooling
  // to determine if the agent flow should be used or not.
  if (workspace?.chatMode === "automatic")
    nativeToolingEnabled = await Workspace.supportsNativeToolCalling(workspace);

  const agentHandles = WorkspaceAgentInvocation.parseAgents(message);
  if (agentHandles.length > 0 || nativeToolingEnabled) {
    let promptText = message ? message.normalize("NFKC") : message;
    
    if (/^\s*[@＠]search/i.test(promptText)) {
      const searchRawQuery = promptText.replace(/^\s*[@＠]search\s*/i, "").trim();
      let contextualizedQuery = searchRawQuery;
      
      try {
        const { WorkspaceChats } = require("../../models/workspaceChats");
        const { safeJsonParse } = require("../http");
        const { getLLMProvider } = require("../helpers");
        
        const rawHistory = (await WorkspaceChats.where(
          {
            workspaceId: workspace.id,
            user_id: user?.id || null,
            thread_id: thread?.id || null,
            api_session_id: null,
            include: true,
          },
          15,
          { id: "desc" }
        )).reverse();
        
        if (rawHistory.length > 0 && searchRawQuery) {
          let processedHistory = rawHistory;
          const fs = require("fs");
          const path = require("path");
          const yaml = require("js-yaml");
          
          const cfgPath = path.resolve(__dirname, "../../../../config/retrieval.yaml");
          let retrievalCfg = { final_top_k: 8, reranker_server_url: "http://127.0.0.1:8001/rerank", reranker_enabled: false };
          if (fs.existsSync(cfgPath)) {
            const parsed = yaml.load(fs.readFileSync(cfgPath, "utf8")) || {};
            retrievalCfg = { ...retrievalCfg, ...parsed };
          }
          
          if (retrievalCfg.reranker_enabled) {
            const payload = {
              query: searchRawQuery,
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
          
          let contextStr = "";
          processedHistory.forEach(msg => {
            contextStr += `User: ${msg.prompt}\nAgent: ${safeJsonParse(msg.response)?.text || ""}\n\n`;
          });
          
          const systemPrompt = `You are an expert Search Query Reformulator engine used by advanced AI systems. Your sole task is to convert a user's conversational follow-up question into a standalone, highly optimized web search query.

CRITICAL RULES:
1. COREFERENCE RESOLUTION: You MUST resolve all pronouns (e.g., "he", "it", "this company", "they") and vague references by extracting the actual entity names from the provided conversation history.
2. SEARCH OPTIMIZATION: Strip away conversational filler (e.g., "Can you tell me...", "Who is..."). Use precise, high-value keywords optimized for a search engine.
3. LANGUAGE ALIGNMENT: The search query must be in the exact same language as the user's latest input.
4. STRICT OUTPUT: Output ONLY the raw search query. Do not include markdown, quotes, conversational text, or prefixes. If the query is already fully self-contained, output it optimized.`;

          const userPrompt = `CONVERSATION HISTORY:\n${contextStr || "No prior history."}\n\nLATEST USER INPUT:\n${searchRawQuery}\n\nREWRITTEN SEARCH QUERY:`;
          
          const LLMConnector = getLLMProvider({
            provider: workspace?.chatProvider,
            model: workspace?.chatModel,
          });
          
          const responseText = await LLMConnector.getChatCompletion(
            [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ],
            { temperature: 0.1 }
          );
          
          if (responseText && typeof responseText === "string") {
            contextualizedQuery = responseText.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
            contextualizedQuery = contextualizedQuery.replace(/^["']|["']$/g, '');
          }
        }
        
        // Log to file for debugging
        const fs = require("fs");
        fs.writeFileSync("/Users/baizid_alhamid/Downloads/GeoRhizome/debug_rewrite.txt", 
          `rawHistory length: ${rawHistory.length}\n` +
          `SearchRawQuery: ${searchRawQuery}\n` +
          `ContextStr: \n${typeof contextStr !== 'undefined' ? contextStr : 'undefined'}\n` +
          `Response: ${typeof responseText !== 'undefined' ? responseText : 'undefined'}\n` +
          `Final Query: ${contextualizedQuery}\n`
        );

      } catch (e) {
        console.error("Query rewrite failed, falling back", e);
        contextualizedQuery = searchRawQuery;
      }

      promptText = `@agent Search the internet for: ${contextualizedQuery}`;
    }
    const { invocation: newInvocation } = await WorkspaceAgentInvocation.new({
      prompt: promptText,
      workspace: workspace,
      user: user,
      thread: thread,
    });

    if (!newInvocation) {
      writeResponseChunk(response, {
        id: uuid,
        type: "statusResponse",
        textResponse: `${pluralize(
          "Agent",
          agentHandles.length
        )} ${agentHandles.join(
          ", "
        )} could not be called. Chat will be handled as default chat.`,
        sources: [],
        close: true,
        animate: false,
        error: null,
      });
      return;
    }

    // Cache attachments for the websocket handler to retrieve later
    cacheInvocationAttachments(newInvocation.uuid, attachments);

    writeResponseChunk(response, {
      id: uuid,
      type: "agentInitWebsocketConnection",
      textResponse: null,
      sources: [],
      close: false,
      error: null,
      websocketUUID: newInvocation.uuid,
    });

    // Close HTTP stream-able chunk response method because we will swap to agents now.
    writeResponseChunk(response, {
      id: uuid,
      type: "statusResponse",
      textResponse:
        "@agent: Swapping over to agent chat. Type /exit to exit agent execution loop early.",
      sources: [],
      close: true,
      error: null,
      animate: true,
    });
    return true;
  }

  return false;
}

module.exports = { grepAgents, getAndClearInvocationAttachments };
