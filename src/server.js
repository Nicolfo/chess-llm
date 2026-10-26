import { shutdownTracing } from './instrumentation.js'; // first: sets up tracing before other modules load
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { authMiddleware } from './auth.js';
import { loadConfig } from './config.js';
import { Game, GameError } from './game.js';
import { LlmError } from './llm.js';
import { GameStore } from './store.js';

const config = loadConfig();
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const store = new GameStore(process.env.DATA_DIR ?? path.join(ROOT, 'data'));
const games = new Map(); // games in use, loaded from the store on demand
const MEMORY_TTL_MS = 6 * 60 * 60 * 1000; // idle games leave memory (they stay on disk)
const RETENTION_MS = Number(process.env.GAME_RETENTION_DAYS ?? 30) * 24 * 60 * 60 * 1000;

const PUBLIC_DIR = path.join(ROOT, 'public');

const app = express();
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));
app.get('/healthz', (req, res) => res.json({ ok: true }));
// No-op unless APP_PASSWORD is set; must come before the static files and the API.
app.use(authMiddleware({
  password: process.env.APP_PASSWORD,
  publicDir: PUBLIC_DIR,
  secureCookie: process.env.COOKIE_SECURE === 'true',
}));
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Browser-side analysis: Stockfish (lite single-threaded WASM build) and chess.js for the eval bar.
const require = createRequire(import.meta.url);
const STOCKFISH_DIR = path.join(path.dirname(require.resolve('stockfish/package.json')), 'bin');
const ENGINE_FILES = { 'stockfish.js': 'stockfish-19-lite-single.js', 'stockfish.wasm': 'stockfish-19-lite-single.wasm' };
app.get('/engine/:file', (req, res, next) => {
  const file = ENGINE_FILES[req.params.file];
  if (!file) return next();
  res.sendFile(path.join(STOCKFISH_DIR, file), { maxAge: '7d' });
});
app.get('/vendor/chess.js', (req, res) => {
  res.sendFile(path.join(path.dirname(require.resolve('chess.js')), '..', 'esm', 'chess.js'), { maxAge: '7d' });
});

// API keys and base URLs never leave the server.
app.get('/api/llms', (req, res) => {
  res.json(config.llms.map(({ id, name, provider, model, description, icon }) => ({ id, name, provider, model, description, icon })));
});

// { mode: 'human', llmId, color: 'white' | 'black' | 'random' }  play against an LLM
// { mode: 'watch', whiteLlmId, blackLlmId }                       watch two LLMs play each other
app.post('/api/games', (req, res) => {
  const { mode = 'human', llmId, color = 'random', whiteLlmId, blackLlmId } = req.body ?? {};
  let white;
  let black;
  if (mode === 'watch') {
    white = findLlm(whiteLlmId);
    black = findLlm(blackLlmId);
  } else if (mode === 'human') {
    const llm = findLlm(llmId);
    if (!['white', 'black', 'random'].includes(color)) throw new GameError('color must be white, black or random');
    const side = color === 'random' ? (Math.random() < 0.5 ? 'white' : 'black') : color;
    [white, black] = side === 'white' ? [null, llm] : [llm, null];
  } else {
    throw new GameError('mode must be human or watch');
  }

  const game = new Game({
    white,
    black,
    maxAttempts: config.maxAttempts,
    requestTimeoutMs: config.requestTimeoutMs,
  });
  games.set(game.id, game);
  store.save(game);
  res.status(201).json(game);
});

app.get('/api/games/:id', (req, res) => {
  res.json(getGame(req.params.id));
});

app.post('/api/games/:id/move', (req, res) => {
  const game = getGame(req.params.id);
  const { from, to, promotion } = req.body ?? {};
  game.playerMove({ from, to, promotion });
  store.save(game);
  res.json(game);
});

app.post('/api/games/:id/llm-move', async (req, res) => {
  const game = getGame(req.params.id);
  try {
    await game.llmMove();
  } finally {
    store.save(game); // also keeps failed attempts, so the log survives a restart
  }
  res.json(game);
});

app.post('/api/games/:id/resign', (req, res) => {
  const game = getGame(req.params.id);
  game.resign();
  store.save(game);
  res.json(game);
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err instanceof GameError) return res.status(err.status).json({ error: err.message });
  if (err instanceof LlmError) {
    console.warn('[llm]', err.message);
    return res.status(502).json({ error: err.message });
  }
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// "true", a hop count ("1") or a list of trusted proxy addresses; unset = don't trust X-Forwarded-*.
function parseTrustProxy(value) {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  return /^d+$/.test(value) ? Number(value) : value;
}

function findLlm(id) {
  const llm = config.llms.find((l) => l.id === id);
  if (!llm) throw new GameError(`Unknown LLM "${id}"`, 404);
  return llm;
}

function getGame(id) {
  let game = games.get(id);
  if (!game) {
    const saved = store.load(id);
    if (!saved) throw new GameError('Game not found', 404);
    game = Game.restore(saved, config);
    games.set(id, game);
  }
  return game;
}

setInterval(() => {
  const cutoff = Date.now() - MEMORY_TTL_MS;
  for (const [id, game] of games) {
    if (game.touchedAt < cutoff && !game.thinking) games.delete(id);
  }
}, 10 * 60 * 1000).unref();

if (RETENTION_MS > 0) {
  store.prune(RETENTION_MS);
  setInterval(() => store.prune(RETENTION_MS), 6 * 60 * 60 * 1000).unref();
}

const server = app.listen(config.port, () => {
  console.log(`Chess LLM running at http://localhost:${config.port}`);
  console.log(`Games: ${store.dir} (${store.count()} saved)`);
  console.log(`Config: ${config.file} (${config.llms.length} LLMs: ${config.llms.map((l) => l.name).join(', ')})`);
  for (const llm of config.llms) {
    if (!llm.apiKey) console.warn(`[config] "${llm.name}" has no apiKey (fine for local servers, otherwise set it)`);
  }
});

// Flush buffered traces before exiting.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    server.close();
    await shutdownTracing().catch((err) => console.error('[langfuse] shutdown failed:', err.message));
    process.exit(0);
  });
}
