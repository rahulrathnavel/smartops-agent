'use strict';

const k8s = require('@kubernetes/client-node');
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// Incident Detector.
// Primary mode: Kubernetes API log tailing (reads pod logs directly)
// Secondary mode: SQS alarm consumer (CloudWatch Alarm SNS topic)
// ---------------------------------------------------------------------------

let coreApi = null;
let sqsClient = null;
let lastPollTime = new Date(Date.now() - 60_000); // Start from 1 minute ago
const seenSignatures = new Map(); // signature -> timestamp (for dedup)

function getK8sApi() {
  if (!coreApi) {
    const kc = new k8s.KubeConfig();
    kc.loadFromCluster(); // Uses in-cluster service account
    coreApi = kc.makeApiClient(k8s.CoreV1Api);
  }
  return coreApi;
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
// Poll Kubernetes pod logs for error patterns.
// Reads logs directly from pods in the target namespace via K8s API.
// ---------------------------------------------------------------------------
async function pollKubeLogs() {
  const incidents = [];
  const api = getK8sApi();
  const targetNamespace = config.detection.targetNamespace || 'ammazone';

  try {
    // List all pods in the target namespace
    const podList = await api.listNamespacedPod({ namespace: targetNamespace });
    const pods = podList.items || [];

    for (const pod of pods) {
      const podName = pod.metadata?.name || 'unknown';
      const service = pod.metadata?.labels?.app || podName.split('-')[0] || 'unknown';

      // Skip non-running pods
      if (pod.status?.phase !== 'Running') continue;

      try {
        // Read logs since last poll (sinceSeconds for safety, sinceTime for precision)
        const sinceSeconds = Math.max(
          Math.ceil((Date.now() - lastPollTime.getTime()) / 1000),
          30
        );

        const logResponse = await api.readNamespacedPodLog({
          name: podName,
          namespace: targetNamespace,
          sinceSeconds,
          tailLines: 100,
        });

        const logText = typeof logResponse === 'string' ? logResponse : (logResponse?.body || '');
        if (!logText) continue;

        const lines = logText.split('\n');

        for (const line of lines) {
          if (!line.trim()) continue;

          // Check if line matches any error pattern
          const isError = config.detection.errorPatterns.some((p) => line.includes(p));
          if (!isError) continue;

          const sig = errorSignature(service, line);
          if (!isDuplicate(sig)) {
            console.log(`[DETECTOR] Error found in ${service}: ${line.substring(0, 120)}...`);
            incidents.push({
              source: 'kube_logs',
              service,
              errorLog: line,
              timestamp: new Date().toISOString(),
              podName,
              namespace: targetNamespace,
            });
          }
        }
      } catch (logErr) {
        // Pod might be initializing, skip it
        if (!logErr.message?.includes('is waiting to start')) {
          console.warn(`[DETECTOR] Could not read logs for ${podName}: ${logErr.message?.substring(0, 80)}`);
        }
      }
    }
  } catch (err) {
    console.error('[DETECTOR] K8s log poll failed:', err.message?.substring(0, 100));
  }

  lastPollTime = new Date();
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
  console.log(`[DETECTOR] Monitoring pods in namespace: ${config.detection.targetNamespace || 'ammazone'}`);

  async function tick() {
    try {
      const logIncidents = await pollKubeLogs();
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

module.exports = { startDetectionLoop, pollKubeLogs, pollAlarms };
