// Chess LLM front-end. The server is the source of truth for the game;
// this file renders it, turns clicks / drags into move requests, and
// asks the server for an LLM move whenever an LLM is to play.

import { CLASSES, Engine, classify, formatEval, moveAccuracy, winChance } from './engine.js';

const FILES = 'abcdefgh';
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const COLOR_NAME = { w: 'White', b: 'Black' };
const POLL_MS = 1000;
const WATCH_DELAY_MS = 900; // pause between moves in LLM vs LLM so they can be followed
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const PV_PLIES = 10; // length of the best line shown

const $ = (sel) => document.querySelector(sel);

const state = {
  llms: [],
  mode: load('mode', 'human'), // lobby tab: 'human' | 'watch'
  selectedLlm: load('llm', null),
  selectedColor: load('color', 'random'),
  watchWhite: load('watchWhite', null),
  watchBlack: load('watchBlack', null),
  game: null,
  orientation: 'w',
  selected: null, // square currently selected by the player
  drag: null, // { from, ghost, wasSelected, hover }
  animatedKey: null, // last move that has already been animated
  llmBusy: null, // id of the game whose LLM request is in flight
  pollTimer: null,
  advanceTimer: null,
  paused: false, // LLM vs LLM only; saved with the game on the server
  pauseRequests: 0, // pause/resume calls in flight: until they finish, the local value wins
  resultShownFor: null,
  logOpen: new Set(), // open <details> in the LLM log, survives re-renders
  logSignature: '',
  soundOn: load('sound', true),
  showReasons: load('reasons', false), // vs-human games; always on when watching
  showEngine: load('engine', true), // eval bar etc.: live when watching, after the game when playing
  analysisRequested: new Set(), // FENs already sent to the engine for the current game
};

const engine = new Engine();
let engineError = null;

// ---------------------------------------------------------------- utils

function load(key, fallback) {
  try {
    const v = localStorage.getItem(`chess-llm:${key}`);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(`chess-llm:${key}`, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences just won't persist */
  }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function pieceSvg(code, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 40 40"><use href="pieces.svg#${code}"/></svg>`;
}

function initial(name) {
  return (name.match(/[A-Za-z0-9]/)?.[0] ?? '?').toUpperCase();
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // password protection is on and the session is missing or expired
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.hash)}`;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error ?? `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

let toastTimer;
function toast(msg, ms = 2500) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

// ---------------------------------------------------------------- sound

let audioCtx;
function playSound(kind) {
  if (!state.soundOn) return;
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime;
    const tones = { move: [[520, 0]], capture: [[700, 0], [420, 0.05]], check: [[880, 0], [660, 0.08]], end: [[523, 0], [659, 0.12], [784, 0.24]] }[kind];
    for (const [freq, delay] of tones) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(freq, t + delay);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.5, t + delay + 0.09);
      gain.gain.setValueAtTime(0.0001, t + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, t + delay + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.12);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(t + delay);
      osc.stop(t + delay + 0.13);
    }
  } catch {
    /* audio not available */
  }
}

// ---------------------------------------------------------------- game helpers

const other = (c) => (c === 'w' ? 'b' : 'w');
const isWatch = (g) => g.mode === 'watch';
const isLlm = (g, color) => !!g.players[color];
const isPlayerTurn = (g) => g.mode === 'human' && !g.result && g.turn === g.playerColor;
const llmBusy = () => !!state.game && state.llmBusy === state.game.id;
const moveKey = (g) => (g.lastMove ? `${g.history.length}:${g.lastMove.from}${g.lastMove.to}` : null);
const reasonsVisible = (g) => isWatch(g) || state.showReasons;

/** Display name for a side: "You", "Claude", or "Claude (White)" when watching. */
function label(g, color) {
  if (!isLlm(g, color)) return 'You';
  return isWatch(g) ? `${g.players[color].name} (${COLOR_NAME[color]})` : g.players[color].name;
}

function avatarHtml(g, color) {
  const p = g.players[color];
  return p ? llmAvatar(p) : '<div class="avatar you">You</div>';
}

/** Model logo on a tile when the LLM has an icon, otherwise its initial on a provider-colored tile. */
function llmAvatar(llm) {
  if (!llm.icon) return `<div class="avatar ${esc(llm.provider)}">${esc(initial(llm.name))}</div>`;
  const src = /[/.]/.test(llm.icon) ? llm.icon : `icons/${llm.icon}.svg`;
  return `<div class="avatar logo" title="${esc(llm.name)}"><img src="${esc(src)}" alt=""></div>`;
}

// ---------------------------------------------------------------- routing

