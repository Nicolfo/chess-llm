// Stockfish as a player. Each move runs its own engine process: the lite single-threaded
// WASM build, the same one the browser uses for analysis, so there is no native binary to
// install and a crashed or stuck engine can't affect other games.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Llm } from './config.ts';
import { LlmError } from './llm.ts';

const require = createRequire(import.meta.url);
const STOCKFISH = path.join(path.dirname(require.resolve('stockfish/package.json')), 'bin', 'stockfish-19-lite-single.js');

export const DEFAULT_MOVETIME_MS = 1000;
// on top of the thinking time: starting the engine and loading its network
const STARTUP_ALLOWANCE_MS = 30_000;

export interface EngineMove {
  uci: string;
  depth: number | null;
  score: { cp: number } | { mate: number } | null; // of the best line, from the engine's side
  bestLine: string | null; // first move of the best line; differs from uci when the Elo limit picks a weaker move
  log: string; // the last search info line and bestmove, shown in the move log
}

/**
 * @param engine an entry from config.llms with provider "engine"
 * @param moves  the game so far in UCI notation, from the start position
 */
export function engineMove(engine: Llm, moves: string[]): Promise<EngineMove> {
  const movetime = engine.movetimeMs ?? DEFAULT_MOVETIME_MS;
  const proc = spawn(process.execPath, [STOCKFISH], { stdio: ['pipe', 'pipe', 'ignore'] });

  return new Promise<EngineMove>((resolve, reject) => {
    let pending = '';
    let lastInfo = '';
    let waiting: { match: (line: string) => boolean; next: (line: string) => void } | null = null;
    let done = false;

    const timer = setTimeout(
      () => fail(new LlmError(`${engine.name}: no move within ${movetime + STARTUP_ALLOWANCE_MS} ms`)),
      movetime + STARTUP_ALLOWANCE_MS,
    );
    // stop the engine once; its exit after that is expected
    const finish = (): boolean => {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      proc.stdin.end();
      proc.kill();
      return true;
    };
    const fail = (err: Error) => {
      if (finish()) reject(err);
    };
    const send = (cmd: string) => proc.stdin.write(`${cmd}\n`);
    const expect = (match: (line: string) => boolean, next: (line: string) => void) => {
      waiting = { match, next };
    };

    proc.stdin.on('error', () => {}); // EPIPE if the engine died; reported by 'exit' instead
    proc.on('error', (err) => fail(new LlmError(`${engine.name}: could not start the engine (${err.message})`)));
    proc.on('exit', (code) => fail(new LlmError(`${engine.name}: the engine exited unexpectedly (code ${code})`)));
    proc.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        // a complete result: lowerbound / upperbound lines are partial searches
        if (line.startsWith('info ') && / score /.test(line) && / pv /.test(line) && !/bound/.test(line)) lastInfo = line;
        if (waiting?.match(line)) {
          const { next } = waiting;
          waiting = null;
          next(line);
        }
      }
    });

    expect(
      (line) => line === 'uciok',
      () => {
        if (engine.elo !== undefined) {
          send('setoption name UCI_LimitStrength value true');
          send(`setoption name UCI_Elo value ${engine.elo}`);
        } else if (engine.skillLevel !== undefined) {
          send(`setoption name Skill Level value ${engine.skillLevel}`);
        }
        send('isready');
        expect(
          (line) => line === 'readyok',
          () => {
            // the whole game rather than a FEN, so the engine sees repetitions
            send(`position startpos${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
            send(`go movetime ${movetime}`);
            expect(
              (line) => line.startsWith('bestmove'),
              (line) => {
                if (!finish()) return;
                const uci = line.split(/\s+/)[1];
                if (!uci || uci === '(none)') return reject(new LlmError(`${engine.name}: no move found`));
                resolve({ uci, ...parseInfo(lastInfo), log: [lastInfo, line].filter(Boolean).join('\n') });
              },
            );
          },
        );
      },
    );
    send('uci');
  });
}

function parseInfo(line: string): Pick<EngineMove, 'depth' | 'score' | 'bestLine'> {
  const depth = line.match(/ depth (\d+)/);
  const score = line.match(/ score (cp|mate) (-?\d+)/);
  const pv = line.match(/ pv (\S+)/);
  return {
    depth: depth ? Number(depth[1]) : null,
    score: score ? (score[1] === 'cp' ? { cp: Number(score[2]) } : { mate: Number(score[2]) }) : null,
    bestLine: pv ? pv[1] : null,
  };
}

/** One line for the move list, e.g. "Evaluation +0.42 for Black (depth 14)." */
export function engineReason(move: EngineMove, side: string): string {
  const { score, depth } = move;
  const at = depth ? ` (depth ${depth})` : '';
  if (!score) return `Best move found in the time allowed${at}.`;
  // no depth for mates: once a mate is found the reported depth is meaningless (often 200+)
  const evaluation =
    'mate' in score
      ? score.mate > 0
        ? `mate in ${score.mate} for ${side}`
        : `${side} gets mated in ${-score.mate}`
      : `${score.cp >= 0 ? '+' : ''}${(score.cp / 100).toFixed(2)} for ${side}${at}`;
  // the evaluation belongs to the best line, not to a weaker move chosen by the strength limit
  if (move.bestLine && move.bestLine !== move.uci) {
    return `Played a weaker move on purpose (strength limit). Best play would give ${evaluation}.`;
  }
  return `Evaluation ${evaluation}.`;
}
