import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor data directory to the project root regardless of working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'library.json');

const MAX_HISTORY = 25;

/**
 * Persistent per-guild store for:
 *  - history: recently played tracks (most recent first)
 *  - session: the last playback state (current track + position + remaining queue)
 *
 * Data is kept in data/library.json so it survives bot restarts.
 */
class Store {
  constructor() {
    this.data = { guilds: {} };
    this._load();
  }

  _load() {
    try {
      if (existsSync(DATA_FILE)) {
        this.data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
        if (!this.data.guilds) this.data.guilds = {};
      }
    } catch (err) {
      console.error('Failed to load library store:', err.message);
      this.data = { guilds: {} };
    }
  }

  _save() {
    try {
      if (!existsSync(DATA_DIR)) {
        mkdirSync(DATA_DIR, { recursive: true });
        // Restrict directory permissions (owner-only) on Linux/macOS.
        try { chmodSync(DATA_DIR, 0o700); } catch {}
      }
      writeFileSync(DATA_FILE, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('Failed to save library store:', err.message);
    }
  }

  _guild(guildId) {
    if (!this.data.guilds[guildId]) {
      this.data.guilds[guildId] = { history: [], session: null };
    }
    return this.data.guilds[guildId];
  }

  /**
   * Record a track that started playing. Dedupes by URL (most recent first).
   */
  addHistory(guildId, track) {
    if (!track?.url) return;
    const g = this._guild(guildId);
    g.history = g.history.filter((t) => t.url !== track.url);
    g.history.unshift({
      url: track.url,
      title: track.title,
      durationInSec: track.durationInSec ?? 0,
    });
    if (g.history.length > MAX_HISTORY) g.history.length = MAX_HISTORY;
    this._save();
  }

  getHistory(guildId) {
    return this._guild(guildId).history;
  }

  /**
   * Save the current playback session so it can be resumed later.
   * `session` = { track, positionSec, queue: [...] } or null to clear.
   */
  saveSession(guildId, session) {
    this._guild(guildId).session = session;
    this._save();
  }

  getSession(guildId) {
    return this._guild(guildId).session;
  }

  clearSession(guildId) {
    this._guild(guildId).session = null;
    this._save();
  }
}

export const store = new Store();