async function route() {
  const match = location.hash.match(/^#\/game\/([\w-]+)/);
  if (!match) return showLobby();
  const id = match[1];
  if (state.game?.id === id) return showGame();
  try {
    const game = await api('GET', `/api/games/${id}`);
    resetGameState(game);
    state.resultShownFor = game.result ? game.id : null; // don't re-pop the modal on reload
    state.animatedKey = moveKey(game);
    showGame();
    sync(game);
  } catch {
    toast('Game not found (the server may have restarted)');
    location.hash = '#/';
  }
}

window.addEventListener('hashchange', route);

function resetGameState(game) {
  stopPolling();
  clearTimeout(state.advanceTimer);
  state.game = game;
  state.llmBusy = null;
  state.selected = null;
  state.paused = !!game.paused;
  state.orientation = game.playerColor ?? 'w';
  state.animatedKey = null;
  state.resultShownFor = null;
  state.logOpen.clear();
  state.logSignature = '';
  engine.clearQueue();
  state.analysisRequested.clear();
  $('#result-modal').hidden = true;
}

// ---------------------------------------------------------------- lobby

async function showLobby() {
  stopPolling();
  clearTimeout(state.advanceTimer);
  engine.clearQueue();
  state.analysisRequested.clear();
  state.game = null;
  $('#game').hidden = true;
  $('#result-modal').hidden = true;
  $('#lobby').hidden = false;
  if (!state.llms.length) {
    try {
      state.llms = await api('GET', '/api/llms');
    } catch (err) {
      showLobbyError(`Could not load LLM list: ${err.message}`);
    }
  }
  const valid = (id) => state.llms.some((l) => l.id === id);
  const first = state.llms[0]?.id ?? null;
  if (!valid(state.selectedLlm)) state.selectedLlm = first;
  if (!valid(state.watchWhite)) state.watchWhite = first;
  if (!valid(state.watchBlack)) state.watchBlack = state.llms[1]?.id ?? first;
  renderLobby();
}

// Card tag: the model's vendor (several vendors are reached through the OpenAI-compatible API).
const VENDOR = { claude: 'Anthropic', openai: 'OpenAI', gemini: 'Google', kimi: 'Moonshot', deepseek: 'DeepSeek' };

function llmCards(selectedId) {
  if (!state.llms.length) return '<p class="muted">No LLMs configured. Add some to <code>config.json</code>.</p>';
  return state.llms
    .map(
      (l) => `
      <button type="button" class="llm-card ${l.id === selectedId ? 'selected' : ''}" data-id="${esc(l.id)}">
        ${llmAvatar(l)}
        <div class="llm-card-body">
          <div class="llm-card-name">${esc(l.name)}</div>
          <div class="llm-card-meta"><span class="provider-tag">${esc(VENDOR[l.icon] ?? l.provider)}</span> ${esc(l.model)}</div>
          ${l.description ? `<div class="llm-card-desc">${esc(l.description)}</div>` : ''}
        </div>
      </button>`,
    )
    .join('');
}

function renderLobby() {
  const watch = state.mode === 'watch';
  document.querySelectorAll('.mode-tab').forEach((t) => t.classList.toggle('selected', t.dataset.mode === state.mode));
  $('#human-setup').hidden = watch;
  $('#watch-setup').hidden = !watch;
  if (watch) {
    $('#white-list').innerHTML = llmCards(state.watchWhite);
    $('#black-list').innerHTML = llmCards(state.watchBlack);
  } else {
    $('#llm-list').innerHTML = llmCards(state.selectedLlm);
    document.querySelectorAll('.color-btn').forEach((b) => b.classList.toggle('selected', b.dataset.color === state.selectedColor));
  }
  $('#play-btn').textContent = watch ? 'Watch' : 'Play';
  $('#play-btn').disabled = watch ? !(state.watchWhite && state.watchBlack) : !state.selectedLlm;
}

function showLobbyError(msg) {
  const el = $('#lobby-error');
  el.textContent = msg;
  el.hidden = !msg;
}

document.querySelectorAll('.mode-tab').forEach((tab) =>
  tab.addEventListener('click', () => {
    state.mode = tab.dataset.mode;
    save('mode', state.mode);
    renderLobby();
  }),
);

function onCardClick(list, key) {
  $(list).addEventListener('click', (e) => {
    const card = e.target.closest('.llm-card');
    if (!card) return;
    state[key] = card.dataset.id;
    save(key === 'selectedLlm' ? 'llm' : key, state[key]);
    renderLobby();
  });
}
onCardClick('#llm-list', 'selectedLlm');
onCardClick('#white-list', 'watchWhite');
onCardClick('#black-list', 'watchBlack');

$('#llm-list').addEventListener('dblclick', (e) => {
  if (e.target.closest('.llm-card')) startFromLobby();
});

$('#swap-btn').addEventListener('click', () => {
  [state.watchWhite, state.watchBlack] = [state.watchBlack, state.watchWhite];
  save('watchWhite', state.watchWhite);
  save('watchBlack', state.watchBlack);
  renderLobby();
});

document.querySelectorAll('.color-btn').forEach((btn) =>
  btn.addEventListener('click', () => {
    state.selectedColor = btn.dataset.color;
    save('color', state.selectedColor);
    renderLobby();
  }),
);

$('#play-btn').addEventListener('click', startFromLobby);

function startFromLobby() {
  if (state.mode === 'watch') startGame({ mode: 'watch', whiteLlmId: state.watchWhite, blackLlmId: state.watchBlack });
  else startGame({ mode: 'human', llmId: state.selectedLlm, color: state.selectedColor });
}

async function startGame(params) {
  showLobbyError('');
  $('#play-btn').disabled = true;
  try {
    const game = await api('POST', '/api/games', params);
    resetGameState(game); // set before hashchange fires so route() doesn't refetch
    location.hash = `#/game/${game.id}`;
    showGame();
    sync(game);
  } catch (err) {
    showLobbyError(err.message);
    toast(err.message);
  } finally {
    renderLobby();
  }
}

// ---------------------------------------------------------------- game flow

function showGame() {
  $('#lobby').hidden = true;
  $('#game').hidden = false;
}

/** Install a fresh server state, render it, and kick off the LLM if it's its turn. */
function sync(game) {
  if (state.game?.id !== game.id) return; // stale response from a game we left
  const prevKey = state.animatedKey;
  state.game = game;
  if (!state.pauseRequests) state.paused = !!game.paused; // e.g. paused from another tab
  renderGame();

  const key = moveKey(game);
  if (key && key !== prevKey) {
    state.animatedKey = key;
    animateMove(game.lastMove);
    const last = game.history.at(-1);
    playSound(game.result ? 'end' : game.checkSquare ? 'check' : last.captured ? 'capture' : 'move');
  }

  if (game.result) {
    stopPolling();
    if (state.resultShownFor !== game.id) {
      state.resultShownFor = game.id;
      if (!key || key === prevKey) playSound('end');
      setTimeout(showResult, 450);
    }
    return;
  }
  maybeAdvance(key !== prevKey);
}

/** If an LLM is to move, ask it (or wait for a request already running server-side). */
function maybeAdvance(justMoved = false) {
  const g = state.game;
  if (!g || g.result || !isLlm(g, g.turn) || llmBusy()) return;
  if (g.thinking) return startPolling(); // e.g. after a reload, or another tab is driving
  if (g.lastError) return; // wait for the Retry button
  if (isWatch(g)) {
    if (state.paused) return;
    clearTimeout(state.advanceTimer);
    state.advanceTimer = setTimeout(requestLlmMove, justMoved ? WATCH_DELAY_MS : 0);
  } else {
    requestLlmMove();
  }
}

async function requestLlmMove() {
  const game = state.game;
  if (!game || game.result || llmBusy() || !isLlm(game, game.turn)) return;
  state.llmBusy = game.id;
  game.lastError = null;
  renderGame();
  startPolling();
  try {
    const next = await api('POST', `/api/games/${game.id}/llm-move`);
    if (state.llmBusy !== game.id) return; // user left this game meanwhile
    state.llmBusy = null;
    stopPolling();
    sync(next);
  } catch (err) {
    if (state.llmBusy !== game.id) return;
    state.llmBusy = null;
    stopPolling();
    if (err.status === 409) return startPolling(); // already thinking
    // a proxy gave up waiting (e.g. Cloudflare's 100 s limit); the server keeps thinking, so follow it by polling
    if (err.status === 504 || err.status === 524) return startPolling();
    toast(err.message, 5000);
    api('GET', `/api/games/${game.id}`).then(sync, () => {});
  }
}

function startPolling() {
  stopPolling();
  const id = state.game?.id;
  state.pollTimer = setInterval(async () => {
    try {
      const game = await api('GET', `/api/games/${id}`);
      if (state.game?.id !== id) return;
      if (llmBusy()) {
        // the POST is still in flight; only refresh the live log
        state.game.llmTurns = game.llmTurns;
        renderLog();
        renderStatus();
      } else {
        if (!game.thinking) stopPolling();
        sync(game);
      }
    } catch {
      /* transient */
    }
  }, POLL_MS);
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function submitMove(from, to, promotion, { dragged }) {
  const game = state.game;
  const ply = game.history.length + 1;

  // Optimistic update so the move feels instant; the server response corrects
  // anything this doesn't model (castling rook, en passant, ...).
  const [fr, ff] = coords(from);
  const [tr, tf] = coords(to);
  const piece = game.board[fr][ff];
  const captured = game.board[tr][tf];
  game.board[tr][tf] = promotion ? piece[0] + promotion : piece;
  game.board[fr][ff] = null;
  game.lastMove = { from, to };
  game.legalMoves = [];
  game.checkSquare = null;
  game.turn = other(game.turn);
  state.selected = null;
  state.animatedKey = `${ply}:${from}${to}`;
  renderGame();
  if (!dragged) animateMove({ from, to });
  playSound(captured ? 'capture' : 'move');

  try {
    sync(await api('POST', `/api/games/${game.id}/move`, { from, to, promotion }));
  } catch (err) {
    toast(err.message);
    api('GET', `/api/games/${game.id}`).then(sync, () => {});
  }
}

// ---------------------------------------------------------------- rendering

function coords(square) {
  // index into server board: row 0 = rank 8
  return [8 - Number(square[1]), FILES.indexOf(square[0])];
}

function displaySquare(row, col) {
  return state.orientation === 'w' ? FILES[col] + (8 - row) : FILES[7 - col] + (row + 1);
}

function displayPos(square) {
  const file = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return state.orientation === 'w' ? [8 - rank, file] : [rank - 1, 7 - file];
}

function renderGame() {
  const g = state.game;
  renderBoard();
  renderBars();
  renderStatus();
  renderReasonCallout();
  renderMoves();
  renderLog();
  renderAnalysis();
  requestAnalysis();
  $('#engine-btn').hidden = !engineAllowed(g) || !!engineError;
  $('#engine-btn').classList.toggle('active', state.showEngine);
  $('#resign-btn').hidden = isWatch(g);
  $('#resign-btn').disabled = !!g.result;
  $('#reasons-btn').hidden = isWatch(g);
  $('#reasons-btn').classList.toggle('active', state.showReasons);
  $('#pause-btn').hidden = !isWatch(g);
  $('#pause-btn').disabled = !!g.result;
  $('#pause-btn').textContent = state.paused ? '▶ Resume' : '⏸ Pause';
  $('#step-btn').hidden = !isWatch(g) || !state.paused;
  $('#step-btn').disabled = !canStep();
  $('#sound-btn').textContent = state.soundOn ? '🔊' : '🔇';
}

function renderBoard() {
  const g = state.game;
  const targets = new Map();
  if (state.selected) {
    for (const m of g.legalMoves) if (m.from === state.selected) targets.set(m.to, m);
  }
  const html = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const sq = displaySquare(row, col);
      const [br, bf] = coords(sq);
      const piece = g.board[br][bf];
      const cls = ['square'];
      if ((bf + Number(sq[1])) % 2 === 1) cls.push('dark');
      if (g.lastMove && (g.lastMove.from === sq || g.lastMove.to === sq)) cls.push('highlight');
      if (state.selected === sq) cls.push('highlight');
      if (g.checkSquare === sq) cls.push('check');
      if (targets.has(sq)) {
        cls.push('target');
        if (piece || targets.get(sq).san.includes('x')) cls.push('capture');
      }
      let inner = '';
      if (col === 0) inner += `<span class="coord rank">${sq[1]}</span>`;
      if (row === 7) inner += `<span class="coord file">${sq[0]}</span>`;
      if (piece) {
        const movable = isPlayerTurn(g) && piece[0] === g.playerColor;
        inner += pieceSvg(piece, `piece${movable ? ' movable' : ''}`);
      }
      html.push(`<div class="${cls.join(' ')}" data-square="${sq}">${inner}</div>`);
    }
  }
  $('#board').innerHTML = html.join('');
}

