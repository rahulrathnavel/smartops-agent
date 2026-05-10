'use strict';

const { config } = require('../config');

// ---------------------------------------------------------------------------
// NVIDIA NIM embedding client.
// Model: nvidia/nv-embedqa-e5-v5 (1024 dimensions)
// This model requires 'input_type' parameter:
//   - "passage" for document/code indexing
//   - "query" for search queries
// Uses raw fetch instead of OpenAI SDK because the SDK does not
// support the 'input_type' parameter required by asymmetric models.
// ---------------------------------------------------------------------------

const EMBED_URL = `${config.nvidia.baseUrl}/embeddings`;

// ---------------------------------------------------------------------------
// Generate embeddings for an array of text chunks.
// Returns array of { index, embedding } objects.
// inputType: "passage" for indexing, "query" for search
// ---------------------------------------------------------------------------
async function generateEmbeddings(texts, inputType = 'passage') {
  const BATCH_SIZE = 20;
  const results = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    try {
      const response = await fetch(EMBED_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.nvidia.apiKey}`,
        },
        body: JSON.stringify({
          model: config.nvidia.embeddingModel,
          input: batch,
          input_type: inputType,
          encoding_format: 'float',
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${response.status} ${errorText}`);
      }

      const data = await response.json();

      for (const item of data.data) {
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
// Uses input_type "query" for asymmetric search.
// ---------------------------------------------------------------------------
async function generateQueryEmbedding(text) {
  const results = await generateEmbeddings([text], 'query');
  return results[0]?.embedding || new Array(config.pinecone.dimension).fill(0);
}

module.exports = { generateEmbeddings, generateQueryEmbedding };
