const OpenAI = require("openai");
const Provider = require("./ai-provider.js");
const InheritMultiple = require("./helpers/classes.js");
const UnTooled = require("./helpers/untooled.js");
const { tooledStream, tooledComplete } = require("./helpers/tooled.js");
const { RetryError } = require("../error.js");
const { toValidNumber } = require("../../../http/index.js");
const { getAnythingLLMUserAgent } = require("../../../../endpoints/utils");
const { GenericOpenAiLLM } = require("../../../AiProviders/genericOpenAi");

/**
 * The agent provider for the Generic OpenAI provider.
 * Since we cannot promise the generic provider even supports tool calling
 * which is nearly 100% likely it does not, we can just wrap it in untooled
 * which often is far better anyway.
 */
class GenericOpenAiProvider extends InheritMultiple([Provider, UnTooled]) {
  model;

  constructor(config = {}) {
    super();
    let { model } = config;
    if (!model || model === "gpt-3.5-turbo" || model === "default") {
      try {
        const path = require("path");
        const fs = require("fs");
        const containerActivePath = "/config/active_models.json";
        const activePath = path.resolve(__dirname, "../../../../../config/active_models.json");
        if (fs.existsSync(containerActivePath)) {
          const act = JSON.parse(fs.readFileSync(containerActivePath, "utf-8"));
          if (act.generative?.model_id) model = act.generative.model_id;
        } else if (fs.existsSync(activePath)) {
          const act = JSON.parse(fs.readFileSync(activePath, "utf-8"));
          if (act.generative?.model_id) model = act.generative.model_id;
        }
        if (!model) {
          const containerAppCfgPath = "/config/app_config.json";
          const appCfgPath = path.resolve(__dirname, "../../../../../config/app_config.json");
          if (fs.existsSync(containerAppCfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(containerAppCfgPath, "utf-8"));
            if (cfg.llm?.model_name) model = cfg.llm.model_name;
          } else if (fs.existsSync(appCfgPath)) {
            const cfg = JSON.parse(fs.readFileSync(appCfgPath, "utf-8"));
            if (cfg.llm?.model_name) model = cfg.llm.model_name;
          }
        }
      } catch (e) {}
      if (!model) model = process.env.GENERIC_OPEN_AI_MODEL_PREF || "default";
    }
    const client = new OpenAI({
      baseURL: process.env.GENERIC_OPEN_AI_BASE_PATH,
      apiKey: process.env.GENERIC_OPEN_AI_API_KEY ?? null,
      maxRetries: 3,
      defaultHeaders: {
        "User-Agent": getAnythingLLMUserAgent(),
        ...GenericOpenAiLLM.parseCustomHeaders(),
      },
    });

    this._client = client;
    this.model = model;
    this.verbose = true;
    this._supportsToolCalling = null;
    this.maxTokens = process.env.GENERIC_OPEN_AI_MAX_TOKENS
      ? toValidNumber(process.env.GENERIC_OPEN_AI_MAX_TOKENS, 4096)
      : 4096;
  }

  get client() {
    return this._client;
  }

  get supportsAgentStreaming() {
    // Honor streaming being disabled via ENV via user preference.
    if (process.env.GENERIC_OPENAI_STREAMING_DISABLED === "true") return false;
    return true;
  }

  /**
   * Whether this provider supports native OpenAI-compatible tool calling.
   * - This can be any OpenAI compatible provider that supports tool calling
   * - We check the ENV to see if the provider supports tool calling.
   * - If the ENV is not set, we default to false.
   * @returns {boolean|Promise<boolean>}
   */
  supportsNativeToolCalling() {
    if (this._supportsToolCalling !== null) return this._supportsToolCalling;
    const genericOpenAi = new GenericOpenAiLLM(null, this.model);
    const capabilities = genericOpenAi.getModelCapabilities();
    this._supportsToolCalling = capabilities.tools === true;

    if (this._supportsToolCalling)
      this.providerLog(
        "Generic OpenAI supports native tool calling is ENABLED."
      );
    else
      this.providerLog(
        "Generic OpenAI supports native tool calling is DISABLED. Will use UnTooled instead."
      );

    return this._supportsToolCalling;
  }

  async #handleFunctionCallChat({ messages = [] }) {
    return await this.client.chat.completions
      .create({
        model: this.model,
        temperature: 0,
        messages,
        max_tokens: this.maxTokens,
      })
      .then((result) => {
        if (!result.hasOwnProperty("choices"))
          throw new Error("Generic OpenAI chat: No results!");
        if (result.choices.length === 0)
          throw new Error("Generic OpenAI chat: No results length!");
        return result.choices[0].message.content;
      })
      .catch((_) => {
        return null;
      });
  }

  async #handleFunctionCallStream({ messages = [] }) {
    return await this.client.chat.completions.create({
      model: this.model,
      stream: true,
      messages,
    });
  }

  /**
   * Stream a chat completion with tool calling support.
   * Uses native tool calling when supported, otherwise falls back to UnTooled.
   */
  async stream(messages, functions = [], eventHandler = null) {
    const useNative =
      functions.length > 0 && (await this.supportsNativeToolCalling());

    if (!useNative) {
      return await UnTooled.prototype.stream.call(
        this,
        messages,
        functions,
        this.#handleFunctionCallStream.bind(this),
        eventHandler
      );
    }

    this.providerLog(
      "Provider.stream (tooled) - will process this chat completion."
    );

    try {
      return await tooledStream(
        this.client,
        this.model,
        messages,
        functions,
        eventHandler,
        { provider: this }
      );
    } catch (error) {
      console.error(error.message, error);
      if (error instanceof OpenAI.AuthenticationError) throw error;
      if (
        error instanceof OpenAI.RateLimitError ||
        error instanceof OpenAI.InternalServerError ||
        error instanceof OpenAI.APIError
      ) {
        throw new RetryError(error.message);
      }
      throw error;
    }
  }

  /**
   * Create a non-streaming completion with tool calling support.
   * Uses native tool calling when supported, otherwise falls back to UnTooled.
   */
  async complete(messages, functions = []) {
    const useNative =
      functions.length > 0 && (await this.supportsNativeToolCalling());

    if (!useNative) {
      return await UnTooled.prototype.complete.call(
        this,
        messages,
        functions,
        this.#handleFunctionCallChat.bind(this)
      );
    }

    try {
      const result = await tooledComplete(
        this.client,
        this.model,
        messages,
        functions,
        this.getCost.bind(this),
        { provider: this }
      );

      if (result.retryWithError) {
        return this.complete([...messages, result.retryWithError], functions);
      }

      return result;
    } catch (error) {
      if (error instanceof OpenAI.AuthenticationError) throw error;
      if (
        error instanceof OpenAI.RateLimitError ||
        error instanceof OpenAI.InternalServerError ||
        error instanceof OpenAI.APIError
      ) {
        throw new RetryError(error.message);
      }
      throw error;
    }
  }

  /**
   * Get the cost of the completion.
   *
   * @param _usage The completion to get the cost for.
   * @returns The cost of the completion.
   */
  getCost(_usage) {
    return 0;
  }
}

module.exports = GenericOpenAiProvider;