function animateMove({ from, to }) {
  const el = $(`#board [data-square="${to}"] .piece`);
  if (!el) return;
  const [fr, fc] = displayPos(from);
  const [tr, tc] = displayPos(to);
  el.style.transform = `translate(${(fc - tc) * 100}%, ${(fr - tr) * 100}%)`;
  el.getBoundingClientRect(); // flush so the transition starts from the offset
  el.classList.add('animating');
  el.style.transform = '';
  el.addEventListener('transitionend', () => el.classList.remove('animating'), { once: true });
}

function renderBars() {
  renderBar($('#bar-bottom'), state.orientation);
  renderBar($('#bar-top'), other(state.orientation));
}

function renderBar(bar, color) {
  const g = state.game;
  const p = g.players[color];
  const avatar = avatarHtml(g, color);
  if (bar.dataset.avatar !== avatar) {
    // only swap when it changes, so the logo image isn't reloaded on every render
    bar.querySelector('.avatar').outerHTML = avatar;
    bar.dataset.avatar = avatar;
  }
  bar.querySelector('.player-name').innerHTML = p
    ? `${esc(p.name)} <span class="model">${esc(p.model)}${isWatch(g) ? ` · ${COLOR_NAME[color]}` : ''}</span>`
    : `You <span class="model">(${COLOR_NAME[color]})</span>`;

  // pieces this side has captured, and the material balance
  const taken = { w: [], b: [] };
  for (const m of g.history) if (m.captured) taken[m.color].push(m.captured);
  const score = (list) => list.reduce((s, x) => s + PIECE_VALUE[x], 0);
  const diff = score(taken[color]) - score(taken[other(color)]);
  const groups = ['p', 'n', 'b', 'r', 'q']
    .map((t) => taken[color].filter((x) => x === t))
    .filter((grp) => grp.length)
    .map((grp) => `<span class="group">${grp.map((x) => pieceSvg(other(color) + x)).join('')}</span>`)
    .join('');
  bar.querySelector('.captured').innerHTML = groups + (diff > 0 ? `<span class="diff">+${diff}</span>` : '');

  const thinking = !!p && !g.result && g.turn === color && (llmBusy() || g.thinking);
  bar.querySelector('.thinking-indicator').hidden = !thinking;
}

