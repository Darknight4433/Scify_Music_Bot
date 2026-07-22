/**
 * playlistPlayback.js — Playlist playback bridge for the Scify Music renderer.
 *
 * Provides playAll, playTrack, and addToQueue functions that send
 * play commands to the bot API via the preload IPC bridge.
 *
 * Uses window.scify.api.post and window.scify.getSettings in the browser.
 * Exports via module.exports for testability.
 */

// ── Toast helper ──────────────────────────────────────────────────────────────

/**
 * Display a brief toast notification in the renderer.
 * Falls back to the existing toast() global if available, otherwise creates one.
 * @param {string} message - Text to display
 * @param {'success'|'error'|''} type - Toast style type
 */
function showToast(message, type = '') {
  // Use global toast from app.js if available
  if (typeof toast === 'function') {
    toast(message, type);
    return;
  }

  // Fallback: inject a toast manually
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Settings validation ───────────────────────────────────────────────────────

/**
 * Retrieve guildId and channelId from settings.
 * Returns null and shows an error toast if not configured.
 * @returns {Promise<{guildId: string, channelId: string}|null>}
 */
async function getPlaybackSettings() {
  const settings = await window.scify.getSettings();
  const { guildId, channelId } = settings || {};

  if (!guildId || !channelId) {
    showToast('No server configured. Go to Settings first.', 'error');
    return null;
  }

  return { guildId, channelId };
}

// ── Playback functions ────────────────────────────────────────────────────────

/**
 * Play all tracks in the playlist starting from the first.
 * Sends the first track as immediate play, then enqueues the rest.
 * The bot automatically enqueues tracks when something is already playing.
 *
 * @param {Array} sortedTracks - Tracks in current sort order, each with a `query` field
 * @returns {Promise<void>}
 */
async function playAll(sortedTracks) {
  if (!sortedTracks || sortedTracks.length === 0) return;

  const config = await getPlaybackSettings();
  if (!config) return;

  const { guildId, channelId } = config;

  try {
    showToast(`Queuing ${sortedTracks.length} tracks…`);
    
    // Use batch endpoint for speed — sends all queries at once
    const queries = sortedTracks.map((t) => t.query).filter(Boolean);
    
    await window.scify.api.post('/play-batch', {
      guildId,
      channelId,
      queries,
      requestedBy: 'Scify App',
    });

    showToast(`Playing ${sortedTracks.length} track(s) ✓`, 'success');
  } catch (err) {
    // Fallback: try individual /play for first track if batch fails
    try {
      await window.scify.api.post('/play', {
        guildId,
        channelId,
        query: sortedTracks[0].query,
        requestedBy: 'Scify App',
      });
      showToast(`Playing first track. Queue may still be loading…`, 'success');
    } catch (fallbackErr) {
      showToast(fallbackErr.message || 'Failed to start playback', 'error');
    }
  }
}

/**
 * Play a single track immediately.
 *
 * @param {object} track - Track object with a `query` field
 * @returns {Promise<void>}
 */
async function playTrack(track) {
  if (!track || !track.query) return;

  const config = await getPlaybackSettings();
  if (!config) return;

  const { guildId, channelId } = config;

  try {
    await window.scify.api.post('/play', {
      guildId,
      channelId,
      query: track.query,
      requestedBy: 'Scify App',
    });

    showToast(`Playing: ${track.title || track.query}`, 'success');
  } catch (err) {
    showToast(err.message || 'Failed to play track', 'error');
  }
}

/**
 * Add one or more tracks to the end of the current queue.
 * Each track is sent via POST /play — the bot enqueues them when
 * something is already playing, or starts playback if idle.
 *
 * @param {Array} tracks - Tracks to enqueue in display order, each with a `query` field
 * @returns {Promise<void>}
 */
async function addToQueue(tracks) {
  if (!tracks || tracks.length === 0) return;

  const config = await getPlaybackSettings();
  if (!config) return;

  const { guildId, channelId } = config;

  try {
    for (const track of tracks) {
      await window.scify.api.post('/play', {
        guildId,
        channelId,
        query: track.query,
        requestedBy: 'Scify App',
      });
    }

    showToast(`Added ${tracks.length} track(s) to queue`, 'success');
  } catch (err) {
    showToast(err.message || 'Failed to add to queue', 'error');
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { playAll, playTrack, addToQueue, showToast, getPlaybackSettings };
}
