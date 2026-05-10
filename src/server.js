'use strict';

const express = require('express');
const { config } = require('./config');

// ---------------------------------------------------------------------------
// Express HTTP server.
// Handles two webhook routes:
//   POST /slack/interactions  -- Slack button clicks
//   POST /webhooks/github     -- GitHub push events (re-index trigger)
// Also serves a health endpoint for K8s liveness probes.
// ---------------------------------------------------------------------------

function createServer({ interactionHandler, webhookHandler }) {
  const app = express();

  // Slack sends application/x-www-form-urlencoded for interactions
  // but we need the raw body for signature verification.
  app.use('/slack/interactions', express.urlencoded({ extended: true }));

  // GitHub sends application/json
  app.use('/webhooks/github', express.json());

  // General JSON parsing for everything else
  app.use(express.json());

  // -- Health --
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', agent: config.agentName, uptime: process.uptime() });
  });

  // -- Slack interactivity webhook --
  app.post('/slack/interactions', (req, res) => {
    // Slack expects a 200 within 3 seconds; do async processing
    res.status(200).send('');
    try {
      const payload = JSON.parse(req.body.payload);
      interactionHandler(payload);
    } catch (err) {
      console.error('[SERVER] Failed to parse Slack interaction:', err.message);
    }
  });

  // -- GitHub push webhook --
  app.post('/webhooks/github', (req, res) => {
    res.status(200).json({ ok: true });
    try {
      webhookHandler(req.body, req.headers);
    } catch (err) {
      console.error('[SERVER] Failed to handle GitHub webhook:', err.message);
    }
  });

  return app;
}

module.exports = { createServer };