function renderStatus() {
  const g = state.game;
  const el = $('#status-text');
  el.className = 'status-text';
  const mover = label(g, g.turn);
  if (g.result) {
    el.textContent = g.result.text;
    if (g.result.winner) el.classList.add(isWatch(g) || g.result.winner === g.playerColor ? 'win' : 'loss');
  } else if (isPlayerTurn(g)) {
    el.textContent = g.checkSquare ? 'Your turn — you are in check!' : 'Your turn';
  } else if (llmBusy() || g.thinking) {
    const current = g.llmTurns.at(-1);
    const n = current && !current.move && !current.error ? current.attempts.length + 1 : 1;
    el.textContent = `${mover} is thinking…${n > 1 ? ` (attempt ${n})` : ''}`;
  } else if (g.lastError) {
    el.textContent = `${mover} could not be reached`;
    el.classList.add('loss');
  } else if (isWatch(g) && state.paused) {
    el.textContent = `Paused — ${mover} to move`;
  } else {
    el.textContent = `${mover} to move`;
  }
}

function moveLabel(ply) {
  return `${Math.floor(ply / 2) + 1}${ply % 2 ? '…' : '.'}`;
}

/** The latest LLM decision (move or resignation) with its reason. */
function renderReasonCallout() {
  const g = state.game;
  const el = $('#reason-callout');
  const turn = [...g.llmTurns].reverse().find((t) => t.move || t.resigned);
  if (!reasonsVisible(g) || !turn) {
    el.hidden = true;
    return;
  }
  const what = turn.resigned ? 'resigns' : `${moveLabel(turn.ply)} <span class="san">${esc(turn.move)}</span>`;
  el.innerHTML = `${avatarHtml(g, turn.color)}
    <div><div class="who">${esc(label(g, turn.color))} ${what}</div>
    <div class="text ${turn.reason ? '' : 'none'}">${esc(turn.reason ?? 'No reason given.')}</div></div>`;
  el.hidden = false;
}

