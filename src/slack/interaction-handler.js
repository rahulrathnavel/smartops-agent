'use strict';

const incidentManager = require('../core/incident-manager');
const slack = require('../integrations/slack-client');

// ---------------------------------------------------------------------------
// Slack interaction handler.
// Processes button clicks from Block Kit messages.
//
// IMPORTANT: Slack requires a response within 3 seconds. We immediately
// acknowledge the interaction and process the action asynchronously.
// We also respond to the response_url to update the button state.
// ---------------------------------------------------------------------------

async function handleInteraction(payload) {
  if (!payload || !payload.actions || payload.actions.length === 0) return;

  const action = payload.actions[0];
  const userId = payload.user?.id || payload.user?.username || 'unknown';
  const incidentId = action.value;
  const responseUrl = payload.response_url;

  console.log(`[SLACK] Interaction: ${action.action_id} for ${incidentId} by ${userId}`);

  // Immediately acknowledge with a status update via response_url
  // This tells Slack we received the click (prevents "timed out" tooltip)
  if (responseUrl) {
    try {
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replace_original: false,
          text: getAckMessage(action.action_id, incidentId),
        }),
      });
    } catch (ackErr) {
      console.warn('[SLACK] Failed to send acknowledgment:', ackErr.message);
    }
  }

  // Process the action asynchronously (no timeout constraint)
  setImmediate(async () => {
    try {
      switch (action.action_id) {
        case 'approve_fix':
          await incidentManager.handleApproval(incidentId, userId);
          break;

        case 'reject_fix':
          await incidentManager.handleRejection(incidentId, userId);
          break;

        case 'suggest_fix': {
          const incident = incidentManager.getIncident(incidentId);
          if (incident?.slackMessage) {
            await slack.postThreadReply(
              incident.slackMessage.channel,
              incident.slackMessage.ts,
              `<@${userId}> Please reply in this thread with your suggestion. Mention \`@smartops-agent\` followed by your feedback and I will generate a revised fix.`
            );
          }
          break;
        }

        default:
          console.warn(`[SLACK] Unknown action: ${action.action_id}`);
      }
    } catch (err) {
      console.error(`[SLACK] Error processing ${action.action_id}:`, err.message);

      // Notify the user about the failure via response_url
      if (responseUrl) {
        try {
          await fetch(responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              replace_original: false,
              text: `Error processing ${action.action_id}: ${err.message}`,
            }),
          });
        } catch (_) {}
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Generate an immediate acknowledgment message for each action type.
// ---------------------------------------------------------------------------
function getAckMessage(actionId, incidentId) {
  switch (actionId) {
    case 'approve_fix':
      return `Processing approval for ${incidentId}... Creating branch, committing fix, and opening PR. This may take 30-60 seconds.`;
    case 'reject_fix':
      return `Rejection recorded for ${incidentId}.`;
    case 'suggest_fix':
      return `Opening suggestion thread for ${incidentId}. Please reply with your feedback.`;
    default:
      return `Processing ${actionId} for ${incidentId}...`;
  }
}

module.exports = { handleInteraction };
