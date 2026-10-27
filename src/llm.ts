// Minimal HTTP clients for the two supported provider APIs.
// Raw fetch (no SDKs) so any compatible endpoint works via baseUrl:
// OpenRouter, Ollama, LM Studio, vLLM, Azure-style proxies, etc.
// Every call is recorded as a Langfuse generation (a no-op when tracing is disabled).
import { startActiveObservation } from '@langfuse/tracing';
import { Agent, fetch } from 'undici';
import type { JsonObject, Llm } from './config.ts';

export class LlmError extends Error {}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatOptions {
  timeoutMs?: number;
  name?: string;
  metadata?: Record<string, unknown>;
}

/** Langfuse usage buckets, e.g. { input, output, output_reasoning_tokens }. */
type Usage = Record<string, number>;

interface ChatResult {
  text: string;
  reasoning: string;
  model?: string;
  usage?: Usage;
  finishReason?: string | null;
  budgetExceeded?: boolean;
}

// The parts of the provider responses that are used here.
interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
interface AnthropicResponse {
  content?: { type: string; text?: string; thinking?: string }[];
  model?: string;
  stop_reason?: string;
  usage?: AnthropicUsage;
}
interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  prompt_cache_hit_tokens?: number; // DeepSeek
  completion_tokens_details?: { reasoning_tokens?: number };
}
interface OpenAiMessage {
  content?: string | { text?: string }[] | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
}
interface OpenAiResponse {
  model?: string;
  choices?: { message?: OpenAiMessage; finish_reason?: string | null }[];
  usage?: OpenAiUsage;
}
interface OpenAiChunk {
  model?: string;
  error?: { message?: string };
  usage?: OpenAiUsage;
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
    usage?: OpenAiUsage; // Moonshot
  }[];
}

// Non-streaming completions send no response headers until the whole answer (including
// reasoning) is generated. undici's default 300 s headers/body timeouts would cut long
// reasoning runs short, so disable them and rely on the per-request AbortSignal timeout.
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

/**
 * @param llm      entry from config.llms
 * @param system   system prompt
 * @param messages the conversation so far
 * @param options  timeoutMs; name of the generation in the trace; metadata for it
 * @returns the assistant's text reply
 */
export async function chat(
  llm: Llm,
  system: string,
  messages: ChatMessage[],
  { timeoutMs = 120_000, name = 'llm-call', metadata = {} }: ChatOptions = {},
): Promise<string> {
  const signal = AbortSignal.timeout(timeoutMs);
  const result = await generate(llm, system, messages, signal, timeoutMs, name, metadata);
  if (!result.budgetExceeded) return result.text;

  // The thinking ran past llm.thinkingBudget and was cut off. Ask again in Fast mode (thinking
  // off), handing over the analysis so far, so the model answers right away.
  const fastMode = Object.keys(llm.fastModeBody).length > 0;
  const followUp = await generate(
    {
      ...llm,
      extraBody: { ...llm.extraBody, ...llm.fastModeBody },
      thinkingBudget: fastMode ? undefined : llm.thinkingBudget,
    },
    system,
    [...messages, { role: 'user', content: budgetFollowUpPrompt(result.reasoning) }],
    signal,
    timeoutMs,
    name,
    { ...metadata, afterThinkingBudget: true },
  );
  if (followUp.budgetExceeded) throw new LlmError(`${llm.name}: exceeded its thinking budget twice`);
  return followUp.text;
}

function budgetFollowUpPrompt(reasoning: string): string {
  return [
    'You ran out of thinking time for this move. This is your analysis so far:',
    '"""',
    reasoning,
    '"""',
    '',
    'Do not analyse any further. Based on this analysis, answer now with the "REASON: ..." and "MOVE: ..." lines.',
  ].join('\n');
}