function renderMoves() {
  const g = state.game;
  const list = $('#move-list');
  const last = g.history.length - 1;
  const withReasons = reasonsVisible(g);
  const tag = (i) => (engineVisible(g) ? classBadge(g, i) : '');
  list.classList.toggle('with-reasons', withReasons);

  if (withReasons) {
    // one row per move, with the LLM's explanation underneath
    list.innerHTML = g.history
      .map(
        (m, i) => `<li><div class="ply-head"><span class="num">${moveLabel(i)}</span><span class="side-dot ${m.color}"></span>
          <span class="san${i === last ? ' current' : ''}">${esc(m.san)}${tag(i)}</span><span class="who">${esc(label(g, m.color))}</span></div>
          ${m.reason ? `<div class="reason">${esc(m.reason)}</div>` : ''}</li>`,
      )
      .join('');
  } else {
    const rows = [];
    for (let i = 0; i < g.history.length; i += 2) {
      const w = g.history[i];
      const b = g.history[i + 1];
      const cur = (idx) => (idx === last ? ' current' : '');
      rows.push(
        `<li><span class="num">${i / 2 + 1}.</span><span class="san${cur(i)}">${esc(w.san)}${tag(i)}</span>${
          b ? `<span class="san${cur(i + 1)}">${esc(b.san)}${tag(i + 1)}</span>` : '<span></span>'
        }</li>`,
      );
    }
    list.innerHTML = rows.join('');
  }
  list.scrollTop = list.scrollHeight;
}

function renderLog() {
  const g = state.game;
  const thinking = !g.result && (llmBusy() || g.thinking);
  const showAnswers = reasonsVisible(g);
  const signature = JSON.stringify([g.id, g.llmTurns, thinking, g.lastError, !!g.result, showAnswers]);
  if (signature === state.logSignature) return;
  state.logSignature = signature;

  const el = $('#llm-log');
  const parts = g.llmTurns.map((turn, ti) => {
    const who = isWatch(g) ? ` · ${esc(label(g, turn.color))}` : '';
    const status = turn.resigned
      ? '<span class="bad">⚑ resigned</span>'
      : turn.move
        ? `<span class="ok">✓ ${esc(turn.move)}</span>`
        : turn.error
          ? '<span class="bad">✗ failed</span>'
          : '<span class="muted">thinking…</span>';
    const attempts = turn.attempts
      .map((a, ai) => {
        const key = `${ti}:${ai}`;
        const head = a.move
          ? `<span class="accept">Attempt ${ai + 1}: ${a.move === 'resign' ? 'resigned' : `played ${esc(a.move)}`}</span>`
          : `<span class="reject">Attempt ${ai + 1}: rejected — ${esc(a.error)}</span>`;
        // Raw answers contain the reasoning, so they follow the reasons toggle.
        return showAnswers
          ? `<details class="log-attempt" data-key="${key}" ${state.logOpen.has(key) ? 'open' : ''}>
              <summary>${head}</summary><pre>${esc(a.answer)}</pre></details>`
          : `<div class="log-attempt">${head}</div>`;
      })
      .join('');
    const err = turn.error && !turn.move ? `<div class="log-error">${esc(turn.error)}</div>` : '';
    return `<div class="log-turn"><div class="log-turn-head"><span>Move ${moveLabel(turn.ply)}${who}</span>${status}</div>${attempts}${err}</div>`;
  });

  if (thinking) {
    const current = g.llmTurns.at(-1);
    if (!current || current.move || current.error) {
      parts.push(`<div class="log-turn"><div class="log-turn-head"><span>${esc(label(g, g.turn))}</span><span class="muted">thinking…</span></div></div>`);
    }
  } else if (g.lastError && !g.result) {
    parts.push(`<div class="log-turn log-error">Request failed: ${esc(g.lastError)}
      <div><button class="btn btn-primary" id="retry-btn">Retry</button></div></div>`);
  }

  el.innerHTML = parts.length ? parts.join('') : '<div class="log-empty">The LLM\'s answers will appear here.</div>';
  el.scrollTop = el.scrollHeight;
}

