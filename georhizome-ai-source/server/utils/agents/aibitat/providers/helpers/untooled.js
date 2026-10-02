const { safeJsonParse } = require("../../../../http");
const { Deduplicator } = require("../../utils/dedupe");
const { v4 } = require("uuid");

// Useful inheritance class for a model which supports OpenAi schema for API requests
// but does not have tool-calling or JSON output support.
class UnTooled {
  constructor() {
    this.deduplicator = new Deduplicator();
  }

  cleanMsgs(messages) {
    const modifiedMessages = [];
    messages.forEach((msg) => {
      if (msg.role === "function") {
        const prevMsg = modifiedMessages[modifiedMessages.length - 1].content;
        modifiedMessages[modifiedMessages.length - 1].content =
          `${prevMsg}\n${msg.content}`;
        return;
      }
      // Format messages with attachments for multimodal support
      // Uses formatMessageWithAttachments inherited from Provider base class
      modifiedMessages.push(this.formatMessageWithAttachments(msg));
    });
    return modifiedMessages;
  }

  showcaseFunctions(functions = []) {
    let output = "";
    functions.forEach((def) => {
      let shotExample = `-----------
Function name: ${def.name}
Function Description: ${def.description}
Function parameters in JSON format:
${JSON.stringify(def.parameters.properties, null, 4)}\n`;

      if (Array.isArray(def.examples)) {
        def.examples.forEach(({ prompt, call }) => {
          shotExample += `Query: "${prompt}"\nJSON: ${JSON.stringify({
            name: def.name,
            arguments: safeJsonParse(call, {}),
          })}\n`;
        });
      }
      output += `${shotExample}-----------\n`;
    });
    return output;
  }

  /**
   * Check if a function call is an MCP tool.
   * We do this because some MCP tools dont return values and will cause infinite loops in calling for Untooled to call the same function over and over again.
   * Any MCP tool is automatically marked with a cooldown to prevent infinite loops of the same function over and over again.
   *
   * This can lead to unexpected behavior if you want a model using Untooled to call a repeat action multiple times.
   * eg: Create 3 Jira tickets about x, y, and z. -> will skip y and z if you don't disable the cooldown.
   *
   * You can disable this check by setting the `MCP_NO_COOLDOWN` flag to any value in the ENV.
   *
   * @param {{name: string, arguments: Object}} functionCall - The function call to check.
   * @param {Object[]} functions - The list of functions definitions to check against.
   * @return {boolean} - True if the function call is an MCP tool, false otherwise.
   */
  isMCPTool(functionCall = {}, functions = []) {
    if (process.env.MCP_NO_COOLDOWN) return false;

    const foundFunc = functions.find(
      (def) => def?.name?.toLowerCase() === functionCall.name?.toLowerCase()
    );
    if (!foundFunc) return false;
    return foundFunc?.isMCPTool || false;
  }

  /**
   * Validate a function call against a list of functions.
   * @param {{name: string, arguments: Object}} functionCall - The function call to validate.
   * @param {Object[]} functions - The list of functions definitions to validate against.
   * @return {{valid: boolean, reason: string|null}} - The validation result.
   */
  validFuncCall(functionCall = {}, functions = []) {
    if (
      !functionCall ||
      !functionCall?.hasOwnProperty("name") ||
      !functionCall?.hasOwnProperty("arguments")
    ) {
      return {
        valid: false,
        reason: "Missing name or arguments in function call.",
      };
    }

    const foundFunc = functions.find((def) => def.name === functionCall.name);
    if (!foundFunc)
      return { valid: false, reason: "Function name does not exist." };

    const schemaProps = Object.keys(foundFunc?.parameters?.properties || {});
    const requiredProps = foundFunc?.parameters?.required || [];
    const providedProps = Object.keys(functionCall.arguments);

    for (const requiredProp of requiredProps) {
      if (!providedProps.includes(requiredProp)) {
        return {
          valid: false,
          reason: `Missing required argument: ${requiredProp}`,
        };
      }
    }

    // Ensure all provided arguments are valid for the schema
    // This is to prevent the model from hallucinating or providing invalid additional arguments.
    for (const providedProp of providedProps) {
      if (!schemaProps.includes(providedProp)) {
        return {
          valid: false,
          reason: `Unknown argument: ${providedProp} provided but not in schema.`,
        };
      }
    }

    return { valid: true, reason: null };
  }

