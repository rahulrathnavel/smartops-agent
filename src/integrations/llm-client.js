'use strict';

const OpenAI = require('openai');
const { config } = require('../config');

// ---------------------------------------------------------------------------
// NVIDIA NIM LLM client (OpenAI-compatible).
// Model: qwen/qwen3-coder-480b-a35b-instruct (480B MoE, 262K context)
// Rate limit: 40 RPM on free tier.
// ---------------------------------------------------------------------------

let client = null;
let lastRequestTime = 0;
const MIN_INTERVAL_MS = Math.ceil(60_000 / config.nvidia.rpmLimit); // ~1500ms

function getClient() {
  if (!client) {
    client = new OpenAI({
      baseURL: config.nvidia.baseUrl,
      apiKey: config.nvidia.apiKey,
    });
  }
  return client;
}

// Rate-limit aware delay
async function throttle() {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
  }
  lastRequestTime = Date.now();
}

// ---------------------------------------------------------------------------
// Send a chat completion request (non-streaming, for structured output).
// Returns the full response text.
// ---------------------------------------------------------------------------
async function chatCompletion(messages, { maxTokens, temperature } = {}) {
  await throttle();
  const c = getClient();

  const response = await c.chat.completions.create({
    model: config.nvidia.model,
    messages,
    temperature: temperature ?? config.nvidia.temperature,
    top_p: config.nvidia.topP,
    max_tokens: maxTokens ?? config.nvidia.maxTokens,
    stream: false,
  });

  return {
    content: response.choices[0]?.message?.content || '',
    usage: response.usage || {},
    model: response.model,
  };
}

// ---------------------------------------------------------------------------
// Send a chat completion with automatic retry (up to 3 attempts).
// ---------------------------------------------------------------------------
async function chatCompletionWithRetry(messages, opts = {}, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await chatCompletion(messages, opts);
    } catch (err) {
      const isRateLimit = err.status === 429;
      const isServerError = err.status >= 500;

      if ((isRateLimit || isServerError) && attempt < maxRetries) {
        const backoff = Math.min(2000 * Math.pow(2, attempt), 30_000);
        console.warn(`[LLM] Attempt ${attempt} failed (${err.status}), retrying in ${backoff}ms...`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
}

module.exports = { chatCompletion, chatCompletionWithRetry };
