import crypto from 'node:crypto';
import { Chess, type Color, type Square } from 'chess.js';
import { type LangfuseAgent, propagateAttributes, startActiveObservation, startObservation } from '@langfuse/tracing';
import { type Config, type Llm, resolveLlm } from './config.ts';
import { engineMove, engineReason } from './engine.ts';
import { type ChatMessage, chat } from './llm.ts';

const COLOR_NAME: Record<Color, string> = { w: 'White', b: 'Black' };
const OTHER: Record<Color, Color> = { w: 'b', b: 'w' };
const MAX_REASON_LENGTH = 500;
// Draw offers: from this move number, at most once per side every DRAW_COOLDOWN_MOVES moves,
// so a model can't use them to escape every hard position.
const DRAW_MIN_MOVE = 30;
const DRAW_COOLDOWN_MOVES = 10;
// Stockfish offers a draw when its evaluation is within this many centipawns of equal,
// and accepts one when it is no better than this for itself.
const ENGINE_DRAW_CP = 25;
const ACCEPT_DRAW = /^(accept[-_ ]?draw|accept|draw)$/i;

/** What is shown and saved about a player; never the API key or URL. */
interface PlayerInfo {
  id: string;
  name: string;
  provider: string;
  model: string;
  icon: string;
}

/** A saved game's LLM that is no longer in the config: its name still shows, but it can't move. */
interface MissingLlm extends PlayerInfo {
  missing: true;
}

/** An LLM side; null is the human player. */
type Player = Llm | MissingLlm | null;

export interface GameResult {
  winner: Color | null; // null: draw
  reason: string;
  text: string;
  detail: string | null;
}

interface Attempt {
  answer: string;
  move: string | null;
  error: string | null;
}

export interface LlmTurn {
  ply: number;
  color: Color;
  llm: string;
  attempts: Attempt[];
  move: string | null;
  reason: string | null;
  resigned: boolean;
  drawOffered?: boolean; // offered a draw along with its move
  drawAccepted?: boolean; // accepted the opponent's offer instead of moving
  error: string | null;
}

/** A game as stored on disk (see GameStore). */
export interface SavedGame {
  version: 1;
  id: string;
  createdAt: number;
  touchedAt: number;
  players: Record<Color, PlayerInfo | null>;
  pgn: string;
  reasons: (string | null)[];
  drawOffers?: number[];
  result: GameResult | null;
  llmTurns: LlmTurn[];
  lastError: string | null;
  paused: boolean;
}

interface GameOptions {
  white: Player;
  black: Player;
  maxAttempts: number;
  requestTimeoutMs: number;
  id?: string;
}

const playerInfo = (llm: Player): PlayerInfo | null =>
  llm && { id: llm.id, name: llm.name, provider: llm.provider, model: llm.model, icon: llm.icon };

