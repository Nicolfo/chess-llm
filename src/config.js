import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVIDERS = new Set(['anthropic', 'openai']);

// "${ENV_VAR}" anywhere in a string is replaced by process.env.ENV_VAR,
// so API keys can stay out of the config file.
function expandEnv(value) {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, name) => process.env[name] ?? '');
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandEnv(v)]));
  }
  return value;
}

function resolveConfigPath() {
  if (process.env.CHESS_LLM_CONFIG) return path.resolve(process.env.CHESS_LLM_CONFIG);
  const local = path.join(ROOT, 'config.json');
  if (fs.existsSync(local)) return local;
  console.warn('[config] config.json not found, falling back to config.example.json');
  return path.join(ROOT, 'config.example.json');
}

export function loadConfig() {
  const file = resolveConfigPath();
  const raw = expandEnv(JSON.parse(fs.readFileSync(file, 'utf8')));

  const llms = (raw.llms ?? []).map((llm, i) => {
    const id = llm.id ?? `llm-${i}`;
    if (!PROVIDERS.has(llm.provider)) {
      throw new Error(`[config] llms[${i}] (${id}): provider must be one of ${[...PROVIDERS].join(', ')}`);
    }
    if (!llm.model) throw new Error(`[config] llms[${i}] (${id}): "model" is required`);
    return {
      id,
      name: llm.name ?? llm.model,
      provider: llm.provider,
      baseUrl: (llm.baseUrl ?? defaultBaseUrl(llm.provider)).replace(/\/+$/, ''),
      apiKey: llm.apiKey ?? '',
      model: llm.model,
      maxTokens: llm.maxTokens,
      temperature: llm.temperature,
      showLegalMoves: llm.showLegalMoves ?? raw.showLegalMoves ?? false,
      headers: llm.headers ?? {},
      extraBody: llm.extraBody ?? {}, // merged into the request body, e.g. { "reasoning_effort": "low" }
      timeoutMs: llm.timeoutMs, // overrides requestTimeoutMs for this model
      description: llm.description ?? '',
      icon: llm.icon ?? guessIcon(llm),
    };
  });

  const ids = new Set();
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

// Avatar for the menu and player bars: a file in public/icons (name without .svg).
// Set "icon" in the config to override (an icon name or an image URL), or "" for none.
const ICON_PATTERNS = [
  ['claude', /claude|anthropic/],
  ['gemini', /gemini|googleapis/],
  ['deepseek', /deepseek/],
  ['kimi', /kimi|moonshot/],
  ['openai', /\bgpt|openai|\bo\d/],
];

function guessIcon(llm) {
  const haystack = `${llm.model} ${llm.name ?? ''} ${llm.baseUrl ?? ''}`.toLowerCase();
  return ICON_PATTERNS.find(([, re]) => re.test(haystack))?.[0] ?? '';
}

function defaultBaseUrl(provider) {
  return provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1';
}
