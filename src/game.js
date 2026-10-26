import crypto from 'node:crypto';
import { Chess } from 'chess.js';
import { propagateAttributes, startActiveObservation, startObservation } from '@langfuse/tracing';
import { chat } from './llm.js';

const COLOR_NAME = { w: 'White', b: 'Black' };
const OTHER = { w: 'b', b: 'w' };
const MAX_REASON_LENGTH = 500;

function systemPrompt(opponent) {
  return `You are a strong chess player taking part in a game against ${opponent}.
On every turn you receive the current position and your opponent's last move, and you must choose your next move.

Rules for your answer:
- You may think briefly first, but keep it short.
- Your answer MUST end with these two lines, in this order:
REASON: <one or two sentences explaining why you chose this move>
MOVE: <move>
- Write <move> in Standard Algebraic Notation (SAN), e.g. e4, Nf3, exd5, Bxf7+, O-O, O-O-O, e8=Q.
  UCI notation (e.g. e2e4, e7e8q) is also accepted.
- The move must be legal in the given position. Only one move.
- If your position is truly hopeless (e.g. unavoidable checkmate, or a decisive material deficit with no
  counterplay), you may resign instead by writing "MOVE: resign", with the REASON line explaining why.
  Do not resign positions that are merely difficult.`;
}

export class GameError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export class Game {
  /**
   * @param white / black  an LLM entry from config.llms, or null for the human player
   */
  constructor({ white, black, maxAttempts, requestTimeoutMs }) {
    if (!white && !black) throw new GameError('At least one side must be an LLM');
    this.id = crypto.randomUUID();
    this.players = { w: white, b: black };
    this.mode = white && black ? 'watch' : 'human';
    this.playerColor = !white ? 'w' : !black ? 'b' : null; // human's side, null when watching
    this.maxAttempts = maxAttempts;
    this.requestTimeoutMs = requestTimeoutMs;
    this.chess = new Chess();
    this.chess.setHeader('Event', `Chess LLM: ${this.nameOf('w')} vs ${this.nameOf('b')}`);
    this.chess.setHeader('Date', new Date().toISOString().slice(0, 10).replaceAll('-', '.'));
    this.chess.setHeader('White', this.nameOf('w'));
    this.chess.setHeader('Black', this.nameOf('b'));
    this.reasons = []; // reason given for the move at each ply (LLM moves only)
    this.result = null; // { winner: 'w' | 'b' | null, reason, text, detail? }
    this.thinking = false;
    this.llmTurns = []; // [{ ply, color, llm, attempts: [{ answer, move, error }], move, reason, resigned, error }]
    this.lastError = null; // last provider/network error, cleared on next attempt
    this.touchedAt = Date.now();
  }

  get isOver() {
    return this.result !== null;
  }

  nameOf(color) {
    return this.players[color]?.name ?? 'You';
  }

  /** "You", "Claude", or "Claude (White)" when watching (both sides may be the same model). */
  labelOf(color) {
    return this.mode === 'watch' ? `${this.nameOf(color)} (${COLOR_NAME[color]})` : this.nameOf(color);
  }

  winText(winner) {
    if (this.mode === 'human') return winner === this.playerColor ? 'You win!' : `${this.nameOf(winner)} wins.`;
    return `${this.labelOf(winner)} wins.`;
  }

  playerMove({ from, to, promotion }) {
    this.touch();
    if (this.isOver) throw new GameError('Game is over');
    if (this.mode !== 'human' || this.chess.turn() !== this.playerColor) throw new GameError('It is not your turn');
    try {
      this.chess.move({ from, to, promotion });
    } catch {
      throw new GameError(`Illegal move: ${from}-${to}${promotion ? `=${promotion}` : ''}`);
    }
    this.checkGameOver();
  }

  resign() {
    this.touch();
    if (this.isOver) throw new GameError('Game is over');
    if (this.mode !== 'human') throw new GameError('Only a human player can resign here');
    const winner = OTHER[this.playerColor];
    this.finish(winner, 'resignation', `You resigned. ${this.nameOf(winner)} wins.`);
  }

