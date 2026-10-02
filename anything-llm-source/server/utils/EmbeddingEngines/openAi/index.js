const { toChunks, reportEmbeddingProgress } = require("../../helpers");

class OpenAiEmbedder {
  constructor() {
    if (!process.env.OPEN_AI_KEY) throw new Error("No OpenAI API key was set.");
    this.className = "OpenAiEmbedder";
    const { OpenAI: OpenAIApi } = require("openai");
    this.openai = new OpenAIApi({
      apiKey: process.env.OPEN_AI_KEY,
    });
    this.model = process.env.EMBEDDING_MODEL_PREF || "text-embedding-ada-002";

    // Limit of how many strings we can process in a single pass to stay with resource or network limits
    this.maxConcurrentChunks = 500;

    // https://platform.openai.com/docs/guides/embeddings/embedding-models
    this.embeddingMaxChunkLength = 8_191;
  }

  log(text, ...args) {
    console.log(`\x1b[36m[${this.className}]\x1b[0m ${text}`, ...args);
  }

  async embedTextInput(textInput) {
    const result = await this.embedChunks(
      Array.isArray(textInput) ? textInput : [textInput]
    );
    return result?.[0] || [];
  }

  async embedChunks(textChunks = []) {
    this.log(`Embedding ${textChunks.length} chunks...`);

    // Because there is a hard POST limit on how many chunks can be sent at once to OpenAI (~8mb)
    // we concurrently execute each max batch of text chunks possible.
    // Refer to constructor maxConcurrentChunks for more info.
    const data = [];
    let chunksProcessed = 0;
    let error = null;

    for (const chunk of toChunks(textChunks, this.maxConcurrentChunks)) {
      try {
        const result = await this.openai.embeddings.create({
          model: this.model,
          input: chunk,
        });
        chunksProcessed += chunk.length;
        reportEmbeddingProgress(chunksProcessed, textChunks.length);
        if (result?.data) {
          data.push(...result.data);
        }
      } catch (e) {
        chunksProcessed += chunk.length;
        reportEmbeddingProgress(chunksProcessed, textChunks.length);
        e.type = e?.response?.data?.error?.code || e?.response?.status || "failed_to_embed";
        e.message = e?.response?.data?.error?.message || e.message;
        error = `[${e.type}]: ${e.message}`;
        break; // Abort on first error
      }
    }

    if (!!error) throw new Error(`OpenAI Failed to embed: ${error}`);
    return data.length > 0 &&
      data.every((embd) => embd.hasOwnProperty("embedding"))
      ? data.map((embd) => embd.embedding)
      : null;
  }
}

module.exports = {
  OpenAiEmbedder,
};
