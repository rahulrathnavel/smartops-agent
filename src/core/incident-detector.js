'use strict';

const {
  CloudWatchLogsClient,
  FilterLogEventsCommand,
} = require('@aws-sdk/client-cloudwatch-logs');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// Incident Detector.
// Two modes:
//   1. Log tail: Polls CloudWatch Logs for error patterns (500s, exceptions)
//   2. Alarm consumer: Reads SQS messages from CloudWatch Alarm SNS topic
// ---------------------------------------------------------------------------

let cwClient = null;
let sqsClient = null;
let lastLogTimestamp = Date.now() - 60_000; // Start from 1 minute ago
const seenSignatures = new Map(); // signature -> timestamp (for dedup)

function getCwClient() {
  if (!cwClient) cwClient = new CloudWatchLogsClient({ region: config.aws.region });
  return cwClient;
}

function getSqsClient() {
  if (!sqsClient) sqsClient = new SQSClient({ region: config.aws.region });
  return sqsClient;
}

// ---------------------------------------------------------------------------
// Generate a hash-like signature for deduplication.
// ---------------------------------------------------------------------------
function errorSignature(service, message) {
  const normalized = message.replace(/\d+/g, 'N').substring(0, 100);
  return `${service}:${normalized}`;
}

// ---------------------------------------------------------------------------
// Check if this error has been seen recently (within cooldown window).
// ---------------------------------------------------------------------------
function isDuplicate(signature) {
  const lastSeen = seenSignatures.get(signature);
  if (lastSeen && Date.now() - lastSeen < config.detection.cooldownMs) {
    return true;
  }
  seenSignatures.set(signature, Date.now());

  // Clean old entries
  for (const [key, ts] of seenSignatures) {
    if (Date.now() - ts > config.detection.cooldownMs * 2) {
      seenSignatures.delete(key);
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Poll CloudWatch Logs for error patterns.
// Returns array of detected incidents.
// ---------------------------------------------------------------------------
async function pollLogs() {
  const incidents = [];

  try {
    const client = getCwClient();
    const filterPattern = config.detection.errorPatterns
      .map((p) => `"${p}"`)
      .join(' || ');

    const result = await client.send(new FilterLogEventsCommand({
      logGroupName: config.aws.eksLogGroup,
      startTime: lastLogTimestamp,
      endTime: Date.now(),
      limit: 50,
    }));

    if (result.events && result.events.length > 0) {
      lastLogTimestamp = Math.max(...result.events.map((e) => e.timestamp || 0)) + 1;

      for (const event of result.events) {
        const msg = event.message || '';

        // Check if message matches any error pattern
        const isError = config.detection.errorPatterns.some((p) => msg.includes(p));
        if (!isError) continue;

        // Extract service name from log group/stream
        const service = event.logStreamName?.split('/')[0] || 'unknown';
        const sig = errorSignature(service, msg);

        if (!isDuplicate(sig)) {
          incidents.push({
            source: 'log_tail',
            service,
            errorLog: msg,
            timestamp: new Date(event.timestamp || Date.now()).toISOString(),
            logStream: event.logStreamName,
          });
        }
      }
    }
  } catch (err) {
    // Log group may not exist yet if e-commerce app is not deployed
    if (err.name !== 'ResourceNotFoundException') {
      console.error('[DETECTOR] Log poll failed:', err.message);
    }
  }

  return incidents;
}

// ---------------------------------------------------------------------------
// Poll SQS for CloudWatch Alarm messages.
// Returns array of detected incidents.
// ---------------------------------------------------------------------------
async function pollAlarms() {
  const incidents = [];

  if (!config.aws.sqsQueueUrl) return incidents;

  try {
    const client = getSqsClient();
    const result = await client.send(new ReceiveMessageCommand({
      QueueUrl: config.aws.sqsQueueUrl,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 1,
    }));

    for (const msg of result.Messages || []) {
      try {
        const body = JSON.parse(msg.Body);
        const snsMessage = JSON.parse(body.Message || '{}');

        incidents.push({
          source: 'cloudwatch_alarm',
          service: snsMessage.AlarmName || 'unknown',
          errorLog: JSON.stringify(snsMessage),
          timestamp: new Date().toISOString(),
          alarmState: snsMessage.NewStateValue,
        });

        // Delete processed message
        await client.send(new DeleteMessageCommand({
          QueueUrl: config.aws.sqsQueueUrl,
          ReceiptHandle: msg.ReceiptHandle,
        }));
      } catch (parseErr) {
        console.error('[DETECTOR] Failed to parse SQS message:', parseErr.message);
      }
    }
  } catch (err) {
    if (err.name !== 'QueueDoesNotExist') {
      console.error('[DETECTOR] SQS poll failed:', err.message);
    }
  }

  return incidents;
}

// ---------------------------------------------------------------------------
// Start the detection loop.
// Calls the onIncident callback for each new incident.
// ---------------------------------------------------------------------------
function startDetectionLoop(onIncident) {
  console.log(`[DETECTOR] Starting detection loop (interval: ${config.detection.pollIntervalMs}ms)`);

  async function tick() {
    try {
      const logIncidents = await pollLogs();
      const alarmIncidents = await pollAlarms();
      const all = [...logIncidents, ...alarmIncidents];

      for (const incident of all) {
        console.log(`[DETECTOR] New incident from ${incident.source}: ${incident.service}`);
        onIncident(incident);
      }
    } catch (err) {
      console.error('[DETECTOR] Tick failed:', err.message);
    }
  }

  // Run immediately, then on interval
  tick();
  return setInterval(tick, config.detection.pollIntervalMs);
}

module.exports = { startDetectionLoop, pollLogs, pollAlarms };
