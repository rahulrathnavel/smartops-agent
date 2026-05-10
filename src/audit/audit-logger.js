'use strict';

const {
  CloudWatchLogsClient,
  CreateLogStreamCommand,
  PutLogEventsCommand,
  DescribeLogStreamsCommand,
} = require('@aws-sdk/client-cloudwatch-logs');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// Audit Logger -- writes structured JSON to CloudWatch Logs.
// Every agent action is recorded for full transparency.
// ---------------------------------------------------------------------------

let cwClient = null;
let sequenceToken = undefined;
let streamReady = false;

function getClient() {
  if (!cwClient) {
    cwClient = new CloudWatchLogsClient({ region: config.aws.region });
  }
  return cwClient;
}

// ---------------------------------------------------------------------------
// Ensure the log stream exists (creates on first use).
// ---------------------------------------------------------------------------
async function ensureLogStream() {
  if (streamReady) return;
  const client = getClient();

  try {
    const desc = await client.send(new DescribeLogStreamsCommand({
      logGroupName: config.aws.cloudwatchLogGroup,
      logStreamNamePrefix: config.aws.cloudwatchLogStream,
    }));

    const stream = desc.logStreams?.find(
      (s) => s.logStreamName === config.aws.cloudwatchLogStream
    );

    if (stream) {
      sequenceToken = stream.uploadSequenceToken;
    } else {
      await client.send(new CreateLogStreamCommand({
        logGroupName: config.aws.cloudwatchLogGroup,
        logStreamName: config.aws.cloudwatchLogStream,
      }));
    }
    streamReady = true;
  } catch (err) {
    if (err.name === 'ResourceAlreadyExistsException') {
      streamReady = true;
      return;
    }
    console.error('[AUDIT] Failed to ensure log stream:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Log an audit event.
// ---------------------------------------------------------------------------
async function logAuditEvent({
  incidentId,
  actionType,
  inputPayload = null,
  outputPayload = null,
  decision = null,
  actor = 'agent',
  metadata = {},
}) {
  const entry = {
    incident_id: incidentId,
    timestamp: new Date().toISOString(),
    action_type: actionType,
    input_payload: inputPayload,
    output_payload: outputPayload,
    decision,
    actor,
    ...metadata,
  };

  // Always print to stdout (visible via kubectl logs)
  console.log(`[AUDIT] ${JSON.stringify(entry)}`);

  try {
    await ensureLogStream();
    const client = getClient();

    const params = {
      logGroupName: config.aws.cloudwatchLogGroup,
      logStreamName: config.aws.cloudwatchLogStream,
      logEvents: [{ timestamp: Date.now(), message: JSON.stringify(entry) }],
    };

    if (sequenceToken) {
      params.sequenceToken = sequenceToken;
    }

    const result = await client.send(new PutLogEventsCommand(params));
    sequenceToken = result.nextSequenceToken;
  } catch (err) {
    // If sequence token is stale, retry once
    if (err.name === 'InvalidSequenceTokenException') {
      sequenceToken = err.expectedSequenceToken;
      try {
        const client = getClient();
        const result = await client.send(new PutLogEventsCommand({
          logGroupName: config.aws.cloudwatchLogGroup,
          logStreamName: config.aws.cloudwatchLogStream,
          logEvents: [{ timestamp: Date.now(), message: JSON.stringify(entry) }],
          sequenceToken,
        }));
        sequenceToken = result.nextSequenceToken;
      } catch (retryErr) {
        console.error('[AUDIT] Retry failed:', retryErr.message);
      }
    } else {
      console.error('[AUDIT] CloudWatch write failed:', err.message);
    }
  }
}

module.exports = { logAuditEvent };