/** One request to the provider, recorded as a Langfuse generation. */
async function generate(
  llm: Llm,
  system: string,
  messages: ChatMessage[],
  signal: AbortSignal,
  timeoutMs: number,
  name: string,
  metadata: Record<string, unknown>,
): Promise<ChatResult> {
  const call = llm.provider === 'anthropic' ? anthropicChat : openaiChat;
  const modelParameters: Record<string, string | number> = {};
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
        const result = await call(llm, system, messages, signal);
        generation.update({
          model: result.model ?? llm.model, // provider-reported id, so pricing matches dated snapshots
          usageDetails: result.usage,
          output: {
            role: 'assistant',
            content: result.text,
            ...(result.reasoning ? { reasoning_content: result.reasoning } : {}),
          },
          metadata: { finishReason: result.finishReason },
          ...(result.budgetExceeded
            ? {
                level: 'WARNING' as const,
                statusMessage: `Thinking budget of ${llm.thinkingBudget} tokens used up: stopped, asking for the move without thinking`,
              }
            : {}),
        });
        return result;
      } catch (err) {
        const error = toLlmError(llm, err, timeoutMs);
        generation.update({ level: 'ERROR', statusMessage: error.message });
        throw error;
      }
    },
    { asType: 'generation' },
  );
}

function toLlmError(llm: Llm, err: unknown, timeoutMs: number): LlmError {
  if (err instanceof LlmError) return err;
  const e = err as Error & { cause?: { code?: string } };
  if (e.name === 'TimeoutError') return new LlmError(`${llm.name}: request timed out after ${timeoutMs} ms`);
  const code = e.cause?.code ? ` (${e.cause.code})` : '';
  return new LlmError(`${llm.name}: ${e.message}${code}`);
}