  /**
   * Ask the LLM to move for the side to play, validating every answer and re-prompting
   * (with the rejected answer and the reason) until it plays a legal move, resigns,
   * or runs out of attempts, in which case it forfeits.
   */
  async llmMove() {
    this.touch();
    if (this.isOver) throw new GameError('Game is over');
    const color = this.chess.turn();
    const llm = this.players[color];
    if (!llm) throw new GameError("It is not an LLM's turn");
    if (this.thinking) throw new GameError('The LLM is already thinking', 409);

    this.thinking = true;
    this.lastError = null;
    const ply = this.chess.history().length;
    const turn = { ply, color, llm: llm.name, attempts: [], move: null, reason: null, resigned: false, error: null };
    this.llmTurns.push(turn);

    try {
      // One trace per LLM move; all moves of a game share a session.
      await propagateAttributes(
        {
          sessionId: this.id,
          tags: [this.mode === 'watch' ? 'llm-vs-llm' : 'vs-human'],
          metadata: { gameId: this.id, llmId: llm.id, side: COLOR_NAME[color], ply },
        },
        () => startActiveObservation('choose-move', (agent) => this.playTurn(agent, turn, llm, color), { asType: 'agent' }),
      );
    } catch (err) {
      turn.error = err.message;
      this.lastError = err.message;
      // Drop the turn entry if nothing was attempted, so a retry starts clean.
      if (turn.attempts.length === 0) this.llmTurns.pop();
      throw err;
    } finally {
      this.thinking = false;
    }
  }

  async playTurn(agent, turn, llm, color) {
    const last = this.chess.history({ verbose: true }).at(-1);
    agent.update({
      input: {
        side: COLOR_NAME[color],
        moveNumber: Math.floor(turn.ply / 2) + 1,
        opponentLastMove: last?.san ?? null,
        fen: this.chess.fen(),
      },
    });
    const opponent = this.players[OTHER[color]] ? 'another AI model' : 'a human';
    const messages = [{ role: 'user', content: this.buildPrompt(color) }];

    try {
      while (turn.attempts.length < this.maxAttempts) {
        // Provider/network errors propagate: the turn stays with the LLM and the client can retry.
        const answer = await chat(llm, systemPrompt(opponent), messages, {
          timeoutMs: llm.timeoutMs ?? this.requestTimeoutMs,
          name: 'generate-move',
          metadata: { attempt: turn.attempts.length + 1 },
        });
        const attempt = { answer, move: null, error: null };
        turn.attempts.push(attempt);
        const { move, reason } = parseAnswer(answer);

        if (move && /^resign/i.test(move)) {
          attempt.move = 'resign';
          turn.resigned = true;
          turn.reason = reason;
          const winner = OTHER[color];
          this.finish(winner, 'resignation', `${this.labelOf(color)} resigns. ${this.winText(winner)}`, reason);
          agent.update({ output: { resigned: true, reason }, metadata: { attempts: turn.attempts.length } });
          return;
        }

        const validation = startObservation('validate-move', { input: { move } }, { asType: 'guardrail' });
        const { san, error } = this.tryApply(move, color);
        validation
          .update(san ? { output: { legal: true, san } } : { output: { legal: false, error }, level: 'WARNING', statusMessage: error })
          .end();

        if (san) {
          attempt.move = san;
          turn.move = san;
          turn.reason = reason;
          this.reasons[turn.ply] = reason;
          this.checkGameOver();
          agent.update({
            output: { move: san, reason },
            metadata: { attempts: turn.attempts.length, ...(this.result ? { result: this.result.reason } : {}) },
          });
          return;
        }

        attempt.error = error;
        messages.push({ role: 'assistant', content: answer });
        messages.push({ role: 'user', content: this.buildRetryPrompt(answer, error, turn.attempts.length) });
      }

      turn.error = `No legal move after ${this.maxAttempts} attempts`;
      const winner = OTHER[color];
      this.finish(
        winner,
        'forfeit',
        `${this.labelOf(color)} failed to produce a legal move in ${this.maxAttempts} attempts and forfeits. ${this.winText(winner)}`,
      );
      agent.update({
        output: { forfeit: true },
        level: 'WARNING',
        statusMessage: turn.error,
        metadata: { attempts: turn.attempts.length },
      });
    } catch (err) {
      agent.update({ level: 'ERROR', statusMessage: err.message, metadata: { attempts: turn.attempts.length } });
      throw err;
    }
  }