  buildToolCallMessages(messages = [], functions = []) {
    const systemMessage = messages.find((msg) => msg.role === "system");
    const baseSystemPrompt = systemMessage ? systemMessage.content : "";

    let cleanSystemPrompt = baseSystemPrompt;
    const searchIdx = baseSystemPrompt.indexOf("5. Internet Search");
    if (searchIdx !== -1) {
      cleanSystemPrompt = baseSystemPrompt.slice(searchIdx);
    }

    // Clean messages to merge function/tool responses into preceding user messages,
    // ensuring the model sees actual tool execution results during the tool selection loop.
    const cleanedMessages = this.cleanMsgs(messages);
    const history = cleanedMessages.filter((msg) =>
      ["user", "assistant"].includes(msg.role)
    );

    // Format history messages with attachments for multimodal support
    const formattedHistory = history.map((msg) =>
      this.formatMessageWithAttachments(msg)
    );

    return [
      {
        content: `${cleanSystemPrompt ? `${cleanSystemPrompt}\n\n` : ""}You are a program which picks the most optimal function and parameters to call.
       DO NOT HAVE TO PICK A FUNCTION IF IT WILL NOT HELP ANSWER OR FULFILL THE USER'S QUERY.
       When a function is selection, respond in JSON with no additional text.
       When there is no relevant function to call - return with a regular chat text response.
       Your task is to pick a **single** function that we will use to call, if any seem useful or relevant for the user query.

       All JSON responses should have two keys.
       'name': this is the name of the function name to call. eg: 'web-scraper', 'rag-memory', etc..
       'arguments': this is an object with the function properties to invoke the function.
       DO NOT INCLUDE ANY OTHER KEYS IN JSON RESPONSES.

       Here are the available tools you can use an examples of a query and response so you can understand how each one works.
       ${this.showcaseFunctions(functions)}

       Now pick a function if there is an appropriate one to use given the last user message and the given conversation so far.`,
        role: "system",
      },
      ...formattedHistory,
    ];
  }

  async functionCall(messages, functions, chatCb = null) {
    const history = [...messages].filter((msg) =>
      ["user", "assistant"].includes(msg.role)
    );
    if (history[history.length - 1].role !== "user") return null;

    // Fast-path: Check if user explicitly asked for internet search (e.g. via @search or explicit Search the internet)
    const lastUserMsg = history[history.length - 1];
    const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
    const webBrowsingFunc = functions.find((f) => f.name === "web-browsing");
    if (webBrowsingFunc && /^(?:@agent\s+)?search\s+the\s+internet\s+for\s+(.+)/i.test(userText.trim())) {
      const match = userText.trim().match(/^(?:@agent\s+)?search\s+the\s+internet\s+for\s+(.+)/i);
      const query = match[1]?.trim();
      if (query && !this.deduplicator.isDuplicate("web-browsing", { query }).isDuplicate) {
        this.providerLog(`Direct routing web search query: "${query}"`);
        return { toolCall: { name: "web-browsing", arguments: { query } }, text: null };
      }
    }

    const historyMessages = this.buildToolCallMessages(messages, functions);
    const response = await chatCb({ messages: historyMessages });

    const cleanText = typeof response === "string" ? response.replace(/<think>[\s\S]*?<\/think>/gi, "").trim() : response;
    const call = safeJsonParse(cleanText, null);
    if (call === null) return { toolCall: null, text: response }; // failed to parse, so must be text.

    const { valid, reason } = this.validFuncCall(call, functions);
    if (!valid) {
      this.providerLog(`Invalid function tool call: ${reason}.`);
      return { toolCall: null, text: null };
    }

    const skipDedupeTools = ["web-browsing", "web-scraping", "rag-memory"];
    const { isDuplicate, reason: duplicateReason } = skipDedupeTools.includes(call.name)
      ? { isDuplicate: false, reason: "" }
      : this.deduplicator.isDuplicate(call.name, call.arguments);
    if (isDuplicate) {
      this.providerLog(
        `Cannot call ${call.name} again because ${duplicateReason}.`
      );
      return { toolCall: null, text: null };
    }

    return { toolCall: call, text: null };
  }

