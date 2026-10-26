import fs from 'node:fs';
import path from 'node:path';

// One JSON file per game in DATA_DIR, so games survive restarts and redeploys.
// Writes go to a temp file that is then renamed over the old one, so a crash
// mid-write never leaves a half-written game behind.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class GameStore {
  constructor(dir) {
    this.dir = path.resolve(dir);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.accessSync(this.dir, fs.constants.W_OK); // fail at startup, not on the first move
  }

  file(id) {
    if (!ID_RE.test(id)) return null; // ids come from URLs: never build a path from anything else
    return path.join(this.dir, `${id}.json`);
  }

  save(game) {
    const file = this.file(game.id);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(game.serialize()));
      fs.renameSync(tmp, file);
    } catch (err) {
      // Keep playing even if the disk is full or read-only; the game is still in memory.
      console.error(`[store] could not save game ${game.id}: ${err.message}`);
      fs.rmSync(tmp, { force: true });
    }
  }

  /** The saved game data, or null if there is none. */
  load(id) {
    const file = this.file(id);
    if (!file) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[store] could not read game ${id}: ${err.message}`);
      return null;
    }
  }

  /** Delete saved games not touched for longer than maxAgeMs. */
  prune(maxAgeMs) {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue;
      const file = path.join(this.dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) {
          fs.rmSync(file);
          removed++;
        }
      } catch {
        /* deleted meanwhile */
      }
    }
    if (removed) console.log(`[store] removed ${removed} game(s) older than ${Math.round(maxAgeMs / 86_400_000)} days`);
  }

  count() {
    return fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).length;
  }
}
