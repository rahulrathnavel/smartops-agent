'use strict';

const { indexChangedFiles } = require('./code-indexer');

// ---------------------------------------------------------------------------
// GitHub Push Webhook Handler.
// Triggered when code is pushed to the ammazone repo.
// Extracts changed file paths and triggers incremental re-indexing.
// ---------------------------------------------------------------------------

async function handlePushWebhook(body, headers) {
  // Verify this is a push event
  const event = headers['x-github-event'];
  if (event !== 'push') {
    console.log(`[WEBHOOK] Ignoring non-push event: ${event}`);
    return;
  }

  const ref = body.ref || '';
  const commits = body.commits || [];

  // Only index pushes to main branch
  if (ref !== 'refs/heads/main') {
    console.log(`[WEBHOOK] Ignoring push to non-main branch: ${ref}`);
    return;
  }

  // Collect all changed files across commits
  const changedFiles = new Set();
  for (const commit of commits) {
    for (const f of commit.added || []) changedFiles.add(f);
    for (const f of commit.modified || []) changedFiles.add(f);
    // We do not re-index removed files (they should be deleted from vector DB)
  }

  if (changedFiles.size === 0) {
    console.log('[WEBHOOK] No files changed in push');
    return;
  }

  console.log(`[WEBHOOK] Push to main detected, re-indexing ${changedFiles.size} files...`);
  await indexChangedFiles([...changedFiles]);
}

module.exports = { handlePushWebhook };
