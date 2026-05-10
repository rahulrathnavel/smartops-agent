'use strict';

const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// S3 payload store for large LLM prompts/responses.
// Keeps CloudWatch Logs entries lean (they contain S3 URIs instead).
// ---------------------------------------------------------------------------

let s3 = null;

function getClient() {
  if (!s3) {
    s3 = new S3Client({ region: config.aws.region });
  }
  return s3;
}

// ---------------------------------------------------------------------------
// Store a JSON payload in S3.
// Returns the S3 URI (s3://bucket/key).
// ---------------------------------------------------------------------------
async function storePayload(incidentId, step, type, data) {
  const key = `incidents/${incidentId}/${step}-${type}.json`;
  const body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  try {
    await getClient().send(new PutObjectCommand({
      Bucket: config.aws.s3Bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
    }));

    const uri = `s3://${config.aws.s3Bucket}/${key}`;
    return uri;
  } catch (err) {
    console.error(`[S3] Failed to store ${key}:`, err.message);
    return null;
  }
}

module.exports = { storePayload };
