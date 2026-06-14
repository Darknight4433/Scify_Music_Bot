import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Anchor data directory to the project root regardless of working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'library.json');

const MAX_HISTORY = 25;
const MAX_USER_LIBRARY = 50;

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

  // ---------- Per-user library ----------

  _userLibraries(guildId) {
    const g = this._guild(guildId);
    if (!g.userLibraries) g.userLibraries = {};
    return g.userLibraries;
  }

  _userLib(guildId, userId) {
    const libs = this._userLibraries(guildId);
    if (!libs[userId]) libs[userId] = [];
    return libs[userId];
  }

  /**
   * Add one or more tracks to a user's personal library. Dedupes by URL.
   */
  addToUserLibrary(guildId, userId, tracks) {
    const lib = this._userLib(guildId, userId);
    for (const track of tracks) {
      if (!track?.url) continue;
      // Remove if already exists (will re-add at end)
      const idx = lib.findIndex((t) => t.url === track.url);
      if (idx !== -1) lib.splice(idx, 1);
      lib.push({ url: track.url, title: track.title, durationInSec: track.durationInSec ?? 0 });
    }
    // Cap it
    if (lib.length > MAX_USER_LIBRARY) lib.splice(0, lib.length - MAX_USER_LIBRARY);
    this._userLibraries(guildId)[userId] = lib;
    this._save();
  }

  /**
   * Remove a track from a user's library by index.
   */
  removeFromUserLibrary(guildId, userId, index) {
    const lib = this._userLib(guildId, userId);
    if (index < 0 || index >= lib.length) return null;
    const [removed] = lib.splice(index, 1);
    this._save();
    return removed;
  }

  getUserLibrary(guildId, userId) {
    return this._userLib(guildId, userId);
  }

  // ---------- Temporary Spotify import storage (in-memory, not persisted) ----------

  saveSpotifyImport(guildId, userId, data) {
    if (!this._spotifyImports) this._spotifyImports = {};
    this._spotifyImports[`${guildId}:${userId}`] = data;
  }

  getSpotifyImport(guildId, userId) {
    if (!this._spotifyImports) return null;
    return this._spotifyImports[`${guildId}:${userId}`] || null;
  }

  clearSpotifyImport(guildId, userId) {
    if (!this._spotifyImports) return;
    delete this._spotifyImports[`${guildId}:${userId}`];
  }
}

export const store = new Store();
