/**
 * playlistStore.js — Playlist data utilities for Scify Music.
 *
 * Contains pure functions for playlist serialization/deserialization and
 * store operations that can be tested independently of Electron.
 */

/**
 * Deserialize a raw playlist object from storage, filling in default values
 * for any missing or null track fields.
 * @param {object} raw - Raw playlist object from electron-store
 * @returns {object} Playlist with all track fields normalized
 */
export function deserializePlaylist(raw) {
  if (!raw) return raw;
  const tracks = (raw.tracks || []).map((t) => ({
    title: (t && typeof t.title === 'string') ? t.title : '',
    artist: (t && typeof t.artist === 'string') ? t.artist : '',
    album: (t && typeof t.album === 'string') ? t.album : '',
    durationMs: (t && typeof t.durationMs === 'number') ? t.durationMs : 0,
    thumbnail: (t && typeof t.thumbnail === 'string') ? t.thumbnail : null,
    query: (t && typeof t.query === 'string') ? t.query : '',
    addedAt: (t && typeof t.addedAt === 'number') ? t.addedAt : 0,
  }));
  return {
    id: raw.id || '',
    name: raw.name || '',
    description: raw.description || '',
    coverUrl: (typeof raw.coverUrl === 'string') ? raw.coverUrl : null,
    source: raw.source || 'spotify',
    sourceUrl: raw.sourceUrl || '',
    trackCount: typeof raw.trackCount === 'number' ? raw.trackCount : tracks.length,
    tracks,
    syncedAt: typeof raw.syncedAt === 'number' ? raw.syncedAt : 0,
  };
}

/**
 * Upsert a playlist into the playlists array.
 * If a playlist with the same ID already exists, replace it; otherwise append.
 * @param {object[]} playlists - Current playlists array
 * @param {object} playlist - The playlist to upsert
 * @returns {object[]} Updated playlists array
 */
export function upsertPlaylist(playlists, playlist) {
  const existing = [...playlists];
  const idx = existing.findIndex((p) => p.id === playlist.id);
  if (idx >= 0) {
    existing[idx] = playlist;
  } else {
    existing.push(playlist);
  }
  return existing;
}