$('#llm-log').addEventListener(
  'toggle',
  (e) => {
    const key = e.target.dataset?.key;
    if (!key) return;
    if (e.target.open) state.logOpen.add(key);
    else state.logOpen.delete(key);
  },
  true,
);

$('#llm-log').addEventListener('click', (e) => {
  if (e.target.id === 'retry-btn') requestLlmMove();
});

// ---------------------------------------------------------------- engine analysis

// Live in LLM vs LLM; in a game against an LLM only once it's over (no help while playing).
const engineAllowed = (g) => isWatch(g) || !!g.result;
const engineVisible = (g) => state.showEngine && engineAllowed(g) && !engineError;
const positions = (g) => [START_FEN, ...g.history.map((m) => m.fen)];

/** Queue every position of the game that hasn't been analysed yet, the one on screen first. */
function requestAnalysis() {
  const g = state.game;
  if (!engineVisible(g)) return;
  const fens = positions(g);
  for (const fen of [...fens].reverse()) {
    if (state.analysisRequested.has(fen)) continue;
    state.analysisRequested.add(fen);
    const gameId = g.id;
    engine.analyze(fen).then(
      () => analysisArrived(gameId),
      (err) => {
        if (err.message === 'cancelled') return;
        if (engineError) return;
        engineError = err;
        toast('The analysis engine could not start in this browser');
        if (state.game?.id === gameId) renderGame();
      },
    );
  }
  engine.prioritize(fens.at(-1));
}

let analysisFrame = null;
function analysisArrived(gameId) {
  if (state.game?.id !== gameId || analysisFrame) return;
  analysisFrame = requestAnimationFrame(() => {
    analysisFrame = null;
    if (state.game?.id !== gameId) return;
    renderAnalysis();
    renderMoves();
  });
}

/** Evaluation of the position on screen; a drawn game shows 0.0 whatever the engine thinks. */
function currentEval(g) {
  if (g.result && !g.result.winner) return { cp: 0, mate: null, pv: [], best: null, depth: 0 };
  return engine.cache.get(positions(g).at(-1)) ?? null;
}

function renderAnalysis() {
  const g = state.game;
  const visible = engineVisible(g);
  $('#game').classList.toggle('with-eval', visible);
  $('#eval-bar').hidden = !visible;
  $('#engine-panel').hidden = !visible;
  if (!visible) return;

  const ev = currentEval(g);
  const bar = $('#eval-bar');
  bar.classList.toggle('flipped', state.orientation === 'b');
  if (ev) {
    const white = winChance(ev, 'w');
    bar.querySelector('.eval-fill').style.height = `${(white * 100).toFixed(1)}%`;
    const whiteEnd = state.orientation === 'w' ? 'at-bottom' : 'at-top';
    const blackEnd = state.orientation === 'w' ? 'at-top' : 'at-bottom';
    const text = bar.querySelector('.eval-text');
    text.className = `eval-text ${white >= 0.5 ? `${whiteEnd} on-white` : `${blackEnd} on-black`}`;
    text.textContent = formatEval(ev).replace(/^[+-]/, '');
    bar.title = `Stockfish: ${formatEval(ev)}`;
  } else {
    // not analysed yet (e.g. a new game): neutral bar instead of the previous position's
    bar.querySelector('.eval-fill').style.height = '50%';
    bar.querySelector('.eval-text').textContent = '';
    bar.title = 'Stockfish is analysing…';
  }
  renderEnginePanel(g, ev);
}

function renderEnginePanel(g, ev) {
  const el = $('#engine-panel');
  if (!ev) {
    el.innerHTML = '<div class="engine-head"><span class="muted">Stockfish is analysing…</span></div>';
    return;
  }
  const side = winChance(ev, 'w') >= 0.5 ? 'white' : 'black';
  const depth = ev.depth ? `Stockfish 19 · depth ${ev.depth}` : 'Stockfish 19';
  const line = g.result
    ? `<span class="muted">${esc(g.result.text)}</span>`
    : ev.pv.length
      ? `<span class="muted">Best:</span> ${pvHtml(positions(g).at(-1), ev.pv)}`
      : '';
  el.innerHTML = `<div class="engine-head"><span class="engine-eval ${side}">${esc(formatEval(ev))}</span><span class="muted">${depth}</span></div>
    ${line ? `<div class="engine-line">${line}</div>` : ''}
    ${summaryHtml(g)}`;
}

let ChessLib = null;
let chessLibLoading = null;
function loadChessLib() {
  chessLibLoading ??= import('/vendor/chess.js').then((mod) => {
    ChessLib = mod;
    if (state.game) renderAnalysis();
  });
}

