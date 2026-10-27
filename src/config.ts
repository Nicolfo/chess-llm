import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = new Set(['anthropic', 'openai', 'engine']);

// Stockfish's UCI_Elo and Skill Level ranges
const ELO_RANGE = [1320, 3190];
const SKILL_RANGE = [0, 20];

export type Provider = 'anthropic' | 'openai' | 'engine';
export type JsonObject = Record<string, unknown>;

/** An entry of "llms" in config.json, as written. */
interface LlmEntry {
  id?: string;
  name?: string;
  provider: Provider;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  elo?: number;
  skillLevel?: number;
  movetimeMs?: number;
  maxTokens?: number;
  temperature?: number;
  showLegalMoves?: boolean;
  headers?: Record<string, string>;
  extraBody?: JsonObject;
  fastModeBody?: JsonObject;
  thinkingBudget?: number;
  timeoutMs?: number;
  description?: string;
  icon?: string;
}

interface ConfigFile {
  port?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  showLegalMoves?: boolean;
  llms?: LlmEntry[];
}

/** A configured LLM with defaults applied. */
export interface Llm {
  id: string;
  name: string;
  provider: Provider;
  baseUrl: string;
  apiKey: string;
  model: string;
  // provider "engine" only: Stockfish's strength and thinking time per move
  elo?: number;
  skillLevel?: number;
  movetimeMs?: number;
  maxTokens?: number;
  temperature?: number;
  showLegalMoves: boolean;
  headers: Record<string, string>;
  extraBody: JsonObject;
  fastModeBody: JsonObject;
  thinkingBudget?: number;
  timeoutMs?: number;
  description: string;
  icon: string;
}

export interface Config {
  file: string;
  port: number;
  maxAttempts: number;
  requestTimeoutMs: number;
  llms: Llm[];
}

// "${ENV_VAR}" anywhere in a string is replaced by process.env.ENV_VAR,
// so API keys can stay out of the config file.
function expandEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name: string) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}

function resolveConfigPath(): string {
  if (process.env.CHESS_LLM_CONFIG) return path.resolve(process.env.CHESS_LLM_CONFIG);
  const local = path.join(ROOT, 'config.json');
  if (fs.existsSync(local)) return local;
  console.warn('[config] config.json not found, falling back to config.example.json');
  return path.join(ROOT, 'config.example.json');
}

export function loadConfig(): Config {
  const file = resolveConfigPath();
  const raw = expandEnv(JSON.parse(fs.readFileSync(file, 'utf8'))) as ConfigFile;

  const llms = (raw.llms ?? []).map((llm, i): Llm => {
    const id = llm.id ?? `llm-${i}`;
    if (!PROVIDERS.has(llm.provider)) {
      throw new Error(`[config] llms[${i}] (${id}): provider must be one of ${[...PROVIDERS].join(', ')}`);
    }
    const engine = llm.provider === 'engine';
    if (!llm.model && !engine) throw new Error(`[config] llms[${i}] (${id}): "model" is required`);
    if (id.endsWith(FAST_SUFFIX)) throw new Error(`[config] llms[${i}] (${id}): ids must not end with "${FAST_SUFFIX}"`);
    if (engine) checkEngine(llm, `[config] llms[${i}] (${id})`);
    const model = llm.model ?? engineModel(llm);
    return {
      id,
      name: llm.name ?? model,
      provider: llm.provider,
      baseUrl: (llm.baseUrl ?? defaultBaseUrl(llm.provider)).replace(/\/+$/, ''),
      apiKey: llm.apiKey ?? '',
      model,
      elo: engine ? llm.elo : undefined,
      skillLevel: engine ? llm.skillLevel : undefined,
      movetimeMs: engine ? llm.movetimeMs : undefined,
      maxTokens: llm.maxTokens,
      temperature: llm.temperature,
      showLegalMoves: llm.showLegalMoves ?? raw.showLegalMoves ?? false,
      headers: llm.headers ?? {},
      extraBody: llm.extraBody ?? {}, // merged into the request body, e.g. { "reasoning_effort": "low" }
      // Merged into the request in Fast mode: thinking off, or as low as the model allows,
      // e.g. { "thinking": { "type": "disabled" } }. Fast mode is offered only when it is set.
      fastModeBody: llm.fastModeBody ?? {},
      // OpenAI-style providers only: stop thinking after this many tokens and ask for the move
      // again in Fast mode
      thinkingBudget: llm.provider === 'openai' ? llm.thinkingBudget : undefined,
      timeoutMs: llm.timeoutMs, // overrides requestTimeoutMs for this model
      description: llm.description ?? '',
      icon: llm.icon ?? guessIcon(llm),
    };
  });

  const ids = new Set<string>();
  for (const llm of llms) {
    if (ids.has(llm.id)) throw new Error(`[config] duplicate llm id "${llm.id}"`);
    ids.add(llm.id);
  }

  return {
    file,
    port: Number(process.env.PORT ?? raw.port ?? 3000),
    maxAttempts: raw.maxAttempts ?? 5,
    requestTimeoutMs: raw.requestTimeoutMs ?? 600_000,
    llms,
  };
}

