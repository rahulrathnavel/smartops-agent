'use strict';

const slack = require('../integrations/slack-client');
const incidentManager = require('../core/incident-manager');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// Thread Listener.
// Polls Slack threads for @mention replies containing suggestions.
// Triggers a fix re-generation when a suggestion is found.
// ---------------------------------------------------------------------------

const processedReplies = new Set(); // Track processed message timestamps

// ---------------------------------------------------------------------------
// Check all active incidents for new thread replies.
// ---------------------------------------------------------------------------
async function checkForSuggestions() {
  // This is called periodically from the main loop.
  // We only check incidents in AWAITING_APPROVAL status.
  // In a real production system, this would use Slack Events API instead of polling.

  // For now, this is a no-op placeholder.
  // The actual suggestion flow is triggered by the "Suggest Changes" button
  // in the interaction handler, which posts a prompt in the thread.
  // The SRE then replies with their suggestion.
  // We detect this via the Events API or manual polling.
}

// ---------------------------------------------------------------------------
// Process a thread reply that mentions the bot.
// Called when we detect an @mention in a thread.
// ---------------------------------------------------------------------------
async function processThreadReply(channel, threadTs, userMessage, userId) {
  // Find which incident this thread belongs to
  // by matching the threadTs with incident slack messages
  let targetIncident = null;

  // Search through active incidents
  for (const [id, incident] of Object.entries(incidentManager)) {
    if (typeof incident === 'object' && incident?.slackMessage?.ts === threadTs) {
      targetIncident = incident;
      break;
    }
  }

  if (!targetIncident) {
    console.warn('[THREAD] Could not find incident for thread:', threadTs);
    return;
  }

  // Strip the bot mention from the message
  const suggestion = userMessage
    .replace(/<@[A-Z0-9]+>/g, '')
    .trim();

  if (suggestion.length < 5) {
    await slack.postThreadReply(channel, threadTs, 'Suggestion too short. Please provide more detail.');
    return;
  }

  console.log(`[THREAD] Processing suggestion for ${targetIncident.id}: "${suggestion.substring(0, 100)}"`);
  await incidentManager.handleSuggestion(targetIncident.id, suggestion, userId);
}

module.exports = { checkForSuggestions, processThreadReply };
