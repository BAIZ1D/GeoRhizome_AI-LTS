const lancedb = require("@lancedb/lancedb");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { sourceIdentifier } = require("../../chats");
const { NativeEmbeddingReranker } = require("../../EmbeddingRerankers/native");
const { VectorDatabase } = require("../base");
const path = require("path");

/**
 * LancedDB Client connection object
 * @typedef {import('@lancedb/lancedb').Connection} LanceClient
 */

class LanceDb extends VectorDatabase {
  constructor() {
    super();
  }

  get uri() {
    const basePath = !!process.env.STORAGE_DIR
      ? process.env.STORAGE_DIR
      : path.resolve(__dirname, "../../../storage");
    return path.resolve(basePath, "lancedb");
  }

  get name() {
    return "LanceDb";
  }

  /** @returns {Promise<{client: LanceClient}>} */
  async connect() {
    const client = await lancedb.connect(this.uri);
    return { client };
  }

  distanceToSimilarity(distance = null) {
    if (distance === null || typeof distance !== "number") return 0.0;
    if (distance >= 1.0) return 1;
    if (distance < 0) return 1 - Math.abs(distance);
    return 1 - distance;
  }

  async heartbeat() {
    await this.connect();
    return { heartbeat: Number(new Date()) };
  }

  async tables() {
    const { client } = await this.connect();
    return await client.tableNames();
  }

  /**
   * Startup self-check: Verifies live embedder dimension against all existing workspace tables.
   * Logs a loud warning for any workspace table built with a different dimension.
   * @param {number} expectedDimension
   */
  async checkDimensionAlignment(expectedDimension) {
    if (!expectedDimension) return;
    try {
      const { client } = await this.connect();
      const tables = await client.tableNames();
      for (const tableName of tables) {
        try {
          const table = await client.openTable(tableName);
          const schema = await table.schema();
          const vectorField = schema.fields.find((f) => f.name === "vector");
          const tableDim = vectorField?.type?.listSize;
          if (tableDim && tableDim !== expectedDimension) {
            console.warn(
              `\x1b[33m[LanceDB Startup Warning] Table '${tableName}' schema dimension (${tableDim}) differs from live embedder dimension (${expectedDimension})! Version drift detected.\x1b[0m`
            );
          }
        } catch (e) {}
      }
    } catch (err) {
      console.warn(`[LanceDB Startup Warning] Could not perform dimension self-check: ${err.message}`);
    }
  }

  async totalVectors() {
    const { client } = await this.connect();
    const tables = await client.tableNames();
    let count = 0;
    for (const tableName of tables) {
      const table = await client.openTable(tableName);
      count += await table.countRows();
    }
    return count;
  }

  async namespaceCount(_namespace = null) {
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, _namespace);
    if (!exists) return 0;

