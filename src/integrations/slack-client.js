'use strict';

const { WebClient } = require('@slack/web-api');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// Slack Web API client.
// Posts Block Kit messages, reads thread replies, updates messages.
// ---------------------------------------------------------------------------

let client = null;

function getClient() {
  if (!client) {
    client = new WebClient(config.slack.botToken);
  }
  return client;
}

// ---------------------------------------------------------------------------
// Post an incident Block Kit message to the configured channel.
// Returns { channel, ts } for future updates.
// ---------------------------------------------------------------------------
async function postIncidentMessage(blocks, text) {
  const slack = getClient();
  const result = await slack.chat.postMessage({
    channel: config.slack.channelId,
    blocks,
    text: text || 'New incident detected by SmartOps Agent',
  });
  return { channel: result.channel, ts: result.ts };
}

// ---------------------------------------------------------------------------
// Update an existing message (e.g., after approval).
// ---------------------------------------------------------------------------
async function updateMessage(channel, ts, blocks, text) {
  const slack = getClient();
  await slack.chat.update({ channel, ts, blocks, text: text || 'Incident updated' });
}

// ---------------------------------------------------------------------------
// Post a reply in a thread.
// ---------------------------------------------------------------------------
async function postThreadReply(channel, threadTs, text) {
  const slack = getClient();
  await slack.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
  });
}

// ---------------------------------------------------------------------------
// Read thread replies (for @mention suggestions).
// ---------------------------------------------------------------------------
async function getThreadReplies(channel, threadTs) {
  const slack = getClient();
  const result = await slack.conversations.replies({
    channel,
    ts: threadTs,
    limit: 50,
  });
  return result.messages || [];
}

module.exports = {
  postIncidentMessage,
  updateMessage,
  postThreadReply,
  getThreadReplies,
};
