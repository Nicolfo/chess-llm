// Minimal HTTP clients for the two supported provider APIs.
// Raw fetch (no SDKs) so any compatible endpoint works via baseUrl:
// OpenRouter, Ollama, LM Studio, vLLM, Azure-style proxies, etc.
// Every call is recorded as a Langfuse generation (a no-op when tracing is disabled).
import { startActiveObservation } from '@langfuse/tracing';
import { Agent, fetch } from 'undici';

export class LlmError extends Error {}

// Non-streaming completions send no response headers until the whole answer (including
// reasoning) is generated. undici's default 300 s headers/body timeouts would cut long
// reasoning runs short, so disable them and rely on the per-request AbortSignal timeout.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/**
 * @param llm      entry from config.llms
 * @param system   system prompt
 * @param messages [{ role: 'user' | 'assistant', content: string }]
 * @param options  timeoutMs; name of the generation in the trace; metadata for it
 * @returns the assistant's text reply
 */
export async function chat(llm, system, messages, { timeoutMs = 120_000, name = 'llm-call', metadata = {} } = {}) {
  const call = llm.provider === 'anthropic' ? anthropicChat : openaiChat;
  const modelParameters = {};
  if (llm.maxTokens !== undefined || llm.provider === 'anthropic') modelParameters.max_tokens = llm.maxTokens ?? 4096;
  if (llm.temperature !== undefined) modelParameters.temperature = llm.temperature;
  for (const [key, value] of Object.entries(llm.extraBody)) {
    if (typeof value === 'string' || typeof value === 'number') modelParameters[key] = value;
  }

  return startActiveObservation(
    name,
    async (generation) => {
      generation.update({
        model: llm.model,
        modelParameters,
        input: [{ role: 'system', content: system }, ...messages],
        metadata: { ...metadata, llmId: llm.id, provider: llm.provider },
      });
      try {
        const result = await call(llm, system, messages, AbortSignal.timeout(timeoutMs));
        generation.update({
          model: result.model ?? llm.model, // provider-reported id, so pricing matches dated snapshots
          usageDetails: result.usage,
          output: {
            role: 'assistant',
            content: result.text,
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          },
          metadata: { finishReason: result.finishReason },
        });
        return result.text;
      } catch (err) {
        const error = toLlmError(llm, err, timeoutMs);
        generation.update({ level: 'ERROR', statusMessage: error.message });
        throw error;
      }
    },
    { asType: 'generation' },
  );
}

function toLlmError(llm, err, timeoutMs) {
  if (err instanceof LlmError) return err;
  if (err.name === 'TimeoutError') return new LlmError(`${llm.name}: request timed out after ${timeoutMs} ms`);
  const code = err.cause?.code ? ` (${err.cause.code})` : '';
  return new LlmError(`${llm.name}: ${err.message}${code}`);
}

async function anthropicChat(llm, system, messages, signal) {
  const url = llm.baseUrl.endsWith('/v1') ? `${llm.baseUrl}/messages` : `${llm.baseUrl}/v1/messages`;
  const body = {
    model: llm.model,
    max_tokens: llm.maxTokens ?? 4096,
    system,
    messages,
  };
  if (llm.temperature !== undefined) body.temperature = llm.temperature;

  const data = await postJson(llm, url, body, {
    'x-api-key': llm.apiKey,
    'anthropic-version': '2023-06-01',
  }, signal);

  const blocks = data.content ?? [];
  const text = blocks
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
  const reasoning = blocks
    .filter((block) => block.type === 'thinking')
    .map((block) => block.thinking)
    .join('\n')
    .trim();
  if (!text) throw new LlmError(`${llm.name}: empty response (stop_reason: ${data.stop_reason ?? 'unknown'})`);
  return { text, reasoning, model: data.model, usage: anthropicUsage(data.usage), finishReason: data.stop_reason };
}

async function openaiChat(llm, system, messages, signal) {
  const url = `${llm.baseUrl}/chat/completions`;
  const body = {
    model: llm.model,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  if (llm.maxTokens !== undefined) body.max_completion_tokens = llm.maxTokens;
  if (llm.temperature !== undefined) body.temperature = llm.temperature;

  const headers = {};
  if (llm.apiKey) headers.authorization = `Bearer ${llm.apiKey}`;
  const data = await postJson(llm, url, body, headers, signal);

  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const content = message.content;
  const text = (Array.isArray(content) ? content.map((p) => p.text ?? '').join('\n') : content ?? '').trim();
  // DeepSeek / Kimi return reasoning_content, OpenRouter-style gateways return reasoning
  const reasoning = (message.reasoning_content ?? message.reasoning ?? '').trim();
  if (!text) throw new LlmError(`${llm.name}: empty response (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
  return { text, reasoning, model: data.model, usage: openaiUsage(data.usage), finishReason: choice?.finish_reason };
}

// Langfuse usage buckets are mutually exclusive: `input` must not include cached tokens
// and `output` must not include reasoning tokens.

function anthropicUsage(u) {
  if (!u) return undefined;
  // Anthropic's input_tokens already excludes cache reads/writes.
  return compact({
    input: u.input_tokens,
    output: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
  });
}

function openaiUsage(u) {
  if (!u) return undefined;
  // OpenAI-style counts are inclusive. DeepSeek reports cache hits as prompt_cache_hit_tokens.
  const cached = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0;
  let reasoning = u.completion_tokens_details?.reasoning_tokens ?? 0;
  let output = u.completion_tokens;
  // Gemini's OpenAI-compatible endpoint leaves thinking out of completion_tokens (and has no
  // reasoning_tokens) but counts it in total_tokens: the gap is the hidden, billed thinking.
  const hidden = (u.total_tokens ?? 0) - (u.prompt_tokens ?? 0) - (u.completion_tokens ?? 0);
  if (!reasoning && hidden > 0 && output !== undefined) {
    reasoning = hidden;
    output += hidden;
  }
  return compact({
    input: u.prompt_tokens !== undefined ? u.prompt_tokens - cached : undefined,
    input_cached_tokens: cached || undefined,
    output: output !== undefined ? output - reasoning : undefined,
    output_reasoning_tokens: reasoning || undefined,
  });
}

function compact(obj) {
  const out = Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'number'));
  return Object.keys(out).length ? out : undefined;
}

async function postJson(llm, url, body, headers, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers, ...llm.headers },
    body: JSON.stringify({ ...body, ...llm.extraBody }),
    signal,
    dispatcher,
  });
  const raw = await res.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LlmError(`${llm.name}: HTTP ${res.status}, non-JSON response: ${raw.slice(0, 300)}`);
  }
  if (!res.ok) {
    const msg = data?.error?.message ?? data?.message ?? raw.slice(0, 300);
    throw new LlmError(`${llm.name}: HTTP ${res.status} - ${msg}`);
  }
  return data;
}
