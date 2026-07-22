/**
 * playlistRender.js — Rendering functions for playlist tracks and headers.
 *
 * Pure functions that produce HTML strings based on track data and view mode.
 * Loaded in the renderer via a <script> tag (no bundler).
 */

/**
 * Format milliseconds as "m:ss" (e.g. 180000 → "3:00", 65000 → "1:05").
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Formatted duration string
 */
function formatDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str - Raw string
 * @returns {string} HTML-safe string
 */
function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Render a single track row based on the active view mode.
 * @param {object} track - Track object with title, artist, album, durationMs, thumbnail
 * @param {number} index - Track index in the current sorted list
 * @param {'list' | 'compact'} mode - Current view mode
 * @param {boolean} isPlaying - Whether this track is currently playing
 * @returns {string} HTML string for the track row
 */
function renderTrackRow(track, index, mode, isPlaying) {
  const title = escHtml(track.title || '');
  const artist = escHtml(track.artist || '');
  const album = escHtml(track.album || '');
  const duration = formatDuration(track.durationMs || 0);
  const playingClass = isPlaying ? ' is-playing' : '';
  const compactClass = mode === 'compact' ? ' compact' : '';

  // Thumbnail (only in List mode)
  const thumbnailHtml = mode === 'compact' ? '' : (
    `<div class="ptr-thumb-wrap">` +
      (track.thumbnail
        ? `<img class="ptr-thumb-img" src="${escHtml(track.thumbnail)}" alt="" width="48" height="48" loading="lazy" />`
        : `<div class="ptr-thumb-placeholder">🎵</div>`) +
      `<div class="ptr-play-overlay">▶</div>` +
    `</div>`
  );

  // Play button for compact mode (visible on hover since there's no thumbnail)
  const compactPlayHtml = mode === 'compact'
    ? `<button class="ptr-play-btn" title="Play">▶</button>`
    : '';

  // Album column (hidden in compact mode via CSS, but include in markup for list mode)
  const albumHtml = album ? `<span class="ptr-album">${album}</span>` : `<span class="ptr-album"></span>`;

  return `<div class="playlist-track-row${compactClass}${playingClass}" data-index="${index}">` +
    compactPlayHtml +
    thumbnailHtml +
    `<div class="ptr-info">` +
      `<span class="ptr-title">${title}</span>` +
      `<span class="ptr-artist">${artist}</span>` +
      albumHtml +
    `</div>` +
    `<span class="ptr-duration">${duration}</span>` +
    `<button class="ptr-queue-btn" title="Add to queue">+ Queue</button>` +
  `</div>`;
}

/**
 * Render the playlist header section (cover, name, count, source badge).
 * @param {object} playlist - Playlist object with name, coverUrl, trackCount, source
 * @returns {string} HTML string for the playlist header
 */
function renderPlaylistHeader(playlist) {
  const name = escHtml(playlist.name || '');
  const trackCount = playlist.trackCount || 0;
  const source = escHtml(playlist.source || '');

  const coverHtml = playlist.coverUrl
    ? `<img class="playlist-cover" src="${escHtml(playlist.coverUrl)}" alt="${name}" width="120" height="120" />`
    : `<div class="playlist-cover placeholder" style="width:120px;height:120px;"></div>`;

  return `<div class="playlist-header">` +
    coverHtml +
    `<div class="playlist-header-info">` +
      `<h2 class="playlist-name">${name}</h2>` +
      `<span class="playlist-track-count">${trackCount} tracks</span>` +
      `<span class="playlist-source-badge source-${source}">${source}</span>` +
    `</div>` +
  `</div>`;
}

// Export for testing (Node/Vitest) while remaining usable in browser via <script>
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatDuration, renderTrackRow, renderPlaylistHeader, escHtml };
}