function systemPrompt(opponent: string): string {
  return `You are a strong chess player taking part in a game against ${opponent}.
On every turn you receive the current position and your opponent's last move, and you must choose your next move.

Rules for your answer:
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
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export class Game {
  readonly id: string;
  createdAt: number;
  touchedAt: number;
  readonly players: Record<Color, Player>;
  readonly mode: 'watch' | 'human';
  readonly playerColor: Color | null;
  readonly maxAttempts: number;
  readonly requestTimeoutMs: number;
  readonly chess: Chess;
  reasons: (string | null)[];
  drawOffers: number[];
  result: GameResult | null;
  thinking: boolean;
  llmTurns: LlmTurn[];
  lastError: string | null;
  paused: boolean;

  /**
   * @param white / black  an LLM entry from config.llms, or null for the human player
   */
  constructor({ white, black, maxAttempts, requestTimeoutMs, id = crypto.randomUUID() }: GameOptions) {
    if (!white && !black) throw new GameError('At least one side must be an LLM');
    this.id = id;
    this.createdAt = Date.now();
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
    this.drawOffers = []; // plies whose move came with a draw offer; it stands until the opponent's next move
    this.result = null; // { winner: 'w' | 'b' | null, reason, text, detail? }
    this.thinking = false;
    this.llmTurns = []; // [{ ply, color, llm, attempts: [{ answer, move, error }], move, reason, resigned, error }]
    this.lastError = null; // last provider/network error, cleared on next attempt
    this.paused = false; // LLM vs LLM: the viewer paused the game (kept across reloads and restarts)
    this.touchedAt = Date.now();
  }

  get isOver(): boolean {
    return this.result !== null;
  }

  nameOf(color: Color): string {
    return this.players[color]?.name ?? 'You';
  }

  /** "You", "Claude", or "Claude (White)" when watching (both sides may be the same model). */
  labelOf(color: Color): string {
    return this.mode === 'watch' ? `${this.nameOf(color)} (${COLOR_NAME[color]})` : this.nameOf(color);
  }

  winText(winner: Color): string {
    if (this.mode === 'human') return winner === this.playerColor ? 'You win!' : `${this.nameOf(winner)} wins.`;
    return `${this.labelOf(winner)} wins.`;
  }

  playerMove({ from, to, promotion, offerDraw }: { from: string; to: string; promotion?: string; offerDraw?: boolean }): void {
    this.touch();
    if (this.isOver) throw new GameError('Game is over');
    if (this.mode !== 'human' || this.chess.turn() !== this.playerColor) throw new GameError('It is not your turn');
    const ply = this.chess.history().length;
    if (offerDraw && !this.canOfferDraw(this.playerColor, ply)) {
      throw new GameError(`You can offer a draw from move ${DRAW_MIN_MOVE}, once every ${DRAW_COOLDOWN_MOVES} moves`);
    }
    try {
      this.chess.move({ from, to, promotion });
    } catch {
      throw new GameError(`Illegal move: ${from}-${to}${promotion ? `=${promotion}` : ''}`);
    }
    if (offerDraw) this.drawOffers.push(ply);
    this.checkGameOver();
  }

  /** The human accepts the LLM's draw offer. */
  acceptDraw(): void {
    this.touch();
    if (this.isOver) throw new GameError('Game is over');
    if (this.mode !== 'human' || this.chess.turn() !== this.playerColor) throw new GameError('It is not your turn');
    if (!this.drawOffered()) throw new GameError('There is no draw offer to accept');
    this.finish(null, 'agreement', 'You accepted the draw offer. Draw agreed.');
  }

  /** Whether the side to move has a draw offer to answer: the last move came with one. */
  drawOffered(): boolean {
    const last = this.chess.history().length - 1;
    return !this.isOver && last >= 0 && this.drawOffers.at(-1) === last;
  }

  /** Whether `color` may offer a draw with the move at `ply`. */
  canOfferDraw(color: Color, ply: number): boolean {
    if (this.isOver || Math.floor(ply / 2) + 1 < DRAW_MIN_MOVE) return false;
    const own = this.drawOffers.filter((p) => (p % 2 === 0 ? 'w' : 'b') === color).at(-1);
    return own === undefined || ply - own >= DRAW_COOLDOWN_MOVES * 2;
  }

  /** Pause or resume an LLM vs LLM game. A move already being thought about still completes. */
  setPaused(paused: unknown): void {
    this.touch();
    if (this.mode !== 'watch') throw new GameError('Only LLM vs LLM games can be paused');
    this.paused = !!paused;
  }

  resign(): void {
    this.touch();
    if (this.isOver) throw new GameError('Game is over');
    if (this.mode !== 'human' || !this.playerColor) throw new GameError('Only a human player can resign here');
    const winner = OTHER[this.playerColor];
    this.finish(winner, 'resignation', `You resigned. ${this.nameOf(winner)} wins.`);
  }

  /**
   * Ask the LLM to move for the side to play, validating every answer and re-prompting
   * (with the rejected answer and the reason) until it plays a legal move, resigns,
   * or runs out of attempts, in which case it forfeits.
   */
  async llmMove(): Promise<void> {
    this.touch();
    if (this.isOver) throw new GameError('Game is over');
    const color = this.chess.turn();
    const llm = this.players[color];
    if (!llm) throw new GameError("It is not an LLM's turn");
    if ('missing' in llm) {
      // shown like a provider error (with Retry), so the client doesn't keep asking
      this.lastError = `${llm.name} is no longer in the server's config, so this game can't continue`;
      throw new GameError(this.lastError, 422);
    }
    if (this.thinking) throw new GameError('The LLM is already thinking', 409);

    this.thinking = true;
    this.lastError = null;
    const ply = this.chess.history().length;
    const turn: LlmTurn = { ply, color, llm: llm.name, attempts: [], move: null, reason: null, resigned: false, error: null };
    this.llmTurns.push(turn);

    try {
      if (llm.provider === 'engine') {
        // not traced: an engine move costs nothing and would skew the LLM stats
        await this.playEngineTurn(turn, llm, color);
      } else {
        // One trace per LLM move; all moves of a game share a session.
        await propagateAttributes(
          {
            sessionId: this.id,
            tags: [this.opponentKind(color)],
            metadata: { gameId: this.id, llmId: llm.id, side: COLOR_NAME[color], ply },
          },
          () => startActiveObservation('choose-move', (agent) => this.playTurn(agent, turn, llm, color), { asType: 'agent' }),
        );
      }
    } catch (err) {
      turn.error = (err as Error).message;
      this.lastError = turn.error;
      // Drop the turn entry if nothing was attempted, so a retry starts clean.
      if (turn.attempts.length === 0) this.llmTurns.pop();
      throw err;
    } finally {
      this.thinking = false;
    }
  }

  async playTurn(agent: LangfuseAgent, turn: LlmTurn, llm: Llm, color: Color): Promise<void> {
    const last = this.chess.history({ verbose: true }).at(-1);
    agent.update({
      input: {
        side: COLOR_NAME[color],
        moveNumber: Math.floor(turn.ply / 2) + 1,
        opponentLastMove: last?.san ?? null,
        fen: this.chess.fen(),
        ...(this.drawOffered() ? { drawOfferPending: true } : {}),
      },
    });
    const opponent = { 'vs-human': 'a human', 'vs-engine': 'a chess engine', 'llm-vs-llm': 'another AI model' }[this.opponentKind(color)];
    const messages: ChatMessage[] = [{ role: 'user', content: this.buildPrompt(color, llm) }];

    try {
      while (turn.attempts.length < this.maxAttempts) {
        // Provider/network errors propagate: the turn stays with the LLM and the client can retry.
        const answer = await chat(llm, systemPrompt(opponent), messages, {
          timeoutMs: llm.timeoutMs ?? this.requestTimeoutMs,
          name: 'generate-move',
          metadata: { attempt: turn.attempts.length + 1 },
        });
        const attempt: Attempt = { answer, move: null, error: null };
        turn.attempts.push(attempt);
        const { move, reason, offersDraw } = parseAnswer(answer);

        if (move && /^resign/i.test(move)) {
          attempt.move = 'resign';
          turn.resigned = true;
          turn.reason = reason;
          const winner = OTHER[color];
          this.finish(winner, 'resignation', `${this.labelOf(color)} resigns. ${this.winText(winner)}`, reason);
          agent.update({ output: { resigned: true, reason }, metadata: { attempts: turn.attempts.length } });
          return;
        }

        let error: string | undefined;
        if (move && ACCEPT_DRAW.test(move)) {
          if (this.drawOffered()) {
            attempt.move = 'accept-draw';
            turn.drawAccepted = true;
            turn.reason = reason;
            this.finish(null, 'agreement', this.drawAcceptedText(color), reason);
            agent.update({ output: { acceptedDraw: true, reason }, metadata: { attempts: turn.attempts.length } });
            return;
          }
          error = 'There is no draw offer to accept. Play a move.';
        } else {
          const validation = startObservation('validate-move', { input: { move } }, { asType: 'guardrail' });
          const applied = this.tryApply(move, color);
          validation
            .update(
              applied.san
                ? { output: { legal: true, san: applied.san } }
                : { output: { legal: false, error: applied.error }, level: 'WARNING', statusMessage: applied.error },
            )
            .end();

          if (applied.san) {
            attempt.move = applied.san;
            turn.move = applied.san;
            turn.reason = reason;
            this.reasons[turn.ply] = reason;
            // an offer the prompt didn't allow (too early, too soon after the last one) is ignored
            if (offersDraw && this.canOfferDraw(color, turn.ply)) {
              this.drawOffers.push(turn.ply);
              turn.drawOffered = true;
            }
            this.checkGameOver();
            agent.update({
              output: { move: applied.san, reason, ...(turn.drawOffered ? { drawOffered: true } : {}) },
              metadata: { attempts: turn.attempts.length, ...(this.result ? { result: this.result.reason } : {}) },
            });
            return;
          }
          error = applied.error;
        }

        attempt.error = error ?? null;
        messages.push({ role: 'assistant', content: answer });
        messages.push({ role: 'user', content: this.buildRetryPrompt(answer, error ?? '', turn.attempts.length, llm) });
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
      agent.update({ level: 'ERROR', statusMessage: (err as Error).message, metadata: { attempts: turn.attempts.length } });
      throw err;
    }
  }

  /** Who plays against `color`; also the Langfuse tag of that side's moves. */
  opponentKind(color: Color): 'vs-human' | 'vs-engine' | 'llm-vs-llm' {
    const opponent = this.players[OTHER[color]];
    if (!opponent) return 'vs-human';
    return opponent.provider === 'engine' ? 'vs-engine' : 'llm-vs-llm';
  }

  /** Stockfish's move, recorded like a one-attempt LLM turn so the move log shows it. */
  async playEngineTurn(turn: LlmTurn, engine: Llm, color: Color): Promise<void> {
    const result = await engineMove(engine, this.chess.history({ verbose: true }).map((m) => m.lan));
    const attempt: Attempt = { answer: result.log, move: null, error: null };
    turn.attempts.push(attempt);
    // the evaluation of the best line, from the engine's side; a mate counts as decisive
    const cp = !result.score ? null : 'mate' in result.score ? Math.sign(result.score.mate) * 100_000 : result.score.cp;

    if (this.drawOffered() && cp !== null && cp <= ENGINE_DRAW_CP) {
      attempt.move = 'accept-draw';
      turn.drawAccepted = true;
      turn.reason = `${engineReason(result, COLOR_NAME[color])} No advantage to play for, so it accepts the draw.`;
      this.finish(null, 'agreement', this.drawAcceptedText(color), turn.reason);
      return;
    }

    const { uci } = result;
    try {
      attempt.move = this.chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
    } catch {
      attempt.error = `"${uci}" is not a legal move`;
      throw new GameError(`${engine.name} played an illegal move: ${uci}`, 500);
    }
    let reason = engineReason(result, COLOR_NAME[color]);
    if (cp !== null && Math.abs(cp) <= ENGINE_DRAW_CP && this.canOfferDraw(color, turn.ply)) {
      this.drawOffers.push(turn.ply);
      turn.drawOffered = true;
      reason += ' The position is equal, so it offers a draw.';
    }
    turn.move = attempt.move;
    turn.reason = reason;
    this.reasons[turn.ply] = reason;
    this.checkGameOver();
  }

  drawAcceptedText(color: Color): string {
    if (this.mode === 'human') return `${this.nameOf(color)} accepts your draw offer. Draw agreed.`;
    return `${this.labelOf(color)} accepts the draw offer. Draw agreed.`;
  }

  /** Play the candidate move if it is legal. */
  tryApply(candidate: string | null, color: Color): { san?: string; error?: string } {
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

  buildPrompt(color: Color, llm: Llm): string {
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
    if (llm.showLegalMoves) lines.push('', `Legal moves: ${this.chess.moves().join(', ')}`);
    if (this.drawOffered()) {
      lines.push(
        '',
        'Your opponent offers a draw. To accept it, answer "MOVE: accept-draw" (with the REASON line); the game ends as a draw.',
        'To decline, simply play a move.',
      );
    }
    if (this.canOfferDraw(color, history.length)) {
      lines.push(
        '',
        'You may offer a draw together with your move: add the line "DRAW: offer" before the REASON line.',
        'Offer one only if you believe the position is a draw with best play; your opponent may decline and the game goes on.',
      );
    }
    lines.push('', 'Choose your move. End your answer with the "REASON: ..." and "MOVE: ..." lines.');
    return lines.join('\n');
  }

  buildRetryPrompt(answer: string, error: string, attemptNo: number, llm: Llm): string {
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
    if (llm.showLegalMoves) lines.push('', `Legal moves: ${this.chess.moves().join(', ')}`);
    lines.push('', 'Try again with a legal move. End your answer with the "REASON: ..." and "MOVE: ..." lines.');
    return lines.join('\n');
  }

  checkGameOver(): void {
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

  finish(winner: Color | null, reason: string, text: string, detail: string | null = null): void {
    this.result = { winner, reason, text, detail };
    this.chess.setHeader('Result', winner === 'w' ? '1-0' : winner === 'b' ? '0-1' : '1/2-1/2');
    if (winner && (reason === 'resignation' || reason === 'forfeit')) {
      this.chess.setHeader('Termination', `${this.nameOf(OTHER[winner])} ${reason === 'forfeit' ? 'forfeits' : 'resigns'}`);
    } else if (reason === 'agreement') {
      this.chess.setHeader('Termination', 'Draw by agreement');
    }
  }

  touch(): void {
    this.touchedAt = Date.now();
  }

  /** Everything needed to rebuild the game after a restart. API keys and URLs are never stored. */
  serialize(): SavedGame {
    return {
      version: 1,
      id: this.id,
      createdAt: this.createdAt,
      touchedAt: this.touchedAt,
      players: { w: playerInfo(this.players.w), b: playerInfo(this.players.b) },
      pgn: this.chess.pgn(),
      reasons: this.reasons,
      drawOffers: this.drawOffers,
      result: this.result,
      llmTurns: this.llmTurns,
      lastError: this.lastError,
      paused: this.paused,
    };
  }

  /** Rebuild a saved game. Players are looked up in the current config by id. */
  static restore(data: SavedGame, { llms, maxAttempts, requestTimeoutMs }: Pick<Config, 'llms' | 'maxAttempts' | 'requestTimeoutMs'>): Game {
    // A model removed from the config keeps its name on screen but can't move any more.
    const player = (saved: PlayerInfo | null): Player => saved && (resolveLlm(llms, saved.id) ?? { ...saved, missing: true });
    const game = new Game({ white: player(data.players.w), black: player(data.players.b), maxAttempts, requestTimeoutMs, id: data.id });
    game.chess.loadPgn(data.pgn);
    game.createdAt = data.createdAt;
    game.touchedAt = data.touchedAt;
    game.reasons = data.reasons ?? [];
    game.drawOffers = data.drawOffers ?? [];
    game.result = data.result;
    game.llmTurns = data.llmTurns ?? [];
    game.lastError = data.lastError;
    game.paused = !!data.paused;

    // A turn that was in progress when the server stopped: offer a retry instead of waiting forever.
    const turn = game.llmTurns.at(-1);
    if (turn && !turn.move && !turn.resigned && !turn.error && !game.result) {
      if (turn.attempts.length) turn.error = 'Interrupted by a server restart';
      else game.llmTurns.pop();
      game.lastError = 'Interrupted by a server restart';
    }
    return game;
  }

  toJSON() {
    const c = this.chess;
    const history = c.history({ verbose: true });
    const last = history.at(-1);
    const humanToMove = this.mode === 'human' && !this.isOver && c.turn() === this.playerColor;
    return {
      id: this.id,
      mode: this.mode,
      players: { w: playerInfo(this.players.w), b: playerInfo(this.players.b) },
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
        uci: m.lan,
        fen: m.after, // position after the move, for the in-browser engine
        reason: this.reasons[i] ?? null,
        drawOffer: this.drawOffers.includes(i),
      })),
      lastMove: last ? { from: last.from, to: last.to } : null,
      checkSquare: c.inCheck() ? kingSquare(c, c.turn()) : null,
      legalMoves: humanToMove
        ? c.moves({ verbose: true }).map((m) => ({ from: m.from, to: m.to, promotion: m.promotion ?? null, san: m.san }))
        : [],
      pgn: c.pgn(),
      drawOffered: this.drawOffered(), // the side to move has a draw offer to answer
      canOfferDraw: humanToMove && this.canOfferDraw(c.turn(), history.length),
      thinking: this.thinking,
      lastError: this.lastError,
      paused: this.paused,
      llmTurns: this.llmTurns,
      result: this.result,
    };
  }
}

/** Split a free-form answer into the move (last "MOVE: x"), the reason (last "REASON: ...") and a "DRAW: offer" line. */
export function parseAnswer(answer: string): { move: string | null; reason: string | null; offersDraw: boolean } {
  return {
    move: extractMove(answer),
    reason: extractReason(answer),
    offersDraw: /^[\s*_#>-]*DRAW\s*[:=-]\s*[*_`"']*\s*offer/im.test(answer),
  };
}

