// Stockfish (WASM, lite single-threaded build) running in a Web Worker in the viewer's browser.
// Analyses positions one at a time and caches the result per FEN.
// Scores are converted to White's point of view: { cp } in centipawns or { mate } in moves (+ = White mates).

const DEPTH = 16;
const MAX_MS = 2000; // per position; whichever limit is hit first

export class Engine {
  constructor(url = '/engine/stockfish.js') {
    this.url = url;
    this.worker = null;
    this.ready = null;
    this.cache = new Map(); // fen -> result
    this.queue = []; // { fen, resolve, reject }
    this.current = null; // { fen, resolve, reject, info }
    this.failed = false;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(this.url);
      } catch (err) {
        this.failed = true;
        return reject(err);
      }
      this.worker.onerror = (e) => {
        this.failed = true;
        reject(new Error(e.message || 'engine failed to load'));
        this.current?.reject(new Error('engine crashed'));
      };
      this.worker.onmessage = (e) => this.onLine(String(e.data), resolve);
      this.worker.postMessage('uci');
    });
    return this.ready;
  }

  onLine(line, onReady) {
    if (line === 'uciok') {
      this.worker.postMessage('setoption name Hash value 32');
      this.worker.postMessage('isready');
      return;
    }
    if (line === 'readyok') {
      onReady();
      return;
    }
    const job = this.current;
    if (!job) return;
    if (line.startsWith('info') && line.includes(' score ') && !line.includes(' lowerbound') && !line.includes(' upperbound')) {
      const depth = Number(line.match(/ depth (\d+)/)?.[1] ?? 0);
      const score = line.match(/ score (cp|mate) (-?\d+)/);
      const pv = line.match(/ pv (.+)$/)?.[1].trim().split(/\s+/) ?? [];
      if (score) job.info = { depth, kind: score[1], value: Number(score[2]), pv };
      return;
    }
    if (line.startsWith('bestmove')) {
      const best = line.split(/\s+/)[1];
      this.current = null;
      job.resolve(toWhitePov(job.fen, job.info, best === '(none)' ? null : best));
      this.next();
    }
  }

  /** Analysis of a position, from the cache when available. */
  analyze(fen) {
    if (this.cache.has(fen)) return Promise.resolve(this.cache.get(fen));
    const pending = this.queue.find((j) => j.fen === fen) ?? (this.current?.fen === fen ? this.current : null);
    if (pending) return pending.promise;
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)));
    const job = {
      fen,
      promise,
      resolve: (r) => {
        this.cache.set(fen, r);
        resolve(r);
      },
      reject,
    };
    this.queue.push(job);
    this.start().then(() => this.next(), (err) => this.failAll(err));
    return promise;
  }

  /** Move a queued position to the front (e.g. the one on screen). */
  prioritize(fen) {
    const i = this.queue.findIndex((j) => j.fen === fen);
    if (i > 0) this.queue.unshift(...this.queue.splice(i, 1));
  }

  /** Drop everything queued (e.g. when leaving a game). The running search finishes and is cached. */
  clearQueue() {
    for (const job of this.queue) job.reject(new Error('cancelled'));
    this.queue = [];
  }

  next() {
    if (this.current || !this.queue.length || !this.worker) return;
    const job = this.queue.shift();
    this.current = job;
    job.info = null;
    this.worker.postMessage(`position fen ${job.fen}`);
    this.worker.postMessage(`go depth ${DEPTH} movetime ${MAX_MS}`);
  }

  failAll(err) {
    for (const job of this.queue) job.reject(err);
    this.queue = [];
  }
}

function toWhitePov(fen, info, best) {
  const sign = fen.split(' ')[1] === 'w' ? 1 : -1;
  if (!info) {
    // no search output: no legal moves (mate or stalemate is reported with a score, so this is a fallback)
    return { cp: 0, mate: null, depth: 0, pv: [], best: null };
  }
  if (info.kind === 'mate' && info.value === 0) {
    // side to move is checkmated
    return { cp: null, mate: 0, winner: sign === 1 ? 'b' : 'w', depth: 0, pv: [], best: null };
  }
  return info.kind === 'mate'
    ? { cp: null, mate: sign * info.value, depth: info.depth, pv: info.pv, best }
    : { cp: sign * info.value, mate: null, depth: info.depth, pv: info.pv, best };
}

// ---------------------------------------------------------------- evaluation helpers

/** Expected score (0..1) for `color` ('w' | 'b'), lichess' win-probability model. */
export function winChance(ev, color) {
  let white;
  if (ev.mate === 0) white = ev.winner === 'w' ? 1 : 0;
  else if (ev.mate !== null) white = ev.mate > 0 ? 1 : 0;
  else white = 1 / (1 + Math.exp(-0.00368208 * ev.cp));
  return color === 'w' ? white : 1 - white;
}

/** "+1.3", "-0.8", "M3" (White mates in 3), "-M3" (Black mates in 3), "#" (checkmate on the board). */
export function formatEval(ev) {
  if (ev.mate !== null) {
    if (ev.mate === 0) return '#';
    return `${ev.mate > 0 ? '' : '-'}M${Math.abs(ev.mate)}`;
  }
  const pawns = ev.cp / 100;
  return `${pawns > 0 ? '+' : ''}${pawns.toFixed(1)}`;
}

// chess.com-style classification by expected-points lost
export const CLASSES = {
  best: { label: 'Best', symbol: '★' },
  excellent: { label: 'Excellent', symbol: '!' },
  good: { label: 'Good', symbol: '✓' },
  inaccuracy: { label: 'Inaccuracy', symbol: '?!' },
  mistake: { label: 'Mistake', symbol: '?' },
  blunder: { label: 'Blunder', symbol: '??' },
};

/** Classify a move from the evaluations before and after it. */
export function classify(before, after, color, uci) {
  const loss = Math.max(0, winChance(before, color) - winChance(after, color));
  if (before.best && uci === before.best) return { kind: 'best', loss };
  if (loss <= 0.02) return { kind: 'excellent', loss };
  if (loss <= 0.05) return { kind: 'good', loss };
  if (loss <= 0.1) return { kind: 'inaccuracy', loss };
  if (loss <= 0.2) return { kind: 'mistake', loss };
  return { kind: 'blunder', loss };
}

/** Per-move accuracy (0..100) from win% before and after, lichess' formula. */
export function moveAccuracy(before, after, color) {
  const drop = Math.max(0, (winChance(before, color) - winChance(after, color)) * 100);
  return Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * drop) - 3.1669));
}