  async streamingFunctionCall(
    messages,
    functions,
    chatCb = null,
    eventHandler = null
  ) {
    const history = [...messages].filter((msg) =>
      ["user", "assistant"].includes(msg.role)
    );
    if (history[history.length - 1].role !== "user") return null;

    const msgUUID = v4();

    // Fast-path: Check if user explicitly asked for internet search (e.g. via @search or explicit Search the internet)
    const lastUserMsg = history[history.length - 1];
    const userText = typeof lastUserMsg?.content === "string" ? lastUserMsg.content : "";
    const webBrowsingFunc = functions.find((f) => f.name === "web-browsing");
    if (webBrowsingFunc && /^(?:@agent\s+)?search\s+the\s+internet\s+for\s+(.+)/i.test(userText.trim())) {
      const match = userText.trim().match(/^(?:@agent\s+)?search\s+the\s+internet\s+for\s+(.+)/i);
      const query = match[1]?.trim();
      if (query && !this.deduplicator.isDuplicate("web-browsing", { query }).isDuplicate) {
        this.providerLog(`Direct routing web search query: "${query}"`);
        eventHandler?.("reportStreamEvent", {
          uuid: msgUUID,
          type: "toolCallInvocation",
          content: `Parsed Tool Call: web-browsing(${JSON.stringify({ query })})`,
        });
        return { toolCall: { name: "web-browsing", arguments: { query } }, text: null, uuid: msgUUID };
      }
    }

    let textResponse = "";
    const historyMessages = this.buildToolCallMessages(messages, functions);
    const stream = await chatCb({ messages: historyMessages });

    eventHandler?.("reportStreamEvent", {
      type: "statusResponse",
      uuid: msgUUID,
      content: "Agent is thinking...",
    });

    for await (const chunk of stream) {
      if (!chunk?.choices?.[0]) continue; // Skip if no choices
      const choice = chunk.choices[0];

      if (choice.delta?.content) {
        textResponse += choice.delta.content;
      }
    }

    // Robustly extract JSON object if model outputs reasoning or markdown codeblocks
    let cleanText = textResponse.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, "").trim();
    cleanText = cleanText.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
    let call = safeJsonParse(cleanText, null);
    if (!call && (textResponse.includes("{") || cleanText.includes("{"))) {
      call = safeJsonParse(textResponse, null);
    }
    if (call === null)
      return { toolCall: null, text: textResponse, uuid: msgUUID }; // failed to parse, so must be regular text response.

    const { valid, reason } = this.validFuncCall(call, functions);
    if (!valid) {
      this.providerLog(`Invalid function tool call: ${reason}.`);
      eventHandler?.("reportStreamEvent", {
        type: "removeStatusResponse",
        uuid: msgUUID,
        content:
          "The model attempted to make an invalid function call - it was ignored.",
      });
      return { toolCall: null, text: textResponse, uuid: msgUUID };
    }

    const skipDedupeTools = ["web-browsing", "web-scraping", "rag-memory"];
    const { isDuplicate, reason: duplicateReason } = skipDedupeTools.includes(call.name)
      ? { isDuplicate: false, reason: "" }
      : this.deduplicator.isDuplicate(call.name, call.arguments);
    if (isDuplicate) {
      this.providerLog(
        `Cannot call ${call.name} again because ${duplicateReason}.`
      );
      eventHandler?.("reportStreamEvent", {
        type: "removeStatusResponse",
        uuid: msgUUID,
        content:
          "The model tried to call a function with the same arguments as a previous call - it was ignored.",
      });
      return { toolCall: null, text: textResponse, uuid: msgUUID };
    }