/** The engine's best line in SAN with move numbers, e.g. "13. Nxe5 dxe5 14. Qh5+". */
function pvHtml(fen, pv) {
  if (!ChessLib) {
    loadChessLib();
    return `<span class="pv-move">${esc(pv.slice(0, PV_PLIES).join(' '))}</span>`;
  }
  const chess = new ChessLib.Chess(fen);
  let [, color, , , , moveNo] = fen.split(' ');
  moveNo = Number(moveNo);
  const out = [];
  for (const uci of pv.slice(0, PV_PLIES)) {
    let san;
    try {
      san = chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      break;
    }
    if (color === 'w') out.push(`${moveNo}.`);
    else if (!out.length) out.push(`${moveNo}…`);
    out.push(`<span class="pv-move">${esc(san)}</span>`);
    if (color === 'b') moveNo++;
    color = other(color);
  }
  return out.join(' ');
}

/** Classification of move i, or null until both positions around it are analysed. */
function moveClass(g, i) {
  const fens = positions(g);
  const before = engine.cache.get(fens[i]);
  const after = engine.cache.get(fens[i + 1]);
  if (!before || !after) return null;
  const m = g.history[i];
  return { ...classify(before, after, m.color, m.uci), before, after };
}

function classBadge(g, i) {
  const c = moveClass(g, i);
  if (!c) return '';
  const { label: name, symbol } = CLASSES[c.kind];
  return `<span class="mv-class ${c.kind}" title="${name} (${formatEval(c.before)} → ${formatEval(c.after)})">${symbol}</span>`;
}

/** Accuracy and inaccuracy / mistake / blunder counts per side, over the moves analysed so far. */
function summaryHtml(g) {
  const sides = {};
  for (const color of ['w', 'b']) sides[color] = { acc: [], counts: { inaccuracy: 0, mistake: 0, blunder: 0 } };
  g.history.forEach((m, i) => {
    const c = moveClass(g, i);
    if (!c) return;
    sides[m.color].acc.push(moveAccuracy(c.before, c.after, m.color));
    if (c.kind in sides[m.color].counts) sides[m.color].counts[c.kind]++;
  });
  const row = (color) => {
    const s = sides[color];
    if (!s.acc.length) return '';
    const acc = s.acc.reduce((a, b) => a + b, 0) / s.acc.length;
    const counts = Object.entries(s.counts)
      .map(([kind, n]) => `<span class="count"><span class="mv-class ${kind}" title="${CLASSES[kind].label}">${CLASSES[kind].symbol}</span>${n}</span>`)
      .join('');
    return `<div class="summary-row"><span><b>${esc(label(g, color))}</b> · accuracy ${acc.toFixed(1)}%</span><span class="counts">${counts}</span></div>`;
  };
  const rows = row('w') + row('b');
  return rows ? `<div class="engine-summary">${rows}</div>` : '';
}

// ---------------------------------------------------------------- board input

function squareAt(x, y) {
  return document.elementFromPoint(x, y)?.closest('#board .square')?.dataset.square ?? null;
}

function pieceAt(sq) {
  const [r, f] = coords(sq);
  return state.game.board[r][f];
}

function legalTarget(from, to) {
  return state.game.legalMoves.filter((m) => m.from === from && m.to === to);
}

$('#board').addEventListener('pointerdown', (e) => {
  const g = state.game;
  if (!g || !isPlayerTurn(g) || e.button !== 0) return;
  const sq = squareAt(e.clientX, e.clientY);
  if (!sq) return;

  if (state.selected && legalTarget(state.selected, sq).length) {
    tryMove(state.selected, sq, false);
    return;
  }

  const piece = pieceAt(sq);
  if (!piece || piece[0] !== g.playerColor) {
    state.selected = null;
    renderBoard();
    return;
  }

  e.preventDefault();
  const wasSelected = state.selected === sq;
  state.selected = sq;
  renderBoard();

  const size = $('#board').getBoundingClientRect().width / 8;
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.style.width = ghost.style.height = `${size}px`;
  ghost.innerHTML = pieceSvg(piece);
  ghost.firstChild.style.width = ghost.firstChild.style.height = '100%';
  moveGhost(ghost, e.clientX, e.clientY);
  document.body.appendChild(ghost);
  $(`#board [data-square="${sq}"] .piece`)?.classList.add('dragging-source');
  state.drag = { from: sq, ghost, wasSelected, hover: null };
});

function moveGhost(ghost, x, y) {
  ghost.style.left = `${x}px`;
  ghost.style.top = `${y}px`;
}

window.addEventListener('pointermove', (e) => {
  const d = state.drag;
  if (!d) return;
  moveGhost(d.ghost, e.clientX, e.clientY);
  const sq = squareAt(e.clientX, e.clientY);
  if (sq !== d.hover) {
    if (d.hover) $(`#board [data-square="${d.hover}"]`)?.classList.remove('hover-target');
    d.hover = sq;
    if (sq && legalTarget(d.from, sq).length) $(`#board [data-square="${sq}"]`)?.classList.add('hover-target');
  }
});

window.addEventListener('pointerup', (e) => {
  const d = state.drag;
  if (!d) return;
  state.drag = null;
  d.ghost.remove();
  const sq = squareAt(e.clientX, e.clientY);
  if (sq && sq !== d.from && legalTarget(d.from, sq).length) {
    tryMove(d.from, sq, true);
    return;
  }
  if (sq === d.from && d.wasSelected) state.selected = null; // second click on same piece: deselect
  else if (sq !== d.from) state.selected = null;
  renderBoard();
});

