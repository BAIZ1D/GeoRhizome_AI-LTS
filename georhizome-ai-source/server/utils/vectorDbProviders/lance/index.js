const lancedb = require("@lancedb/lancedb");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { sourceIdentifier } = require("../../chats");
const { VectorDatabase } = require("../base");
const rerankerClient = require("../../rerankerClient");
const path = require("path");
const locks = require("../../knowledgeSync/locks");
const marker = require("../../knowledgeSync/marker");
const { KnowledgeSyncError } = require("../../knowledgeSync/errors");

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
        } catch {}
      }
    } catch (err) {
      console.warn(
        `[LanceDB Startup Warning] Could not perform dimension self-check: ${err.message}`
      );
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
    topN = 5,
    similarityThreshold = 0.25,
    filterIdentifiers = [],
    // Accepted for caller compatibility only: Stage 2 is gated solely by
    // app_config.reranker.enabled, whatever the workspace vectorSearchMode is.
    rerank: _rerank = false,
  }) {
    locks.assertNotSyncing(namespace);
    const cfg = rerankerClient.loadRerankerConfig();
    const finalLimit = cfg.final_top_k || topN || 10;
    const wideCount = rerankerClient.resolveWideCount(cfg, finalLimit);
    const empty = { contextTexts: [], sourceDocuments: [], scores: [] };

    const collection = await client.openTable(namespace);

    // Stage 1: wide cosine candidate search
    let candidateRows = [];
    try {
      candidateRows = await collection
        .vectorSearch(queryVector)
        .distanceType("cosine")
        .limit(wideCount)
        .toArray();
      // WR-05: a sync may have started while we read; never return or
      // misreport results from a table that was being swapped.
      locks.assertNotSyncing(namespace);
    } catch (err) {
      locks.assertNotSyncing(namespace);
      if (
        err.message &&
        (err.message.includes("No vector column found") ||
          err.message.includes("dimension"))
      ) {
        console.warn(
          `[LanceDb] Workspace table '${namespace}' vector dimension mismatch with query vector (${queryVector.length}-dim). Returning empty context.`
        );
        return empty;
      }
      throw err;
    }
    if (!candidateRows || candidateRows.length === 0) return empty;

    const unpinned = (row) =>
      !filterIdentifiers.includes(sourceIdentifier(row));
    const result = { contextTexts: [], sourceDocuments: [], scores: [] };
    const push = (row, score) => {
      const { vector: _v, _distance: _d, ...rest } = row;
      result.contextTexts.push(rest.text);
      result.sourceDocuments.push({ ...rest, score });
      result.scores.push(score);
    };

    // Stage 2: cross-encoder rerank (logit scores). Slim payload: id + text.
    const { results } = !cfg.enabled
      ? { results: null }
      : await rerankerClient.rerank({
          query,
          candidates: candidateRows.map((r, idx) => ({
            id: String(idx),
            text: r.text || "",
          })),
          cfg,
          label: `workspace '${namespace}'`,
        });

    if (results) {
      // Logit filter only; cosine scores are never mixed into this list.
      results
        .map((r) => ({ row: candidateRows[Number(r.id)], score: r.score }))
        .filter(({ row, score }) => row && score >= cfg.min_reranker_score)
        .filter(({ row }) => unpinned(row))
        .slice(0, finalLimit)
        .forEach(({ row, score }) => push(row, score));
      return result;
    }

    // Fallback: Stage 1 cosine order with the cosine similarity threshold.
    candidateRows
      .map((row) => ({ row, score: this.distanceToSimilarity(row._distance) }))
      .filter(({ score }) => score >= similarityThreshold)
      .filter(({ row }) => unpinned(row))
      .slice(0, finalLimit)
      .forEach(({ row, score }) => push(row, score));
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
    locks.assertNotSyncing(namespace);
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
      // WR-05: a sync may have started while we read; never return or
      // misreport results from a table that was being swapped.
      locks.assertNotSyncing(namespace);
    } catch (err) {
      locks.assertNotSyncing(namespace);
      if (
        err.message &&
        (err.message.includes("No vector column found") ||
          err.message.includes("dimension"))
      ) {
        console.warn(
          `[LanceDb] Workspace table '${namespace}' vector dimension mismatch with query vector (${queryVector.length}-dim). Returning empty context.`
        );
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

    locks.assertNotSyncing(namespace);
    const hasNamespace = await this.hasNamespace(namespace);
    if (hasNamespace) {
      const collection = await client.openTable(namespace);
      // Best-effort schema read; only this read is allowed to fail silently.
      let tableDim = null;
      try {
        const schema = await collection.schema();
        const vectorField = schema.fields.find((f) => f.name === "vector");
        tableDim = vectorField?.type?.listSize || null;
      } catch {
        tableDim = null;
      }

      // Comparison is OUTSIDE the swallowing try (IMP-06).
      if (incomingDim && tableDim && incomingDim !== tableDim) {
        let synced = true; // fail closed if the marker cannot be read
        try {
          synced = await marker.isSynced(namespace);
        } catch {
          synced = true;
        }
        if (synced)
          throw new KnowledgeSyncError("KS_E_DIM_MISMATCH", { phase: "heal" });
        // Legacy auto-heal retained for unsynced local tables only.
        console.warn(
          `\x1b[33m[LanceDB Auto-Heal] Table '${namespace}' schema dimension (${tableDim}) differs from incoming vector dimension (${incomingDim}). Dropping old table and recreating with new ${incomingDim}-dim schema...\x1b[0m`
        );
        await client.dropTable(namespace);
        await client.createTable(namespace, data);
        return true;
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
    locks.assertNotSyncing(namespace);
    await client.dropTable(namespace);
    return true;
  }

  async deleteDocumentFromNamespace(namespace, docId) {
    locks.assertNotSyncing(namespace);
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
    cleaned = cleaned.replace(
      /(?<=[\u4E00-\u9FFF\u3040-\u30FF])\s+(?=[\u4E00-\u9FFF\u3040-\u30FF])/g,
      ""
    );
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
          const existingRows = await table
            .search()
            .select(["content_hash"])
            .toArray();
          existingRows.forEach((row) => {
            if (row.content_hash) existingHashes.add(row.content_hash);
          });
        } catch {}
      }

      const documentVectors = [];
      const vectors = [];
      const submissions = [];
      const vectorValues = await EmbedderEngine.embedChunks(textChunks);

      if (!!vectorValues && vectorValues.length > 0) {
        for (const [i, vector] of vectorValues.entries()) {
          const textChunk = textChunks[i];
          const cleanHashInput = this.normalizeChunkForHash(textChunk);
          const contentHash = crypto
            .createHash("sha256")
            .update(cleanHashInput)
            .digest("hex");

          // Skip exact duplicate chunk in the same workspace table
          if (existingHashes.has(contentHash)) {
            this.logger(
              `[Deduplication] Skipping duplicate chunk hash ${contentHash.slice(0, 8)}...`
            );
            continue;
          }

          existingHashes.add(contentHash);

          // Infer block_type from text structure
          let block_type = "prose";
          if (
            cleanHashInput.includes("|---|") ||
            cleanHashInput.includes("| --- |")
          ) {
            block_type = "table";
          } else if (
            cleanHashInput.includes("目次") ||
            cleanHashInput.includes("Table of Contents")
          ) {
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
            source_filename:
              metadata.title ||
              metadata.name ||
              (fullFilePath ? path.basename(fullFilePath) : "unknown"),
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
    locks.assertNotSyncing(namespace);

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

    // Two-stage retrieval (cosine candidates -> cross-encoder rerank), gated by app_config.reranker.enabled
    const result = await this.rerankedSimilarityResponse({
      client,
      namespace,
      query: input,
      queryVector,
      similarityThreshold,
      topN,
      filterIdentifiers,
      rerank,
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
    locks.assertNotSyncing(namespace);
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace)))
      throw new Error("Namespace by that name does not exist.");

    await this.deleteVectorsInNamespace(client, namespace);
    return {
      message: `Namespace ${namespace} was deleted.`,
    };
  }

  async reset() {
    if (locks.heldCount() > 0)
      throw new KnowledgeSyncError("KS_E_BUSY", { phase: "lock" });
    await this.connect();
    // Re-check after the await: a lock taken during connect() must still win.
    if (locks.heldCount() > 0)
      throw new KnowledgeSyncError("KS_E_BUSY", { phase: "lock" });
    const fs = require("fs");
    await fs.promises.rm(this.uri, { recursive: true, force: true });
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
