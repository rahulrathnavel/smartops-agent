'use strict';

const { v4: uuidv4 } = require('uuid');
const { diagnose, locateContext, generateFix } = require('./reasoning-chain');
const { logAuditEvent } = require('../audit/audit-logger');
const github = require('../integrations/github-client');
const slack = require('../integrations/slack-client');
const blockKit = require('../slack/block-kit');

// ---------------------------------------------------------------------------
// Incident Manager -- State machine for incident lifecycle.
//
// States: DETECTED -> DIAGNOSING -> FIX_PROPOSED -> AWAITING_APPROVAL
//         -> APPROVED -> COMMITTED -> PR_MERGED -> DEPLOYED
//         -> REJECTED (terminal)
//         -> SUGGESTION_RECEIVED -> (loops back to FIX_PROPOSED)
// ---------------------------------------------------------------------------

const incidents = new Map(); // incidentId -> incident state

function generateIncidentId() {
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const seq = String(incidents.size + 1).padStart(3, '0');
  return `INC-${date}-${seq}`;
}

// ---------------------------------------------------------------------------
// Handle a newly detected incident.
// Runs the full reasoning chain and posts to Slack.
// ---------------------------------------------------------------------------
async function handleNewIncident(rawIncident) {
  const incidentId = generateIncidentId();

  const state = {
    id: incidentId,
    status: 'DETECTED',
    raw: rawIncident,
    diagnosis: null,
    context: null,
    fix: null,
    slackMessage: null,
    prNumber: null,
    branchName: null,
    createdAt: new Date().toISOString(),
  };

  incidents.set(incidentId, state);

  await logAuditEvent({
    incidentId,
    actionType: 'ERROR_DETECTED',
    inputPayload: JSON.stringify(rawIncident).substring(0, 500),
    metadata: { source: rawIncident.source, service: rawIncident.service },
  });

  try {
    // Step 1: Diagnose
    state.status = 'DIAGNOSING';
    console.log(`[INCIDENT] ${incidentId} -- Step 1: Diagnosing...`);
    state.diagnosis = await diagnose(incidentId, rawIncident.errorLog);
    console.log(`[INCIDENT] ${incidentId} -- Diagnosis: ${state.diagnosis.rootCause}`);

    // Step 2: Locate context
    console.log(`[INCIDENT] ${incidentId} -- Step 2: Locating context...`);
    state.context = await locateContext(incidentId, state.diagnosis);

    // Step 3: Generate fix
    console.log(`[INCIDENT] ${incidentId} -- Step 3: Generating fix...`);
    state.fix = await generateFix(incidentId, state.diagnosis, state.context);
    state.status = 'FIX_PROPOSED';

    // Post to Slack
    const blocks = blockKit.buildIncidentMessage(incidentId, state.diagnosis, state.fix);
    state.slackMessage = await slack.postIncidentMessage(blocks, `Incident ${incidentId}: ${state.diagnosis.rootCause}`);
    await logAuditEvent({ incidentId, actionType: 'SLACK_MESSAGE_SENT' });

    state.status = 'AWAITING_APPROVAL';
    console.log(`[INCIDENT] ${incidentId} -- Posted to Slack, awaiting approval.`);
  } catch (err) {
    console.error(`[INCIDENT] ${incidentId} -- Pipeline failed:`, err.message);
    state.status = 'ERROR';
    state.error = err.message;

    // Still try to notify Slack about the failure
    try {
      const errorBlocks = blockKit.buildErrorMessage(incidentId, rawIncident, err.message);
      await slack.postIncidentMessage(errorBlocks, `Agent error for ${incidentId}`);
    } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Handle Slack approval.
// Creates branch, commits fix, opens PR, auto-merges.
// ---------------------------------------------------------------------------
async function handleApproval(incidentId, userId) {
  const state = incidents.get(incidentId);
  if (!state || !state.fix || state.fix.files.length === 0) {
    console.error(`[INCIDENT] ${incidentId} -- Cannot approve: no fix available`);
    return;
  }

  await logAuditEvent({
    incidentId,
    actionType: 'SLACK_APPROVAL_RECEIVED',
    decision: 'approved',
    actor: userId,
  });

  state.status = 'APPROVED';

  try {
    // Create branch
    const branchName = `smartops/fix-${incidentId.toLowerCase()}`;
    state.branchName = branchName;
    const mainSha = await github.getBranchSha();
    await github.createBranch(branchName, mainSha);

    // Commit files
    const commitSha = await github.commitFiles(
      branchName,
      state.fix.files.map((f) => ({ path: f.path, content: f.content })),
      state.fix.commitMessage || `fix: ${state.diagnosis.rootCause}`
    );

    await logAuditEvent({ incidentId, actionType: 'COMMIT_PUSHED', metadata: { sha: commitSha, branch: branchName } });
    state.status = 'COMMITTED';

    // Create PR
    const pr = await github.createPR(
      branchName,
      `[SmartOps] ${state.fix.commitMessage || incidentId}`,
      buildPRBody(state)
    );
    state.prNumber = pr.number;
    await logAuditEvent({ incidentId, actionType: 'PR_CREATED', metadata: { prNumber: pr.number } });

    // Auto-merge
    await new Promise((r) => setTimeout(r, 2000)); // Wait for GitHub checks
    await github.mergePR(pr.number);
    await logAuditEvent({ incidentId, actionType: 'PR_MERGED', metadata: { prNumber: pr.number } });
    state.status = 'PR_MERGED';

    // Update Slack message
    if (state.slackMessage) {
      const blocks = blockKit.buildApprovedMessage(incidentId, state.diagnosis, pr.number);
      await slack.updateMessage(state.slackMessage.channel, state.slackMessage.ts, blocks);
    }

    await slack.postThreadReply(
      state.slackMessage.channel,
      state.slackMessage.ts,
      `Fix committed (${commitSha.substring(0, 7)}), PR #${pr.number} merged. GitHub Actions pipeline will redeploy.`
    );

    await logAuditEvent({ incidentId, actionType: 'PIPELINE_TRIGGERED' });
    state.status = 'DEPLOYED';
    console.log(`[INCIDENT] ${incidentId} -- Fix deployed via PR #${pr.number}`);
  } catch (err) {
    console.error(`[INCIDENT] ${incidentId} -- Approval pipeline failed:`, err.message);
    if (state.slackMessage) {
      await slack.postThreadReply(state.slackMessage.channel, state.slackMessage.ts, `Deployment failed: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Handle Slack rejection.
// ---------------------------------------------------------------------------
async function handleRejection(incidentId, userId) {
  const state = incidents.get(incidentId);
  if (!state) return;

  await logAuditEvent({ incidentId, actionType: 'SLACK_APPROVAL_RECEIVED', decision: 'rejected', actor: userId });
  state.status = 'REJECTED';

  if (state.slackMessage) {
    const blocks = blockKit.buildRejectedMessage(incidentId, state.diagnosis);
    await slack.updateMessage(state.slackMessage.channel, state.slackMessage.ts, blocks);
  }
  console.log(`[INCIDENT] ${incidentId} -- Rejected by ${userId}`);
}

// ---------------------------------------------------------------------------
// Handle suggestion -- re-run fix generation with human feedback.
// ---------------------------------------------------------------------------
async function handleSuggestion(incidentId, suggestion, userId) {
  const state = incidents.get(incidentId);
  if (!state) return;

  await logAuditEvent({
    incidentId,
    actionType: 'HUMAN_SUGGESTION_RECEIVED',
    inputPayload: suggestion.substring(0, 500),
    actor: userId,
  });

  try {
    // Re-run Step 3 with the suggestion
    state.fix = await generateFix(incidentId, state.diagnosis, state.context, suggestion);
    state.status = 'FIX_PROPOSED';

    // Post updated fix in Slack thread
    const blocks = blockKit.buildIncidentMessage(incidentId, state.diagnosis, state.fix);
    state.slackMessage = await slack.postIncidentMessage(blocks, `Revised fix for ${incidentId}`);
    state.status = 'AWAITING_APPROVAL';
  } catch (err) {
    console.error(`[INCIDENT] ${incidentId} -- Suggestion re-run failed:`, err.message);
    await slack.postThreadReply(state.slackMessage?.channel, state.slackMessage?.ts, `Failed to generate revised fix: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Get an incident by ID.
// ---------------------------------------------------------------------------
function getIncident(id) {
  return incidents.get(id);
}

function buildPRBody(state) {
  return [
    `## SmartOps Automated Fix`,
    `**Incident:** ${state.id}`,
    `**Service:** ${state.diagnosis.service}`,
    `**Severity:** ${state.diagnosis.severity}`,
    `**Root Cause:** ${state.diagnosis.rootCause}`,
    ``,
    `### Fix Summary`,
    state.fix.summary || 'Automated fix generated by SmartOps Agent',
    ``,
    `### Files Changed`,
    ...state.fix.files.map((f) => `- \`${f.path}\`: ${f.explanation || 'Updated'}`),
    ``,
    `---`,
    `*This PR was generated by SmartOps Agent and approved by an SRE via Slack.*`,
  ].join('\n');
}

module.exports = { handleNewIncident, handleApproval, handleRejection, handleSuggestion, getIncident };