const FAST_SUFFIX = ':fast';

export const hasFastMode = (llm: Llm): boolean => Object.keys(llm.fastModeBody).length > 0;

/** The configured LLM with this id; "<id>:fast" is that LLM in Fast mode. */
export function resolveLlm(llms: Llm[], id: unknown): Llm | undefined {
  const fast = typeof id === 'string' && id.endsWith(FAST_SUFFIX);
  const llm = llms.find((l) => l.id === (fast ? id.slice(0, -FAST_SUFFIX.length) : id));
  if (!llm || !fast) return llm;
  if (!hasFastMode(llm)) return undefined;
  return {
    ...llm,
    id: id as string,
    name: `${llm.name} (fast)`,
    extraBody: { ...llm.extraBody, ...llm.fastModeBody },
    thinkingBudget: undefined,
  };
}

// Avatar for the menu and player bars: a file in public/icons (name without .svg).
// Set "icon" in the config to override (an icon name or an image URL), or "" for none.
const ICON_PATTERNS: [string, RegExp][] = [
  ['claude', /claude|anthropic/],
  ['gemini', /gemini|googleapis/],
  ['deepseek', /deepseek/],
  ['kimi', /kimi|moonshot/],
  ['openai', /\bgpt|openai|\bo\d/],
];

function guessIcon(llm: LlmEntry): string {
  if (llm.provider === 'engine') return 'stockfish';
  const haystack = `${llm.model} ${llm.name ?? ''} ${llm.baseUrl ?? ''}`.toLowerCase();
  return ICON_PATTERNS.find(([, re]) => re.test(haystack))?.[0] ?? '';
}

function defaultBaseUrl(provider: Provider): string {
  if (provider === 'engine') return '';
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}

function checkEngine(llm: LlmEntry, where: string): void {
  const inRange = (value: number | undefined, [min, max]: number[]) =>
    value === undefined || (Number.isInteger(value) && value >= min && value <= max);
  if (llm.elo !== undefined && llm.skillLevel !== undefined) throw new Error(`${where}: set "elo" or "skillLevel", not both`);
  if (!inRange(llm.elo, ELO_RANGE)) throw new Error(`${where}: "elo" must be a whole number from ${ELO_RANGE.join(' to ')}`);
  if (!inRange(llm.skillLevel, SKILL_RANGE)) {
    throw new Error(`${where}: "skillLevel" must be a whole number from ${SKILL_RANGE.join(' to ')}`);
  }
  if (!inRange(llm.movetimeMs, [10, 60_000])) throw new Error(`${where}: "movetimeMs" must be a whole number from 10 to 60000`);
}

/** Shown under the name in the lobby, e.g. "Stockfish 19 · Elo 1500". */
function engineModel(llm: LlmEntry): string {
  if (llm.elo !== undefined) return `Stockfish 19 · Elo ${llm.elo}`;
  if (llm.skillLevel !== undefined) return `Stockfish 19 · skill level ${llm.skillLevel}`;
  return 'Stockfish 19 · full strength';
}