    const table = await client.openTable(_namespace);
    return (await table.countRows()) || 0;
  }

  /**
   * Performs a SimilaritySearch + Reranking on a namespace.
   * @param {Object} params - The parameters for the rerankedSimilarityResponse.
   * @param {Object} params.client - The vectorDB client.
   * @param {string} params.namespace - The namespace to search in.
   * @param {string} params.query - The query to search for (plain text).
   * @param {number[]} params.queryVector - The vector of the query.
   * @param {number} params.similarityThreshold - The threshold for similarity.
   * @param {number} params.topN - the number of results to return from this process.
   * @param {string[]} params.filterIdentifiers - The identifiers of the documents to filter out.
   * @returns
   */
  async rerankedSimilarityResponse({
    client,
    namespace,
    query,
    queryVector,
    topN = 10,
    similarityThreshold = 0.25,
    filterIdentifiers = [],
  }) {
    const fs = require("fs");
    const path = require("path");
    const yaml = require("js-yaml");

    let retrievalCfg = {
      wide_candidate_count: 30,
      final_top_k: topN || 10,
      min_reranker_score: -10.0,
      reranker_server_url: "http://127.0.0.1:8001/rerank",
      reranker_enabled: false,
      timeout_ms: 3000,
    };

    try {
      const cfgPath = path.resolve(__dirname, "../../../../../../config/retrieval.yaml");
      if (fs.existsSync(cfgPath)) {
        const yamlContent = yaml.load(fs.readFileSync(cfgPath, "utf-8"));
        if (yamlContent?.retrieval) {
          retrievalCfg = { ...retrievalCfg, ...yamlContent.retrieval };
        }
      }
    } catch (e) {}

    const collection = await client.openTable(namespace);
    const wideCount = Math.max(topN, retrievalCfg.wide_candidate_count || 30);

    // Stage 1: Wide Cosine Candidate Search
    let candidateRows = [];
    try {
      candidateRows = await collection
        .vectorSearch(queryVector)
        .distanceType("cosine")
        .limit(wideCount)
        .toArray();
    } catch (err) {
      if (err.message && (err.message.includes("No vector column found") || err.message.includes("dimension"))) {
        console.warn(`[LanceDb] Workspace table '${namespace}' vector dimension mismatch with query vector (${queryVector.length}-dim). Returning empty context.`);
        return { contextTexts: [], sourceDocuments: [], scores: [] };
      }
      throw err;
    }

    if (!candidateRows || candidateRows.length === 0) {
      return { contextTexts: [], sourceDocuments: [], scores: [] };
    }

    // Stage 2: Rerank via Local Reranker FastAPI Server (if enabled)
    let rerankedCandidates = null;
    if (retrievalCfg.reranker_enabled !== false) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), retrievalCfg.timeout_ms || 3000);

      const payload = {
        query: query,
        candidates: candidateRows.map((r, idx) => ({
          id: r.id || String(idx),
          text: r.text || "",
          metadata: r,
        })),
      };

      const res = await fetch(retrievalCfg.reranker_server_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await res.json();
        if (data?.results && Array.isArray(data.results)) {
          rerankedCandidates = data.results;
        }
      }
      } catch (err) {
        console.warn(
          `\x1b[33m[Reranker Warning] Local Reranker Server (${retrievalCfg.reranker_server_url}) unreachable: ${err.message}. Falling back to Stage-1 Cosine Search.\x1b[0m`
        );
      }
    }

    const result = { contextTexts: [], sourceDocuments: [], scores: [] };
    const finalLimit = retrievalCfg.final_top_k || topN || 10;

    if (rerankedCandidates && rerankedCandidates.length > 0) {
      // Use Stage 2 Cross-Encoder Scores
      const filtered = rerankedCandidates.filter(
        (c) => c.score >= (retrievalCfg.min_reranker_score ?? -10.0)
      );
      const topItems = filtered.slice(0, finalLimit);

      topItems.forEach((item) => {
        const itemMeta = item.metadata || {};
        if (filterIdentifiers.includes(sourceIdentifier(itemMeta))) return;
        result.contextTexts.push(item.text);
        result.sourceDocuments.push({
          ...itemMeta,
          score: item.score,
        });
        result.scores.push(item.score);
      });
    } else {
      // Fallback: Stage 1 Cosine Results
      const topItems = candidateRows.slice(0, finalLimit);
      topItems.forEach((item) => {
        const similarity = this.distanceToSimilarity(item._distance);
        if (similarity < similarityThreshold) return;
        if (filterIdentifiers.includes(sourceIdentifier(item))) return;
        result.contextTexts.push(item.text);
        result.sourceDocuments.push({
          ...item,
          score: similarity,
        });
        result.scores.push(similarity);
      });
    }

    return result;
  }

  /**
   * Performs a SimilaritySearch on a give LanceDB namespace.
   * @param {Object} params
   * @param {LanceClient} params.client
   * @param {string} params.namespace
   * @param {number[]} params.queryVector
   * @param {number} params.similarityThreshold
   * @param {number} params.topN
   * @param {string[]} params.filterIdentifiers
   * @returns
   */
  async similarityResponse({
    client,
    namespace,
    queryVector,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    const collection = await client.openTable(namespace);
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    let response = [];
    try {
      response = await collection
        .vectorSearch(queryVector)
        .distanceType("cosine")
        .limit(topN)
        .toArray();
    } catch (err) {
      if (err.message && (err.message.includes("No vector column found") || err.message.includes("dimension"))) {
        console.warn(`[LanceDb] Workspace table '${namespace}' vector dimension mismatch with query vector (${queryVector.length}-dim). Returning empty context.`);
        return result;
      }
      throw err;
    }

    response.forEach((item) => {
      if (this.distanceToSimilarity(item._distance) < similarityThreshold)
        return;
      const { vector: _, ...rest } = item;
      if (filterIdentifiers.includes(sourceIdentifier(rest))) {
        this.logger(
          "A source was filtered from context as it's parent document is pinned."
        );
        return;
      }

      result.contextTexts.push(rest.text);
      result.sourceDocuments.push({
        ...rest,
        score: this.distanceToSimilarity(item._distance),
      });
      result.scores.push(this.distanceToSimilarity(item._distance));
    });

    return result;
  }

  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  async namespace(client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collection = await client.openTable(namespace).catch(() => false);
    if (!collection) return null;

    return {
      ...collection,
    };
  }

  /**
   *
   * @param {LanceClient} client
   * @param {number[]} data
   * @param {string} namespace
   * @returns
   */
  async updateOrCreateCollection(client, data = [], namespace) {
    if (!data || data.length === 0) return true;
    const incomingDim = data[0]?.vector?.length;

    const hasNamespace = await this.hasNamespace(namespace);
    if (hasNamespace) {
      const collection = await client.openTable(namespace);
      // Validate schema vector dimension before inserting
      try {
        const schema = await collection.schema();
        const vectorField = schema.fields.find((f) => f.name === "vector");
        const tableDim = vectorField?.type?.listSize;

        if (incomingDim && tableDim && incomingDim !== tableDim) {
          console.warn(
            `\x1b[33m[LanceDB Auto-Heal] Table '${namespace}' schema dimension (${tableDim}) differs from incoming vector dimension (${incomingDim}). Dropping old table and recreating with new ${incomingDim}-dim schema...\x1b[0m`
          );
          await client.dropTable(namespace);
          await client.createTable(namespace, data);
          return true;
        }
      } catch (err) {
        if (err.message.includes("[LanceDB Hard-Fail]")) throw err;
      }

      await collection.add(data);
      return true;
    }

    await client.createTable(namespace, data);
    return true;
  }

  async hasNamespace(namespace = null) {
    if (!namespace) return false;
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    return exists;
  }

  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  async namespaceExists(client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    const collections = await client.tableNames();
    return collections.includes(namespace);
  }

  /**
   *
   * @param {LanceClient} client
   * @param {string} namespace
   * @returns
   */
  async deleteVectorsInNamespace(client, namespace = null) {
    await client.dropTable(namespace);
    return true;
  }

  async deleteDocumentFromNamespace(namespace, docId) {
    const { client } = await this.connect();
    const exists = await this.namespaceExists(client, namespace);
    if (!exists) {
      this.logger(
        `deleteDocumentFromNamespace - namespace ${namespace} does not exist.`
      );
      return;
    }

    const { DocumentVectors } = require("../../../models/vectors");
    const table = await client.openTable(namespace);
    const vectorIds = (await DocumentVectors.where({ docId })).map(
      (record) => record.vectorId
    );

    if (vectorIds.length === 0) return;
    await table.delete(`id IN (${vectorIds.map((v) => `'${v}'`).join(",")})`);
    return true;
  }

  normalizeChunkForHash(text) {
    if (typeof text !== "string") return text || "";
    let cleaned = text.normalize("NFKC");
    // Strip HTML metadata comments
    cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");
    // Collapse whitespace between CJK/Kana characters
    cleaned = cleaned.replace(/(?<=[\u4E00-\u9FFF\u3040-\u30FF])\s+(?=[\u4E00-\u9FFF\u3040-\u30FF])/g, "");
    // Collapse generic whitespace
    cleaned = cleaned.replace(/\s+/g, " ").trim();
    return cleaned;
  }

  async addDocumentToNamespace(
    namespace,
    documentData = {},
    fullFilePath = null,
    skipCache = true
  ) {
    const { DocumentVectors } = require("../../../models/vectors");
    try {
      const { pageContent: rawPageContent, docId, ...metadata } = documentData;
      if (!rawPageContent || rawPageContent.length == 0) return false;
      const pageContent = rawPageContent.normalize("NFKC");

      this.logger("Adding new vectorized document into namespace", namespace);
      if (!skipCache) {
        const cacheResult = await cachedVectorInformation(fullFilePath);
        if (cacheResult.exists) {
          const { client } = await this.connect();
          const { chunks } = cacheResult;
          const documentVectors = [];
          const submissions = [];

          for (const chunk of chunks) {
            chunk.forEach((chunk) => {
              const id = uuidv4();
              const { id: _id, ...metadata } = chunk.metadata;
              documentVectors.push({ docId, vectorId: id });
              submissions.push({ id: id, vector: chunk.values, ...metadata });
            });
          }

          await this.updateOrCreateCollection(client, submissions, namespace);
          await DocumentVectors.bulkInsert(documentVectors);
          return { vectorized: true, error: null };
        }
      }

      // If we are here then we are going to embed and store a novel document.
      // We have to do this manually as opposed to using LangChains `xyz.fromDocuments`
      // because we then cannot atomically control our namespace to granularly find/remove documents
      // from vectordb.
      const EmbedderEngine = getEmbeddingEngineSelection();
      const textSplitter = new TextSplitter({
        chunkSize: TextSplitter.determineMaxChunkSize(
          await SystemSettings.getValueOrFallback({
            label: "text_splitter_chunk_size",
          }),
          EmbedderEngine?.embeddingMaxChunkLength
        ),
        chunkOverlap: await SystemSettings.getValueOrFallback(
          { label: "text_splitter_chunk_overlap" },
          20
        ),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
        chunkPrefix: EmbedderEngine?.embeddingPrefix,
      });
      const textChunks = await textSplitter.splitText(pageContent);

      this.logger("Snippets created from document:", textChunks.length);
      const crypto = require("crypto");
      const { client } = await this.connect();
      const existingTableExists = await this.hasNamespace(namespace);
      const existingHashes = new Set();

      if (existingTableExists) {
        try {
          const table = await client.openTable(namespace);
          const existingRows = await table.search().select(["content_hash"]).toArray();
          existingRows.forEach((row) => {
            if (row.content_hash) existingHashes.add(row.content_hash);
          });
        } catch (e) {}
      }

      const documentVectors = [];
      const vectors = [];
      const submissions = [];
      const vectorValues = await EmbedderEngine.embedChunks(textChunks);

      if (!!vectorValues && vectorValues.length > 0) {
        for (const [i, vector] of vectorValues.entries()) {
          const textChunk = textChunks[i];
          const cleanHashInput = this.normalizeChunkForHash(textChunk);
          const contentHash = crypto.createHash("sha256").update(cleanHashInput).digest("hex");

          // Skip exact duplicate chunk in the same workspace table
          if (existingHashes.has(contentHash)) {
            this.logger(`[Deduplication] Skipping duplicate chunk hash ${contentHash.slice(0, 8)}...`);
            continue;
          }

          existingHashes.add(contentHash);

          // Infer block_type from text structure
          let block_type = "prose";
          if (cleanHashInput.includes("|---|") || cleanHashInput.includes("| --- |")) {
            block_type = "table";
          } else if (cleanHashInput.includes("目次") || cleanHashInput.includes("Table of Contents")) {
            block_type = "toc";
          } else if (/^\s*[-*•\d+.]/m.test(cleanHashInput)) {
            block_type = "list";
          } else if (cleanHashInput.startsWith("```")) {
            block_type = "code_or_roster";
          }

          const enrichedMetadata = {
            ...metadata,
            // [DO NOT REMOVE]
            // LangChain will be unable to find your text if you embed manually and dont include the `text` key.
            // https://github.com/hwchase17/langchainjs/blob/2def486af734c0ca87285a48f1a04c057ab74bdf/langchain/src/vectorstores/pinecone.ts#L64
            text: textChunk,
            content_hash: contentHash,
            source_document_id: docId,
            source_filename: metadata.title || metadata.name || (fullFilePath ? path.basename(fullFilePath) : "unknown"),
            workspace_id: namespace,
            page_reference: metadata.page || metadata.page_number || 1,
            ocr_quality: metadata.ocr_quality || "pass",
            block_type: metadata.block_type || block_type,
            upload_timestamp: new Date().toISOString(),
          };

          const vectorRecord = {
            id: uuidv4(),
            values: vector,
            metadata: enrichedMetadata,
          };

          vectors.push(vectorRecord);
          submissions.push({
            ...enrichedMetadata,
            id: vectorRecord.id,
            vector: vectorRecord.values,
          });
          documentVectors.push({ docId, vectorId: vectorRecord.id });
        }
      } else {
        throw new Error(
          "Could not embed document chunks! This document will not be recorded."
        );
      }

      if (vectors.length > 0) {
        const chunks = [];
        for (const chunk of toChunks(vectors, 500)) chunks.push(chunk);

        this.logger("Inserting vectorized chunks into LanceDB collection.");
        const { client } = await this.connect();
        await this.updateOrCreateCollection(client, submissions, namespace);
        await storeVectorResult(chunks, fullFilePath);
      }

      await DocumentVectors.bulkInsert(documentVectors);
      return { vectorized: true, error: null };
    } catch (e) {
      this.logger("addDocumentToNamespace", e.message);
      return { vectorized: false, error: e.message };
    }
  }

  async performSimilaritySearch({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
    rerank = false,
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    const EmbedderEngine = getEmbeddingEngineSelection();
    const queryVector = await EmbedderEngine.embedTextInput(input);
    
    // Always execute two-stage retrieval (LanceDB Cosine Candidate Search -> Cross-Encoder Rerank)
    const result = await this.rerankedSimilarityResponse({
      client,
      namespace,
      query: input,
      queryVector,
      similarityThreshold,
      topN,
      filterIdentifiers,
    });

    const { contextTexts, sourceDocuments } = result;
    const sources = sourceDocuments.map((metadata, i) => {
      return { metadata: { ...metadata, text: contextTexts[i] } };
    });
    return {
      contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  }

  async "namespace-stats"(reqBody = {}) {
    const { namespace = null } = reqBody;
    if (!namespace) throw new Error("namespace required");
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");
    const stats = await this.namespace(client, namespace);
    return stats
      ? stats
      : { message: "No stats were able to be fetched from DB for namespace" };
  }

  async "delete-namespace"(reqBody = {}) {
    const { namespace = null } = reqBody;
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");

    await this.deleteVectorsInNamespace(client, namespace);
    return {
      message: `Namespace ${namespace} was deleted.`,
    };
  }

  async reset() {
    const { client } = await this.connect();
    const fs = require("fs");
    fs.rm(`${client.uri}`, { recursive: true }, () => null);
    return { reset: true };
  }

  curateSources(sources = []) {
    const documents = [];
    for (const source of sources) {
      const { text, vector: _v, _distance: _d, ...rest } = source;
      const metadata = rest.hasOwnProperty("metadata") ? rest.metadata : rest;
      if (Object.keys(metadata).length > 0) {
        documents.push({
          ...metadata,
          ...(text ? { text } : {}),
        });
      }
    }

    return documents;
  }
}

module.exports.LanceDb = LanceDb;