  /** Play the candidate move if it is legal. */
  tryApply(candidate, color) {
    if (!candidate) {
      return { error: 'Could not find a move in your answer. The last line must be "MOVE: <move>".' };
    }
    try {
      const move = this.chess.move(candidate, { strict: false });
      return { san: move.san };
    } catch {
      const reason = this.chess.inCheck()
        ? `"${candidate}" is not a legal move. Note that you are in check and must get out of it.`
        : `"${candidate}" is not a legal move for ${COLOR_NAME[color]} in the current position.`;
      return { error: reason };
    }
  }

  buildPrompt(color) {
    const history = this.chess.history({ verbose: true });
    const last = history.at(-1);
    const moveNumber = Math.floor(history.length / 2) + 1;
    const lines = [
      `You are playing ${COLOR_NAME[color]}. It is your turn (move ${moveNumber}).`,
      '',
      last
        ? `Opponent's last move: ${last.san} (${last.from} -> ${last.to})`
        : 'There is no previous move: you make the first move of the game.',
      '',
      `Current position (FEN): ${this.chess.fen()}`,
      '',
      'Board (uppercase = White, lowercase = Black, "." = empty square):',
      boardDiagram(this.chess),
      '',
      `Move history (PGN): ${pgnMoves(this.chess) || '(none)'}`,
    ];
    if (this.chess.inCheck()) lines.push('', 'You are in CHECK.');
    if (this.players[color].showLegalMoves) lines.push('', `Legal moves: ${this.chess.moves().join(', ')}`);
    lines.push('', 'Choose your move. End your answer with the "REASON: ..." and "MOVE: ..." lines.');
    return lines.join('\n');
  }

  buildRetryPrompt(answer, error, attemptNo) {
    const quoted = answer.length > 600 ? `...${answer.slice(-600)}` : answer;
    const lines = [
      `Your last answer was incorrect (attempt ${attemptNo} of ${this.maxAttempts}).`,
      '',
      'Your last answer was:',
      '"""',
      quoted,
      '"""',
      '',
      `Problem: ${error}`,
      '',
      `The position has NOT changed. Current position (FEN): ${this.chess.fen()}`,
      boardDiagram(this.chess),
    ];
    if (this.players[this.chess.turn()].showLegalMoves) lines.push('', `Legal moves: ${this.chess.moves().join(', ')}`);
    lines.push('', 'Try again with a legal move. End your answer with the "REASON: ..." and "MOVE: ..." lines.');
    return lines.join('\n');
  }

  checkGameOver() {
    const c = this.chess;
    if (c.isCheckmate()) {
      const winner = OTHER[c.turn()];
      this.finish(winner, 'checkmate', `Checkmate! ${this.winText(winner)}`);
    } else if (c.isStalemate()) {
      this.finish(null, 'stalemate', 'Draw by stalemate.');
    } else if (c.isInsufficientMaterial()) {
      this.finish(null, 'insufficient material', 'Draw by insufficient material.');
    } else if (c.isThreefoldRepetition()) {
      this.finish(null, 'threefold repetition', 'Draw by threefold repetition.');
    } else if (c.isDrawByFiftyMoves()) {
      this.finish(null, '50-move rule', 'Draw by the 50-move rule.');
    }
  }