export function extractMove(answer: string): string | null {
  const tagged = [...answer.matchAll(/^[\s*_#>-]*MOVE\s*[:=-]\s*[*_`"']*\s*([^\s*_`"']+)/gim)];
  let token = tagged.at(-1)?.[1] ?? null;
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

export function extractReason(answer: string): string | null {
  const matches = [...answer.matchAll(/^[\s*_#>-]*REASON\s*[:=-]\s*([\s\S]*?)(?=^[\s*_#>-]*(?:MOVE|DRAW)\s*[:=-]|$(?![\s\S]))/gim)];
  if (!matches.length) return null;
  const reason = (matches.at(-1)?.[1] ?? '')
    .replace(/[*_`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!reason) return null;
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason;
}

function boardDiagram(chess: Chess): string {
  const rows = chess.board().map((rank, i) => {
    const cells = rank.map((sq) => (sq ? (sq.color === 'w' ? sq.type.toUpperCase() : sq.type) : '.'));
    return `${8 - i} | ${cells.join(' ')}`;
  });
  return ['  +----------------', ...rows, '  +----------------', '    a b c d e f g h'].join('\n');
}

function pgnMoves(chess: Chess): string {
  const sans = chess.history();
  const parts: string[] = [];
  for (let i = 0; i < sans.length; i += 2) {
    parts.push(`${i / 2 + 1}. ${sans[i]}${sans[i + 1] ? ` ${sans[i + 1]}` : ''}`);
  }
  return parts.join(' ');
}

function kingSquare(chess: Chess, color: Color): Square | null {
  for (const rank of chess.board()) {
    for (const sq of rank) {
      if (sq && sq.type === 'k' && sq.color === color) return sq.square;
    }
  }
  return null;
}
