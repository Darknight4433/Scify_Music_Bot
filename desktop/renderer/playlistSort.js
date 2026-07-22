/**
 * playlistSort.js — Pure sort logic for playlist tracks.
 *
 * Keeps sorting isolated and testable. The main app.js loads this
 * via a <script> tag (no bundler in the renderer).
 */

/**
 * Sort options available for playlist tracks.
 */
const SORT_OPTIONS = ['custom', 'title', 'artist', 'album', 'recentlyAdded', 'duration'];

/**
 * Assign originalIndex to each track based on its position in the array.
 * Call this once when tracks are first loaded from the store so that
 * "custom" sort can restore the original import order.
 *
 * @param {Array} tracks - Array of track objects
 * @returns {Array} Same array with originalIndex set on each track
 */
function assignOriginalIndices(tracks) {
  return tracks.map((track, index) => ({ ...track, originalIndex: index }));
}

/**
 * Sort tracks by the given criterion.
 * Returns a new sorted array — does NOT mutate the input.
 *
 * @param {Array} tracks - Array of track objects (each should have an `originalIndex` property)
 * @param {string} criterion - One of SORT_OPTIONS
 * @returns {Array} New sorted array
 */
function sortTracks(tracks, criterion) {
  if (!tracks || tracks.length === 0) {
    return [];
  }

  const copy = [...tracks];

  switch (criterion) {
    case 'custom':
      return copy.sort((a, b) => (a.originalIndex ?? 0) - (b.originalIndex ?? 0));

    case 'title':
      return copy.sort((a, b) => {
        const titleA = a.title || '';
        const titleB = b.title || '';
        return titleA.localeCompare(titleB);
      });

    case 'artist':
      return copy.sort((a, b) => {
        const artistA = a.artist || '';
        const artistB = b.artist || '';
        return artistA.localeCompare(artistB);
      });

    case 'album':
      return copy.sort((a, b) => {
        const albumA = a.album || '';
        const albumB = b.album || '';
        // Empty albums go to the end
        if (!albumA && albumB) return 1;
        if (albumA && !albumB) return -1;
        if (!albumA && !albumB) return 0;
        return albumA.localeCompare(albumB);
      });

    case 'recentlyAdded':
      return copy.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));

    case 'duration':
      return copy.sort((a, b) => (a.durationMs ?? 0) - (b.durationMs ?? 0));

    default:
      // Unknown criterion — return unsorted copy
      return copy;
  }
}

// Export for testing (Node/Vitest) while remaining usable in browser via <script>
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { SORT_OPTIONS, sortTracks, assignOriginalIndices };
}