async function anthropicChat(llm: Llm, system: string, messages: ChatMessage[], signal: AbortSignal): Promise<ChatResult> {
  const url = llm.baseUrl.endsWith('/v1') ? `${llm.baseUrl}/messages` : `${llm.baseUrl}/v1/messages`;
  const body: JsonObject = {
    model: llm.model,
    max_tokens: llm.maxTokens ?? 4096,
    system,
    messages,
  };
  if (llm.temperature !== undefined) body.temperature = llm.temperature;

  const data = await postJson<AnthropicResponse>(llm, url, body, {
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

async function openaiChat(llm: Llm, system: string, messages: ChatMessage[], signal: AbortSignal): Promise<ChatResult> {
  const url = `${llm.baseUrl}/chat/completions`;
  const body: JsonObject = {
    model: llm.model,
    messages: [{ role: 'system', content: system }, ...messages],
  };
  if (llm.maxTokens !== undefined) body.max_completion_tokens = llm.maxTokens;
  if (llm.temperature !== undefined) body.temperature = llm.temperature;

  const headers: Record<string, string> = {};
  if (llm.apiKey) headers.authorization = `Bearer ${llm.apiKey}`;
  if (llm.thinkingBudget) return openaiStreamChat(llm, llm.thinkingBudget, url, body, headers, signal);
  const data = await postJson<OpenAiResponse>(llm, url, body, headers, signal);

  const choice = data.choices?.[0];
  const message = choice?.message ?? {};
  const content = message.content;
  const text = (Array.isArray(content) ? content.map((p) => p.text ?? '').join('\n') : content ?? '').trim();
  // DeepSeek / Kimi return reasoning_content, OpenRouter-style gateways return reasoning
  const reasoning = (message.reasoning_content ?? message.reasoning ?? '').trim();
  if (!text) throw new LlmError(`${llm.name}: empty response (finish_reason: ${choice?.finish_reason ?? 'unknown'})`);
  return { text, reasoning, model: data.model, usage: openaiUsage(data.usage), finishReason: choice?.finish_reason };
}

// Streams the answer so the thinking can be cut off once it passes `budget` tokens
// (counted as streamed reasoning chunks, about one token each). A cut-off answer comes back
// with budgetExceeded and the reasoning so far.
async function openaiStreamChat(
  llm: Llm,
  budget: number,
  url: string,
  body: JsonObject,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<ChatResult> {
  const stop = new AbortController();
  const res = await post(
    llm,
    url,
    { ...body, stream: true, stream_options: { include_usage: true } },
    headers,
    AbortSignal.any([signal, stop.signal]),
  );
  if (!res.body) throw new LlmError(`${llm.name}: empty response body`);
  const decoder = new TextDecoder();
  let pending = '';
  let text = '';
  let reasoning = '';
  let reasoningChunks = 0;
  let usage: OpenAiUsage | undefined;
  let model: string | undefined;
  let finishReason: string | null | undefined;
  try {
    read: for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
        if (!payload || payload === '[DONE]') continue;
        const data = JSON.parse(payload) as OpenAiChunk;
        if (data.error) throw new LlmError(`${llm.name}: ${data.error.message ?? JSON.stringify(data.error)}`);
        const choice = data.choices?.[0];
        const thought = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning ?? '';
        if (thought) {
          reasoning += thought;
          reasoningChunks++;
        }
        text += choice?.delta?.content ?? '';
        model ??= data.model;
        finishReason = choice?.finish_reason ?? finishReason;
        usage = data.usage ?? choice?.usage ?? usage; // Moonshot puts it on the choice
        if (reasoningChunks > budget && !text.trim()) break read;
      }
    }
  } finally {
    stop.abort(); // closes the connection when we stop early; a no-op once the stream ended
  }

  if (reasoningChunks > budget && !text.trim()) {
    return {
      budgetExceeded: true,
      text: '',
      reasoning: reasoning.trim(),
      model,
      usage: { output_reasoning_tokens: reasoningChunks }, // estimate: the provider never sends usage
      finishReason: 'thinking_budget',
    };
  }
  text = text.trim();
  if (!text) throw new LlmError(`${llm.name}: empty response (finish_reason: ${finishReason ?? 'unknown'})`);
  return { text, reasoning: reasoning.trim(), model, usage: openaiUsage(usage), finishReason };
}

// Langfuse usage buckets are mutually exclusive: `input` must not include cached tokens
// and `output` must not include reasoning tokens.

function anthropicUsage(u: AnthropicUsage | undefined): Usage | undefined {
  if (!u) return undefined;
  // Anthropic's input_tokens already excludes cache reads/writes.
  return compact({
    input: u.input_tokens,
    output: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens,
    cache_creation_input_tokens: u.cache_creation_input_tokens,
  });
}

function openaiUsage(u: OpenAiUsage | undefined): Usage | undefined {
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

function compact(obj: Record<string, number | undefined>): Usage | undefined {
  const out = Object.fromEntries(Object.entries(obj).filter(([, v]) => typeof v === 'number')) as Usage;
  return Object.keys(out).length ? out : undefined;
}

async function postJson<T>(llm: Llm, url: string, body: JsonObject, headers: Record<string, string>, signal: AbortSignal): Promise<T> {
  const res = await post(llm, url, body, headers, signal);
  const raw = await res.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new LlmError(`${llm.name}: HTTP ${res.status}, non-JSON response: ${raw.slice(0, 300)}`);
  }
}

/** POSTs the request; throws LlmError on an HTTP error status. */
async function post(llm: Llm, url: string, body: JsonObject, headers: Record<string, string>, signal: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers, ...llm.headers },
    body: JSON.stringify({ ...body, ...llm.extraBody }),
    signal,
    dispatcher,
  });
  if (res.ok) return res;
  const raw = await res.text();
  let data: { error?: { message?: string }; message?: string };
  try {
    data = JSON.parse(raw);
  } catch {
    throw new LlmError(`${llm.name}: HTTP ${res.status}, non-JSON response: ${raw.slice(0, 300)}`);
  }
  const msg = data?.error?.message ?? data?.message ?? raw.slice(0, 300);
  throw new LlmError(`${llm.name}: HTTP ${res.status} - ${msg}`);
}