  finish(winner, reason, text, detail = null) {
    this.result = { winner, reason, text, detail };
    this.chess.setHeader('Result', winner === 'w' ? '1-0' : winner === 'b' ? '0-1' : '1/2-1/2');
    if (reason === 'resignation' || reason === 'forfeit') {
      this.chess.setHeader('Termination', `${this.nameOf(OTHER[winner])} ${reason === 'forfeit' ? 'forfeits' : 'resigns'}`);
    }
  }

  touch() {
    this.touchedAt = Date.now();
  }

  toJSON() {
    const c = this.chess;
    const history = c.history({ verbose: true });
    const last = history.at(-1);
    const humanToMove = this.mode === 'human' && !this.isOver && c.turn() === this.playerColor;
    const info = (llm) => llm && { id: llm.id, name: llm.name, provider: llm.provider, model: llm.model, icon: llm.icon };
    return {
      id: this.id,
      mode: this.mode,
      players: { w: info(this.players.w), b: info(this.players.b) },
      playerColor: this.playerColor,
      fen: c.fen(),
      turn: c.turn(),
      board: c.board().map((rank) => rank.map((sq) => (sq ? sq.color + sq.type : null))),
      history: history.map((m, i) => ({
        san: m.san,
        from: m.from,
        to: m.to,
        color: m.color,
        captured: m.captured ?? null,
        reason: this.reasons[i] ?? null,
      })),
      lastMove: last ? { from: last.from, to: last.to } : null,
      checkSquare: c.inCheck() ? kingSquare(c, c.turn()) : null,
      legalMoves: humanToMove
        ? c.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, promotion: m.promotion ?? null, san: m.san }))
        : [],
      pgn: c.pgn(),
      thinking: this.thinking,
      lastError: this.lastError,
      llmTurns: this.llmTurns,
      result: this.result,
    };
  }
}

/** Split a free-form answer into the move (last "MOVE: x") and the reason (last "REASON: ..."). */
export function parseAnswer(answer) {
  return { move: extractMove(answer), reason: extractReason(answer) };
}

export function extractMove(answer) {
  const tagged = [...answer.matchAll(/^[\s*_#>-]*MOVE\s*[:=-]\s*[*_`"']*\s*([^\s*_`"']+)/gim)];
  let token = tagged.length ? tagged.at(-1)[1] : null;
  if (!token) {
    const bare = answer.trim().replace(/^[*_`"']+|[*_`"']+$/g, '');
    if (/^\S+$/.test(bare)) token = bare;
  }
  if (!token) return null;
  token = token
    .replace(/^\d+\.+/, '') // "12.Nf3" / "12...Nf3"
    .replace(/[.,;:!?)\]]+$/, '') // trailing punctuation / annotations
    .replace(/0-0-0/g, 'O-O-O')
    .replace(/0-0/g, 'O-O');
  return token || null;
}

export function extractReason(answer) {
  const matches = [...answer.matchAll(/^[\s*_#>-]*REASON\s*[:=-]\s*([\s\S]*?)(?=^[\s*_#>-]*MOVE\s*[:=-]|$(?![\s\S]))/gim)];
  if (!matches.length) return null;
  const reason = matches
    .at(-1)[1]
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!reason) return null;
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason;
}

function boardDiagram(chess) {
  const rows = chess.board().map((rank, i) => {
    const cells = rank.map((sq) => (sq ? (sq.color === 'w' ? sq.type.toUpperCase() : sq.type) : '.'));
    return `${8 - i} | ${cells.join(' ')}`;
  });
  return ['  +----------------', ...rows, '  +----------------', '    a b c d e f g h'].join('\n');
}

function pgnMoves(chess) {
  const sans = chess.history();
  const parts = [];
  for (let i = 0; i < sans.length; i += 2) {
    parts.push(`${i / 2 + 1}. ${sans[i]}${sans[i + 1] ? ` ${sans[i + 1]}` : ''}`);
  }
  return parts.join(' ');
}

function kingSquare(chess, color) {
  for (const rank of chess.board()) {
    for (const sq of rank) {
      if (sq && sq.type === 'k' && sq.color === color) return sq.square;
    }
  }
  return null;
}
