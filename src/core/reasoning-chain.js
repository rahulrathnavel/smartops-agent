'use strict';

const { chatCompletionWithRetry } = require('../integrations/llm-client');
const { generateQueryEmbedding } = require('../integrations/embedding-client');
const { queryRelevantCode } = require('../integrations/pinecone-client');
const github = require('../integrations/github-client');
const { logAuditEvent } = require('../audit/audit-logger');
const { storePayload } = require('../audit/s3-store');

// ---------------------------------------------------------------------------
// Three-step LLM reasoning chain.
//
// Step 1 -- DIAGNOSE:  Error logs -> root cause analysis (structured JSON)
// Step 2 -- LOCATE:    Query vector DB + fetch git diffs for context
// Step 3 -- FIX:       Generate unified code diff to resolve the issue
//
// Each step is independently audited with full LLM prompt/response in S3.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Step 1: Diagnose the error
// ---------------------------------------------------------------------------
async function diagnose(incidentId, errorLogs) {
  const systemPrompt = `You are an expert SRE and Node.js developer. Analyze the following error logs from a microservices e-commerce platform running on AWS EKS with Azure Cosmos DB.

Your task: Identify the root cause and affected files.

Respond ONLY with valid JSON in this exact schema:
{
  "errorType": "string (e.g., TypeError, MongoServerError, ECONNREFUSED)",
  "rootCause": "string (1-2 sentence explanation)",
  "affectedFiles": ["array of file paths relative to repo root"],
  "severity": "CRITICAL | HIGH | MEDIUM | LOW",
  "service": "string (e.g., catalog-service, api-gateway)"
}

Do NOT include any text outside the JSON object. No markdown fences. No explanation.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Error logs:\n\n${errorLogs}` },
  ];

  // Audit: log the prompt
  const promptUri = await storePayload(incidentId, 'step1', 'prompt', messages);
  await logAuditEvent({ incidentId, actionType: 'LLM_PROMPT_SENT', inputPayload: promptUri });

  const response = await chatCompletionWithRetry(messages, { temperature: 0.2 });

  // Audit: log the response
  const responseUri = await storePayload(incidentId, 'step1', 'response', response);
  await logAuditEvent({ incidentId, actionType: 'LLM_RESPONSE_RECEIVED', outputPayload: responseUri });

  // Parse the JSON response
  try {
    const cleaned = response.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[CHAIN] Step 1 JSON parse failed, using fallback:', err.message);
    return {
      errorType: 'Unknown',
      rootCause: response.content.substring(0, 200),
      affectedFiles: [],
      severity: 'MEDIUM',
      service: 'unknown',
    };
  }
}

// ---------------------------------------------------------------------------
// Step 2: Locate relevant code and context
// ---------------------------------------------------------------------------
async function locateContext(incidentId, diagnosis) {
  // Build a query combining error type, root cause, and affected files
  const queryText = [
    `Error: ${diagnosis.errorType}`,
    `Root cause: ${diagnosis.rootCause}`,
    `Service: ${diagnosis.service}`,
    `Files: ${diagnosis.affectedFiles.join(', ')}`,
  ].join('\n');

  // Query Pinecone for relevant code chunks
  const queryEmbedding = await generateQueryEmbedding(queryText);
  const relevantChunks = await queryRelevantCode(queryEmbedding, 10);

  await logAuditEvent({
    incidentId,
    actionType: 'VECTOR_QUERY',
    metadata: { matchCount: relevantChunks.length, topScore: relevantChunks[0]?.score },
  });

  // Fetch recent git diffs
  let diffs = [];
  try {
    diffs = await github.getRecentDiffs(5);
    await logAuditEvent({ incidentId, actionType: 'DIFF_FETCHED', metadata: { commitCount: diffs.length } });
  } catch (err) {
    console.error('[CHAIN] Failed to fetch diffs:', err.message);
  }

  // Also try to fetch the actual file content for affected files
  const fileContents = [];
  for (const filePath of diagnosis.affectedFiles.slice(0, 3)) {
    try {
      const content = await github.getFileContent(filePath);
      fileContents.push({ path: filePath, content });
    } catch (err) {
      console.warn(`[CHAIN] Could not fetch ${filePath}:`, err.message);
    }
  }

  return { relevantChunks, diffs, fileContents };
}

// ---------------------------------------------------------------------------
// Step 3: Generate the code fix
// ---------------------------------------------------------------------------
async function generateFix(incidentId, diagnosis, context, humanSuggestion = null) {
  const systemPrompt = `You are an expert Node.js/Express developer fixing a production bug.

RULES:
1. Output ONLY valid JSON with the fix. No markdown fences. No explanation outside JSON.
2. Each file fix must include the COMPLETE updated file content (not just a diff).
3. Be conservative. Only change what is necessary to fix the bug.
4. Preserve all existing comments and code structure.

Response schema:
{
  "summary": "string (1-2 sentence fix description)",
  "files": [
    {
      "path": "string (file path relative to repo root)",
      "content": "string (complete file content after fix)",
      "explanation": "string (what changed and why)"
    }
  ],
  "commitMessage": "string (conventional commit message, e.g., fix(catalog): add null check for Product.find)"
}`;

  // Build context for the LLM
  const contextParts = [];

  // Diagnosis
  contextParts.push(`## Diagnosis\n${JSON.stringify(diagnosis, null, 2)}`);

  // Current file contents
  if (context.fileContents.length > 0) {
    contextParts.push('## Current File Contents');
    for (const f of context.fileContents) {
      contextParts.push(`### ${f.path}\n\`\`\`javascript\n${f.content}\n\`\`\``);
    }
  }

  // Relevant code from vector DB
  if (context.relevantChunks.length > 0) {
    contextParts.push('## Related Code (from knowledge base)');
    for (const chunk of context.relevantChunks.slice(0, 5)) {
      contextParts.push(`### ${chunk.filePath} (score: ${chunk.score?.toFixed(3)})\n${chunk.content}`);
    }
  }

  // Recent diffs
  if (context.diffs.length > 0) {
    contextParts.push('## Recent Git Commits');
    for (const d of context.diffs.slice(0, 3)) {
      const patches = d.files.map((f) => `${f.filename}: ${f.patch?.substring(0, 300)}`).join('\n');
      contextParts.push(`### ${d.sha.substring(0, 7)} - ${d.message}\n${patches}`);
    }
  }

  // Human suggestion (if any)
  if (humanSuggestion) {
    contextParts.push(`## Human SRE Suggestion\n${humanSuggestion}`);
  }

  const userMessage = contextParts.join('\n\n');

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];

  // Audit: log prompt
  const promptUri = await storePayload(incidentId, 'step3', 'prompt', messages);
  await logAuditEvent({ incidentId, actionType: 'LLM_PROMPT_SENT', inputPayload: promptUri });

  const response = await chatCompletionWithRetry(messages, { maxTokens: 4096, temperature: 0.2 });

  // Audit: log response
  const responseUri = await storePayload(incidentId, 'step3', 'response', response);
  await logAuditEvent({ incidentId, actionType: 'LLM_RESPONSE_RECEIVED', outputPayload: responseUri });

  // Parse
  try {
    const cleaned = response.content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    console.error('[CHAIN] Step 3 JSON parse failed:', err.message);
    return {
      summary: 'LLM response could not be parsed as JSON',
      files: [],
      commitMessage: 'fix: automated fix attempt',
      rawResponse: response.content.substring(0, 1000),
    };
  }
}

module.exports = { diagnose, locateContext, generateFix };
