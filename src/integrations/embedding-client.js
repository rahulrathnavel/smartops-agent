'use strict';

const OpenAI = require('openai');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// NVIDIA NIM embedding client.
// Model: nvidia/nv-embedqa-e5-v5 (1024 dimensions)
// Uses the same API key and base URL as the LLM client.
// ---------------------------------------------------------------------------

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: config.nvidia.baseUrl,
      apiKey: config.nvidia.apiKey,
    });
  }
  return client;
}

// ---------------------------------------------------------------------------
// Generate embeddings for an array of text chunks.
// Returns array of { index, embedding } objects.
// Batches input to avoid exceeding API limits.
// ---------------------------------------------------------------------------
async function generateEmbeddings(texts) {
  const c = getClient();
  const BATCH_SIZE = 20;
  const results = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const response = await c.embeddings.create({
        model: config.nvidia.embeddingModel,
        input: batch,
      });

      for (const item of response.data) {
        results.push({
          index: i + item.index,
          embedding: item.embedding,
        });
      }
    } catch (err) {
      console.error(`[EMBED] Batch ${i}-${i + batch.length} failed:`, err.message);
      // Fill failed entries with zero vectors so indexing can continue
      for (let j = 0; j < batch.length; j++) {
        results.push({
          index: i + j,
          embedding: new Array(config.pinecone.dimension).fill(0),
        });
      }
    }

    // Respect rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

// ---------------------------------------------------------------------------
// Generate a single embedding for a query string.
// ---------------------------------------------------------------------------
async function generateQueryEmbedding(text) {
  const results = await generateEmbeddings([text]);
  return results[0]?.embedding || new Array(config.pinecone.dimension).fill(0);
}

module.exports = { generateEmbeddings, generateQueryEmbedding };
