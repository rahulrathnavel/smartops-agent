'use strict';

const github = require('../integrations/github-client');
const { generateEmbeddings } = require('../integrations/embedding-client');
const pinecone = require('../integrations/pinecone-client');
const { logAuditEvent } = require('../audit/audit-logger');

// ---------------------------------------------------------------------------
// Code Indexer.
// Clones the ammazone repo via GitHub API, chunks source files,
// generates embeddings, and upserts to Pinecone.
// ---------------------------------------------------------------------------

// File extensions we want to index
const INDEXABLE_EXTENSIONS = ['.js', '.jsx', '.ts', '.tsx', '.json', '.yaml', '.yml', '.tf'];
const MAX_CHUNK_SIZE = 400; // characters per chunk (NVIDIA NIM embeds max 512 tokens)

// Directories to skip
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage', '.terraform'];

// ---------------------------------------------------------------------------
// Determine which service a file belongs to.
// ---------------------------------------------------------------------------
function getService(filePath) {
  if (filePath.startsWith('services/')) {
    return filePath.split('/')[1]; // e.g., "catalog-service"
  }
  if (filePath.startsWith('e-commerce-main/')) return 'frontend';
  if (filePath.startsWith('k8s/')) return 'kubernetes';
  if (filePath.startsWith('infrastructure/')) return 'infrastructure';
  return 'root';
}

// ---------------------------------------------------------------------------
// Chunk a file into smaller pieces for embedding.
// Uses a simple line-based splitter with overlap.
// ---------------------------------------------------------------------------
function chunkFile(filePath, content) {
  const lines = content.split('\n');
  const chunks = [];
  let current = [];
  let currentSize = 0;

  for (const line of lines) {
    current.push(line);
    currentSize += line.length + 1;

    if (currentSize >= MAX_CHUNK_SIZE) {
      chunks.push({
        content: current.join('\n'),
        startLine: chunks.length > 0 ? chunks.length * 30 : 0,
      });
      // Keep last 3 lines as overlap for context continuity
      current = current.slice(-3);
      currentSize = current.join('\n').length;
    }
  }

  // Push remaining
  if (current.length > 0) {
    chunks.push({
      content: current.join('\n'),
      startLine: chunks.length * 30,
    });
  }

  return chunks.map((c, i) => ({
    id: `${filePath.replace(/[^a-zA-Z0-9]/g, '_')}_chunk_${i}`,
    content: c.content,
    metadata: {
      filePath,
      service: getService(filePath),
      chunkType: i === 0 ? 'header' : 'body',
      chunkIndex: i,
      content: c.content.substring(0, 350), // Store truncated content in metadata
    },
  }));
}

// ---------------------------------------------------------------------------
// Should this file be indexed?
// ---------------------------------------------------------------------------
function shouldIndex(filePath) {
  if (SKIP_DIRS.some((d) => filePath.includes(`${d}/`))) return false;
  return INDEXABLE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

// ---------------------------------------------------------------------------
// Full index: fetch all files and index them.
// ---------------------------------------------------------------------------
async function indexFullRepo() {
  console.log('[INDEXER] Starting full repository index...');
  const startTime = Date.now();

  try {
    // List all files
    const allFiles = await github.listFiles();
    const indexableFiles = allFiles.filter(shouldIndex);
    console.log(`[INDEXER] Found ${indexableFiles.length} indexable files out of ${allFiles.length} total`);

    const allChunks = [];

    // Fetch and chunk each file
    for (const filePath of indexableFiles) {
      try {
        const content = await github.getFileContent(filePath);
        const chunks = chunkFile(filePath, content);
        allChunks.push(...chunks);
      } catch (err) {
        console.warn(`[INDEXER] Skipping ${filePath}: ${err.message}`);
      }

      // Throttle to avoid GitHub rate limits
      await new Promise((r) => setTimeout(r, 200));
    }

    console.log(`[INDEXER] Generated ${allChunks.length} chunks, generating embeddings...`);

    // Generate embeddings in batches
    const texts = allChunks.map((c) => `${c.metadata.filePath}\n${c.content}`.substring(0, 450));
    const embeddings = await generateEmbeddings(texts);

    // Attach embeddings to chunks, skip any that failed (zero vectors)
    const validChunks = [];
    for (let i = 0; i < allChunks.length; i++) {
      const emb = embeddings[i]?.embedding;
      if (emb && emb.some((v) => v !== 0)) {
        allChunks[i].embedding = emb;
        validChunks.push(allChunks[i]);
      }
    }

    console.log(`[INDEXER] ${validChunks.length}/${allChunks.length} chunks have valid embeddings`);

    // Upsert to Pinecone (only valid, non-zero vectors)
    if (validChunks.length > 0) {
      await pinecone.upsertChunks(validChunks);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[INDEXER] Full index complete: ${allChunks.length} vectors in ${elapsed}s`);

    await logAuditEvent({
      incidentId: 'SYSTEM',
      actionType: 'VECTOR_QUERY',
      metadata: { operation: 'full_index', fileCount: indexableFiles.length, chunkCount: allChunks.length },
    });
  } catch (err) {
    console.error('[INDEXER] Full index failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Incremental index: only re-index changed files.
// ---------------------------------------------------------------------------
async function indexChangedFiles(changedFiles) {
  console.log(`[INDEXER] Incremental index for ${changedFiles.length} files...`);

  for (const filePath of changedFiles) {
    if (!shouldIndex(filePath)) continue;

    try {
      // Delete old vectors for this file
      await pinecone.deleteByFilePrefix(filePath);

      // Fetch new content and re-index
      const content = await github.getFileContent(filePath);
      const chunks = chunkFile(filePath, content);

      const texts = chunks.map((c) => `${c.metadata.filePath}\n${c.content}`.substring(0, 450));
      const embeddings = await generateEmbeddings(texts);

      const validChunks = [];
      for (let i = 0; i < chunks.length; i++) {
        const emb = embeddings[i]?.embedding;
        if (emb && emb.some((v) => v !== 0)) {
          chunks[i].embedding = emb;
          validChunks.push(chunks[i]);
        }
      }

      if (validChunks.length > 0) {
        await pinecone.upsertChunks(validChunks);
      }
      console.log(`[INDEXER] Re-indexed ${filePath} (${chunks.length} chunks)`);
    } catch (err) {
      console.warn(`[INDEXER] Failed to re-index ${filePath}:`, err.message);
    }

    await new Promise((r) => setTimeout(r, 500));
  }
}

module.exports = { indexFullRepo, indexChangedFiles };