    eventHandler?.("reportStreamEvent", {
      uuid: msgUUID,
      type: "toolCallInvocation",
      content: `Parsed Tool Call: ${call.name}(${JSON.stringify(call.arguments)})`,
    });
    return { toolCall: call, text: null, uuid: msgUUID };
  }

  /**
   * Stream a chat completion from the LLM with tool calling
   * Note: This using the OpenAI API format and may need to be adapted for other providers.
   *
   * @param {any[]} messages - The messages to send to the LLM.
   * @param {any[]} functions - The functions to use in the LLM.
   * @param {function} chatCallback - A callback function to handle the chat completion.
   * @param {function} eventHandler - The event handler to use to report stream events.
   * @returns {Promise<{ functionCall: any, textResponse: string }>} - The result of the chat completion.
   */
  async stream(
    messages,
    functions = [],
    chatCallback = null,
    eventHandler = null
  ) {
    this.providerLog("Untooled.stream - will process this chat completion.");
    // eslint-disable-next-line
    try {
      let completion = { content: "" };
      let globalMsgUUID = v4();
      
      if (functions.length > 0) {
        const {
          toolCall,
          text,
          uuid: msgUUID,
        } = await this.streamingFunctionCall(
          messages,
          functions,
          chatCallback,
          eventHandler
        );
        if (msgUUID) globalMsgUUID = msgUUID;

        if (toolCall !== null) {
          this.providerLog(`Valid tool call found - running ${toolCall.name}.`);
          this.deduplicator.trackRun(toolCall.name, toolCall.arguments, {
            cooldown: this.isMCPTool(toolCall, functions),
          });
          return {
            result: null,
            functionCall: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
            cost: 0,
          };
        }

        if (text) {
          this.providerLog(
            `No tool call found in the response - will send as a full text response.`
          );
          completion.content = text;
          eventHandler?.("reportStreamEvent", {
            type: "removeStatusResponse",
            uuid: msgUUID,
            content: "No tool call found in the response",
          });
          eventHandler?.("reportStreamEvent", {
            type: "statusResponse",
            uuid: v4(),
            content: "Done thinking.",
          });
          eventHandler?.("reportStreamEvent", {
            type: "fullTextResponse",
            uuid: v4(),
            content: text,
          });
        }
      }

      if (!completion?.content) {
        eventHandler?.("reportStreamEvent", {
          type: "statusResponse",
          uuid: v4(),
          content: "Done thinking.",
        });

        this.providerLog(
          "Will assume chat completion without tool call inputs."
        );
        const msgUUID = v4();
        globalMsgUUID = msgUUID;
        
        completion = { content: "" };
        const stream = await chatCallback({
          messages: this.cleanMsgs(messages),
        });

        for await (const chunk of stream) {
          if (!chunk?.choices?.[0]) continue; // Skip if no choices
          const choice = chunk.choices[0];
          if (choice.delta?.content) {
            completion.content += choice.delta.content;
            eventHandler?.("reportStreamEvent", {
              type: "textResponseChunk",
              uuid: msgUUID,
              content: choice.delta.content,
            });
          }
        }
      }

      // The UnTooled class inherited Deduplicator is mostly useful to prevent the agent
      // from calling the exact same function over and over in a loop within a single chat exchange
      // _but_ we should enable it to call previously used tools in a new chat interaction.
      this.deduplicator.reset("runs");
      return {
        textResponse: completion.content,
        cost: 0,
        uuid: globalMsgUUID,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Create a completion based on the received messages.
   *
   * @param messages A list of messages to send to the API.
   * @param functions
   * @param chatCallback - A callback function to handle the chat completion.
   * @returns The completion.
   */
  async complete(messages, functions = [], chatCallback = null) {
    this.providerLog("Untooled.complete - will process this chat completion.");
    // eslint-disable-next-line
    try {
      let completion = { content: "" };
      if (functions.length > 0) {
        const { toolCall, text } = await this.functionCall(
          messages,
          functions,
          chatCallback
        );

        if (toolCall !== null) {
          this.providerLog(`Valid tool call found - running ${toolCall.name}.`);
          this.deduplicator.trackRun(toolCall.name, toolCall.arguments, {
            cooldown: this.isMCPTool(toolCall, functions),
          });
          return {
            result: null,
            functionCall: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
            cost: 0,
          };
        }
        completion.content = text;
      }

      // If there are no functions, we want to run a normal chat completion.
      if (!completion?.content) {
        this.providerLog(
          "Will assume chat completion without tool call inputs."
        );
        const response = await chatCallback({
          messages: this.cleanMsgs(messages),
        });
        // If the response from the callback is the raw OpenAI Spec response object, we can use that directly.
        // Otherwise, we will assume the response is just the string output we wanted (see: `#handleFunctionCallChat` which returns the content only)
        // This handles both streaming and non-streaming completions.
        completion =
          typeof response === "string"
            ? { content: response }
            : response.choices?.[0]?.message;
      }

      // The UnTooled class inherited Deduplicator is mostly useful to prevent the agent
      // from calling the exact same function over and over in a loop within a single chat exchange
      // _but_ we should enable it to call previously used tools in a new chat interaction.
      this.deduplicator.reset("runs");
      return {
        textResponse: completion.content,
        cost: 0,
      };
    } catch (error) {
      throw error;
    }
  }
}

module.exports = UnTooled;
