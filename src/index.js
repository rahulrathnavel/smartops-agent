'use strict';

const { config, validateConfig } = require('./config');
const { createServer } = require('./server');
const { startDetectionLoop } = require('./core/incident-detector');
const { handleNewIncident } = require('./core/incident-manager');
const { handleInteraction } = require('./slack/interaction-handler');
const { handlePushWebhook } = require('./indexer/webhook-handler');
const { indexFullRepo } = require('./indexer/code-indexer');
const { ensureIndex } = require('./integrations/pinecone-client');

// ---------------------------------------------------------------------------
// SmartOps Agent -- Main Entry Point
//
// Starts three concurrent subsystems:
//   1. HTTP Server       -- receives Slack + GitHub webhooks
//   2. Detection Loop    -- polls logs and alarms for incidents
//   3. Code Indexer      -- indexes ammazone repo into Pinecone on startup
// ---------------------------------------------------------------------------

async function main() {
  console.log('='.repeat(60));
  console.log('  SmartOps Agent v1.0');
  console.log('  Autonomous Incident Resolution System');
  console.log('='.repeat(60));

  // Validate configuration
  const missing = validateConfig();
  if (missing.length > 0) {
    console.warn(`[MAIN] ${missing.length} env vars missing. Some features disabled.`);
  }

  // -----------------------------------------------------------------------
  // 1. Ensure Pinecone index exists
  // -----------------------------------------------------------------------
  console.log('[MAIN] Checking Pinecone index...');
  await ensureIndex();

  // -----------------------------------------------------------------------
  // 2. Start HTTP server for webhooks
  // -----------------------------------------------------------------------
  const app = createServer({
    interactionHandler: handleInteraction,
    webhookHandler: handlePushWebhook,
  });

  app.listen(config.port, () => {
    console.log(`[MAIN] HTTP server listening on port ${config.port}`);
    console.log(`[MAIN]   Slack webhook:  POST /slack/interactions`);
    console.log(`[MAIN]   GitHub webhook: POST /webhooks/github`);
    console.log(`[MAIN]   Health check:   GET  /health`);
  });

  // -----------------------------------------------------------------------
  // 3. Start the detection loop
  // -----------------------------------------------------------------------
  startDetectionLoop(async (rawIncident) => {
    try {
      await handleNewIncident(rawIncident);
    } catch (err) {
      console.error('[MAIN] Failed to process incident:', err.message);
    }
  });

  // -----------------------------------------------------------------------
  // 4. Initial code indexing (background, non-blocking)
  // -----------------------------------------------------------------------
  console.log('[MAIN] Starting initial code indexing (background)...');
  indexFullRepo().catch((err) => {
    console.error('[MAIN] Initial indexing failed:', err.message);
  });

  console.log('[MAIN] SmartOps Agent is running.');
  console.log(`[MAIN] Monitoring: ${config.aws.eksLogGroup}`);
  console.log(`[MAIN] Slack channel: ${config.slack.channelId}`);
  console.log(`[MAIN] Target repo: ${config.github.owner}/${config.github.repo}`);
}

// Handle uncaught errors gracefully
process.on('unhandledRejection', (err) => {
  console.error('[MAIN] Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('[MAIN] Uncaught exception:', err);
  process.exit(1);
});

main().catch((err) => {
  console.error('[MAIN] Fatal error:', err);
  process.exit(1);
});
