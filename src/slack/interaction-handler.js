'use strict';

const incidentManager = require('../core/incident-manager');
const slack = require('../integrations/slack-client');

// ---------------------------------------------------------------------------
// Slack interaction handler.
// Processes button clicks from Block Kit messages.
// ---------------------------------------------------------------------------

async function handleInteraction(payload) {
  if (!payload || !payload.actions || payload.actions.length === 0) return;

  const action = payload.actions[0];
  const userId = payload.user?.id || payload.user?.username || 'unknown';
  const incidentId = action.value;

  console.log(`[SLACK] Interaction: ${action.action_id} for ${incidentId} by ${userId}`);

  switch (action.action_id) {
    case 'approve_fix':
      await incidentManager.handleApproval(incidentId, userId);
      break;

    case 'reject_fix':
      await incidentManager.handleRejection(incidentId, userId);
      break;

    case 'suggest_fix': {
      // Post a thread reply asking for the suggestion
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
}

module.exports = { handleInteraction };
