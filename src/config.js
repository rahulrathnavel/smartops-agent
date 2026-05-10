'use strict';

// ---------------------------------------------------------------------------
// Centralized configuration loader.
// Every external credential and tunable knob lives here.
// Values come from environment variables (injected via K8s secrets/configmap).
// ---------------------------------------------------------------------------

const config = {
  // -- Agent identity --
  agentName: 'smartops-agent',
  port: parseInt(process.env.PORT || '3000', 10),

  // -- NVIDIA NIM (LLM + Embeddings) --
  nvidia: {
    apiKey: process.env.NVIDIA_API_KEY || '',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'qwen/qwen3-coder-480b-a35b-instruct',
    embeddingModel: 'nvidia/nv-embedqa-e5-v5',
    maxTokens: 4096,
    temperature: 0.3,
    topP: 0.8,
    rpmLimit: 40,
  },

  // -- Pinecone (Vector DB) --
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY || '',
    indexName: 'smartops-knowledge',
    namespace: 'ammazone-codebase',
    dimension: 1024,
  },

  // -- GitHub --
  github: {
    token: process.env.GITHUB_TOKEN || '',
    owner: 'rahulrathnavel',
    repo: 'ammazone',
    webhookSecret: process.env.GITHUB_WEBHOOK_SECRET || '',
    defaultBranch: 'main',
  },

  // -- Slack --
  slack: {
    botToken: process.env.SLACK_BOT_TOKEN || '',
    signingSecret: process.env.SLACK_SIGNING_SECRET || '',
    channelId: process.env.SLACK_CHANNEL_ID || '',
  },

  // -- AWS --
  aws: {
    region: process.env.AWS_REGION || 'ap-south-1',
    s3Bucket: process.env.AUDIT_S3_BUCKET || 'smartops-audit-295284356306',
    cloudwatchLogGroup: process.env.AUDIT_LOG_GROUP || '/smartops/agent/audit',
    cloudwatchLogStream: process.env.AUDIT_LOG_STREAM || 'agent-main',
    sqsQueueUrl: process.env.SQS_QUEUE_URL || '',
    eksLogGroup: process.env.EKS_LOG_GROUP || '/aws/eks/ammazone-eks/containers',
  },

  // -- Detection tuning --
  detection: {
    pollIntervalMs: 30_000,       // Check logs every 30 seconds
    cooldownMs: 15 * 60_000,      // 15 minute dedup window per error signature
    errorPatterns: [
      '"level":"error"',
      'statusCode":500',
      'Internal server error',
      'UnhandledPromiseRejection',
      'TypeError:',
      'ReferenceError:',
      'Cannot read propert',
      'ECONNREFUSED',
      'MongoServerError',
    ],
  },
};

// ---------------------------------------------------------------------------
// Validate required config on startup
// ---------------------------------------------------------------------------
function validateConfig() {
  const missing = [];
  if (!config.nvidia.apiKey) missing.push('NVIDIA_API_KEY');
  if (!config.slack.botToken) missing.push('SLACK_BOT_TOKEN');
  if (!config.slack.signingSecret) missing.push('SLACK_SIGNING_SECRET');
  if (!config.slack.channelId) missing.push('SLACK_CHANNEL_ID');
  if (!config.github.token) missing.push('GITHUB_TOKEN');
  if (!config.pinecone.apiKey) missing.push('PINECONE_API_KEY');

  if (missing.length > 0) {
    console.error(`[CONFIG] Missing required environment variables: ${missing.join(', ')}`);
    console.error('[CONFIG] The agent will start but some features will be unavailable.');
  }
  return missing;
}

module.exports = { config, validateConfig };
