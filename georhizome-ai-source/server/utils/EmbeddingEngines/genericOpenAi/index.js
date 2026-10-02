const {
  toChunks,
  maximumChunkLength,
  reportEmbeddingProgress,
} = require("../../helpers");

class GenericOpenAiEmbedder {
  constructor() {
    this.className = "GenericOpenAiEmbedder";
    const { OpenAI: OpenAIApi } = require("openai");
    const fs = require("fs");
    const path = require("path");
    let config = {};
    try {
      const configPath = path.resolve(__dirname, "../../../../../../config/app_config.json");
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, "utf-8"))?.embedding || {};
      }
    } catch (e) {}

    this.basePath = process.env.EMBEDDING_BASE_PATH || config.base_url || "http://127.0.0.1:8000/v1";
    this.openai = new OpenAIApi({
      baseURL: this.basePath,
      apiKey: process.env.GENERIC_OPEN_AI_EMBEDDING_API_KEY ?? config.api_key ?? "sk-123abc",
    });
    this.model = process.env.EMBEDDING_MODEL_PREF ?? config.model_name ?? "BAAI/bge-m3";
    this.dimension = Number(process.env.EMBEDDING_DIMENSION) || config.dimension || 1024;
    this.embeddingMaxChunkLength = Number(process.env.EMBEDDING_MAX_CHUNK_LENGTH) || config.max_chunk_length || 1024;
    this.#cachedRuntimeDimension = null;

    this.log(`Initialized ${this.model}`, {
      baseURL: this.basePath,
      dimension: this.dimension,
      maxConcurrentChunks: this.maxConcurrentChunks,
      embeddingMaxChunkLength: this.embeddingMaxChunkLength,
    });
  }

  #cachedRuntimeDimension;

  /**
   * Derives the embedding dimension dynamically at runtime by executing a test embedding.
   * Caches the derived length for the session.
   * @returns {Promise<number>}
   */
  async getDimension() {
    if (this.#cachedRuntimeDimension !== null) return this.#cachedRuntimeDimension;
    try {
      const vec = await this.embedTextInput("dimension_healthcheck");
      if (Array.isArray(vec) && vec.length > 0) {
        this.#cachedRuntimeDimension = vec.length;
        this.dimension = vec.length;
        this.log(`Derived runtime vector dimension: ${this.#cachedRuntimeDimension}`);
        return this.#cachedRuntimeDimension;
      }
    } catch (e) {
      this.log(`Warning: Failed to derive dynamic vector dimension: ${e.message}`);
    }
    return this.dimension || 1024;
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  /**
   * returns the `GENERIC_OPEN_AI_EMBEDDING_API_DELAY_MS` env variable as a number or null if the env variable is not set or is not a number.
   * The minimum delay is 500ms.
   *
   * For some implementation this is necessary to avoid 429 errors due to rate limiting or
   * hardware limitations where a single-threaded process is not able to handle the requests fast enough.
   * @returns {number}
   */
  get apiRequestDelay() {
    return null;
  }

  /**
   * runs the delay if it is set and valid.
   * @returns {Promise<void>}
   */
  async runDelay() {
    if (!this.apiRequestDelay) return;
    this.log(`Delaying new batch request for ${this.apiRequestDelay}ms`);
    await new Promise((resolve) => setTimeout(resolve, this.apiRequestDelay));
  }

  /**
   * returns the `GENERIC_OPEN_AI_EMBEDDING_MAX_CONCURRENT_CHUNKS` env variable as a number
   * or 16 if the env variable is not set or is not a number.
   * @returns {number}
   */
  get maxConcurrentChunks() {
    return 2;
  }

  stripMetadataComments(text) {
    if (typeof text !== "string") return text;
    return text.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }

  async embedTextInput(textInput = "") {
    const cleaned = this.stripMetadataComments(textInput);
    const normalized = typeof cleaned === "string" ? cleaned.normalize("NFKC") : cleaned;
    const res = await fetch(`${this.basePath}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, input: [normalized] }),
    });
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding || [];
    if (Array.isArray(vec) && vec.length > 0) {
      this.dimension = vec.length;
      this.#cachedRuntimeDimension = vec.length;
    }
    return vec;
  }

  async embedChunks(textChunks = []) {
    const normalizedChunks = textChunks.map((c) => {
      const cleaned = this.stripMetadataComments(c);
      return typeof cleaned === "string" ? cleaned.normalize("NFKC") : cleaned;
    });
    const allResults = [];
    for (const chunk of toChunks(normalizedChunks, this.maxConcurrentChunks)) {
      const res = await fetch(`${this.basePath}/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: chunk }),
      });
      const data = await res.json();
      if (data?.data) {
        allResults.push(...data.data);
      }
      reportEmbeddingProgress(allResults.length, textChunks.length);
      await new Promise((r) => setTimeout(r, 10));
    }

    return allResults.length > 0 &&
      allResults.every((embd) => embd.hasOwnProperty("embedding"))
      ? allResults.map((embd) => embd.embedding)
      : null;
  }
}

module.exports = {
  GenericOpenAiEmbedder,
};