async function tryMove(from, to, dragged) {
  const options = legalTarget(from, to);
  if (!options.length) return;
  let promotion = null;
  if (options[0].promotion) {
    promotion = await pickPromotion();
    if (!promotion) {
      state.selected = null;
      renderBoard();
      return;
    }
  }
  submitMove(from, to, promotion, { dragged });
}

function pickPromotion() {
  const color = state.game.playerColor;
  const box = $('#promotion');
  box.innerHTML = `<div class="promotion-inner">${['q', 'r', 'b', 'n']
    .map((p) => `<button type="button" data-p="${p}" title="${p}">${pieceSvg(color + p)}</button>`)
    .join('')}</div>`;
  box.hidden = false;
  return new Promise((resolve) => {
    box.onclick = (e) => {
      box.hidden = true;
      resolve(e.target.closest('button')?.dataset.p ?? null); // click outside = cancel
    };
  });
}

// ---------------------------------------------------------------- actions

function showResult() {
  const g = state.game;
  if (!g?.result) return;
  const title = $('#result-title');
  const { winner } = g.result;
  if (!winner) {
    title.textContent = 'Draw';
    title.className = 'modal-title draw';
  } else if (isWatch(g)) {
    title.textContent = `${COLOR_NAME[winner]} Wins`;
    title.className = 'modal-title win';
  } else if (winner === g.playerColor) {
    title.textContent = 'You Won!';
    title.className = 'modal-title win';
  } else {
    title.textContent = 'You Lost';
    title.className = 'modal-title loss';
  }
  $('#result-text').textContent = g.result.text;
  const detail = $('#result-detail');
  detail.textContent = g.result.detail ? `“${g.result.detail}”` : '';
  detail.hidden = !(g.result.detail && reasonsVisible(g));
  $('#result-modal').hidden = false;
}

$('#modal-close-btn').addEventListener('click', () => ($('#result-modal').hidden = true));
$('#modal-new-btn').addEventListener('click', () => (location.hash = '#/'));
$('#new-btn').addEventListener('click', () => (location.hash = '#/'));
$('#rematch-btn').addEventListener('click', () => {
  const g = state.game;
  // swap sides, like chess.com
  if (isWatch(g)) startGame({ mode: 'watch', whiteLlmId: g.players.b.id, blackLlmId: g.players.w.id });
  else startGame({ mode: 'human', llmId: g.players[other(g.playerColor)].id, color: g.playerColor === 'w' ? 'black' : 'white' });
});

$('#flip-btn').addEventListener('click', () => {
  state.orientation = other(state.orientation);
  renderBoard();
  renderBars();
  renderAnalysis();
});

$('#engine-btn').addEventListener('click', () => {
  state.showEngine = !state.showEngine;
  save('engine', state.showEngine);
  renderGame();
});

$('#sound-btn').addEventListener('click', () => {
  state.soundOn = !state.soundOn;
  save('sound', state.soundOn);
  $('#sound-btn').textContent = state.soundOn ? '🔊' : '🔇';
});

$('#reasons-btn').addEventListener('click', () => {
  state.showReasons = !state.showReasons;
  save('reasons', state.showReasons);
  renderGame();
});

$('#pause-btn').addEventListener('click', async () => {
  const game = state.game;
  state.paused = !state.paused;
  if (state.paused) clearTimeout(state.advanceTimer); // a move already being thought about still completes
  renderGame();
  if (!state.paused) maybeAdvance();

  // Save it with the game, so reopening the page later shows it paused.
  state.pauseRequests++;
  try {
    const saved = await api('POST', `/api/games/${game.id}/pause`, { paused: state.paused });
    if (state.game?.id === game.id) state.game.paused = saved.paused;
  } catch (err) {
    toast(`Could not save the pause: ${err.message}`);
  } finally {
    state.pauseRequests--;
  }
});

// While paused, play exactly one move; maybeAdvance() stops again afterwards because still paused.
function canStep() {
  const g = state.game;
  return !!g && isWatch(g) && state.paused && !g.result && !llmBusy() && !g.thinking;
}

function step() {
  if (canStep()) requestLlmMove();
}

$('#step-btn').addEventListener('click', step);

$('#pgn-btn').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.game.pgn);
    toast('PGN copied to clipboard');
  } catch {
    toast('Could not access the clipboard');
  }
});

let resignArmed = null;
$('#resign-btn').addEventListener('click', async () => {
  const btn = $('#resign-btn');
  if (!resignArmed) {
    btn.textContent = 'Confirm resign?';
    resignArmed = setTimeout(() => {
      resignArmed = null;
      btn.textContent = '⚑ Resign';
    }, 3000);
    return;
  }
  clearTimeout(resignArmed);
  resignArmed = null;
  btn.textContent = '⚑ Resign';
  try {
    sync(await api('POST', `/api/games/${state.game.id}/resign`));
  } catch (err) {
    toast(err.message);
  }
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowRight') step();
  if (e.key === 'Escape') {
    $('#result-modal').hidden = true;
    if (state.selected) {
      state.selected = null;
      renderBoard();
    }
  }
});

route();
