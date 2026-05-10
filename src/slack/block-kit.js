'use strict';

// ---------------------------------------------------------------------------
// Slack Block Kit message builders.
// Creates rich, interactive messages for incident notifications.
// ---------------------------------------------------------------------------

function buildIncidentMessage(incidentId, diagnosis, fix) {
  const severityEmoji = {
    CRITICAL: ':red_circle:',
    HIGH: ':large_orange_circle:',
    MEDIUM: ':large_yellow_circle:',
    LOW: ':white_circle:',
  };

  const diffPreview = fix.files
    .map((f) => `*${f.path}*\n${f.explanation || 'Updated'}`)
    .join('\n\n')
    .substring(0, 2500);

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${incidentId} | ${diagnosis.severity || 'MEDIUM'}`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `${severityEmoji[diagnosis.severity] || ':warning:'} *Incident Detected*`,
          `*Service:* \`${diagnosis.service}\``,
          `*Error Type:* \`${diagnosis.errorType}\``,
          `*Root Cause:* ${diagnosis.rootCause}`,
        ].join('\n'),
      },
    },
    { type: 'divider' },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Proposed Fix* (${fix.files?.length || 0} file${fix.files?.length !== 1 ? 's' : ''}):\n${fix.summary || 'See details below'}`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`\n${diffPreview}\n\`\`\`` },
    },
    { type: 'divider' },
    {
      type: 'actions',
      block_id: `incident_actions_${incidentId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve & Deploy', emoji: true },
          style: 'primary',
          action_id: 'approve_fix',
          value: incidentId,
          confirm: {
            title: { type: 'plain_text', text: 'Confirm Deployment' },
            text: { type: 'mrkdwn', text: 'This will push the fix to the repo, create a PR, auto-merge, and trigger a deployment. Continue?' },
            confirm: { type: 'plain_text', text: 'Deploy' },
            deny: { type: 'plain_text', text: 'Cancel' },
          },
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject', emoji: true },
          style: 'danger',
          action_id: 'reject_fix',
          value: incidentId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Suggest Changes', emoji: true },
          action_id: 'suggest_fix',
          value: incidentId,
        },
      ],
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `SmartOps Agent | ${new Date().toISOString()} | Reply with \`@smartops-agent <suggestion>\` to refine the fix` },
      ],
    },
  ];
}

function buildApprovedMessage(incidentId, diagnosis, prNumber) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${incidentId} | RESOLVED`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          ':white_check_mark: *Fix Approved & Deployed*',
          `*Service:* \`${diagnosis.service}\``,
          `*Root Cause:* ${diagnosis.rootCause}`,
          `*PR:* #${prNumber} (auto-merged)`,
        ].join('\n'),
      },
    },
  ];
}

function buildRejectedMessage(incidentId, diagnosis) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${incidentId} | REJECTED`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          ':no_entry_sign: *Fix Rejected by SRE*',
          `*Service:* \`${diagnosis.service}\``,
          `*Root Cause:* ${diagnosis.rootCause}`,
          'The proposed fix was not applied. Manual intervention required.',
        ].join('\n'),
      },
    },
  ];
}

function buildErrorMessage(incidentId, rawIncident, errorMsg) {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${incidentId} | AGENT ERROR`, emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          ':warning: *SmartOps Agent encountered an error while processing this incident*',
          `*Service:* \`${rawIncident.service || 'unknown'}\``,
          `*Error:* ${errorMsg}`,
          'The agent could not generate a fix. Manual investigation required.',
        ].join('\n'),
      },
    },
  ];
}

module.exports = { buildIncidentMessage, buildApprovedMessage, buildRejectedMessage, buildErrorMessage };
