'use strict';

const { Pinecone } = require('@pinecone-database/pinecone');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// Pinecone vector database client.
// Index: smartops-knowledge (1024 dims, cosine, serverless free tier)
// Stores code chunks with metadata for retrieval during incident analysis.
// ---------------------------------------------------------------------------

let pc = null;
let index = null;

function getIndex() {
  if (!index) {
    pc = new Pinecone({ apiKey: config.pinecone.apiKey });
    index = pc.index(config.pinecone.indexName);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Upsert code chunks to Pinecone.
// Each chunk: { id, embedding, metadata: { filePath, service, chunkType, content, lastCommitSha } }
// ---------------------------------------------------------------------------
async function upsertChunks(chunks) {
  const idx = getIndex();
  const ns = idx.namespace(config.pinecone.namespace);

  const BATCH_SIZE = 50;
  let upserted = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE).map((c) => ({
      id: c.id,
      values: c.embedding,
      metadata: c.metadata,
    }));

    await ns.upsert(batch);
    upserted += batch.length;
  }

  console.log(`[PINECONE] Upserted ${upserted} vectors`);
  return upserted;
}

// ---------------------------------------------------------------------------
// Query relevant code chunks given an error context.
// Returns top-K matches with metadata (including source code content).
// ---------------------------------------------------------------------------
async function queryRelevantCode(queryEmbedding, topK = 10) {
  const idx = getIndex();
  const ns = idx.namespace(config.pinecone.namespace);

  const result = await ns.query({
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
    includeValues: false,
  });

  return (result.matches || []).map((m) => ({
    id: m.id,
    score: m.score,
    filePath: m.metadata?.filePath || '',
    service: m.metadata?.service || '',
    content: m.metadata?.content || '',
    chunkType: m.metadata?.chunkType || '',
  }));
}

// ---------------------------------------------------------------------------
// Delete vectors by file path prefix (for stale file cleanup).
// ---------------------------------------------------------------------------
async function deleteByFilePrefix(filePath) {
  const idx = getIndex();
  const ns = idx.namespace(config.pinecone.namespace);

  // Pinecone serverless supports delete by ID prefix in some tiers.
  // For free tier, we delete by listing IDs first.
  try {
    await ns.deleteMany({ filePath: { $eq: filePath } });
    console.log(`[PINECONE] Deleted vectors for ${filePath}`);
  } catch (err) {
    console.warn(`[PINECONE] Could not delete by filter for ${filePath}:`, err.message);
  }
}

// ---------------------------------------------------------------------------
// Ensure the index exists (called on startup).
// On free tier, index creation may need to be done via the Pinecone console.
// ---------------------------------------------------------------------------
async function ensureIndex() {
  try {
    const p = new Pinecone({ apiKey: config.pinecone.apiKey });
    const indexes = await p.listIndexes();
    const exists = indexes.indexes?.some((i) => i.name === config.pinecone.indexName);

    if (!exists) {
      console.log(`[PINECONE] Creating index "${config.pinecone.indexName}"...`);
      await p.createIndex({
        name: config.pinecone.indexName,
        dimension: config.pinecone.dimension,
        metric: 'cosine',
        spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
      });
      console.log('[PINECONE] Index created. Waiting 30s for it to be ready...');
      await new Promise((r) => setTimeout(r, 30_000));
    } else {
      console.log(`[PINECONE] Index "${config.pinecone.indexName}" already exists.`);
    }
  } catch (err) {
    console.error('[PINECONE] Index check/creation failed:', err.message);
  }
}

module.exports = { upsertChunks, queryRelevantCode, deleteByFilePrefix, ensureIndex };
