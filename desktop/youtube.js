/**
 * youtube.js — YouTube playlist importer for Scify Music.
 *
 * Resolves YouTube playlists by calling the bot's REST API endpoint
 * POST /resolve-playlist, which uses yt-dlp under the hood.
 *
 * The result is mapped into the unified StoredPlaylist schema shared
 * with the Spotify importer.
 */

/**
 * Validate that a URL looks like a YouTube playlist (contains `list=`).
 * @param {string} url
 * @returns {boolean}
 */
function isValidYouTubePlaylistUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const validHosts = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com'];
    if (!validHosts.includes(parsed.hostname)) return false;
    return parsed.searchParams.has('list');
  } catch {
    return false;
  }
}

/**
 * Fetch and normalize a YouTube playlist into the unified StoredPlaylist schema.
 *
 * @param {string} url - A YouTube playlist URL (must contain `list=` parameter)
 * @param {(method: string, urlPath: string, body?: object) => Promise<any>} apiRequest
 *   The same apiRequest function used in main.js to call the bot's REST API.
 * @returns {Promise<object>} A StoredPlaylist object
 * @throws {Error} If the URL is invalid or the playlist cannot be resolved
 */
export async function fetchYouTubePlaylist(url, apiRequest) {
  // 1. Validate URL
  if (!isValidYouTubePlaylistUrl(url)) {
    throw new Error(
      'Invalid YouTube playlist URL. Please paste a link like https://www.youtube.com/playlist?list=PLxxxxx',
    );
  }

  // 2. Call bot API to resolve the playlist
  let data;
  try {
    data = await apiRequest('POST', '/resolve-playlist', { url });
  } catch (err) {
    throw new Error(
      `Could not load YouTube playlist — it may be private or region-locked. (${err.message})`,
    );
  }

  // 3. Validate response structure
  if (!data || !data.playlistId || !Array.isArray(data.tracks)) {
    throw new Error(
      'YouTube playlist could not be resolved — the bot returned an unexpected response.',
    );
  }

  // 4. Map response into unified StoredPlaylist schema
  const now = Date.now();

  return {
    id: data.playlistId,
    name: data.title || 'Untitled Playlist',
    description: '',
    coverUrl: data.thumbnail || null,
    source: 'youtube',
    sourceUrl: url,
    trackCount: data.tracks.length,
    tracks: data.tracks.map((t) => ({
      title: t.title || '',
      artist: t.artist || t.channel || '',
      album: '',
      durationMs: (t.durationSec || 0) * 1000,
      thumbnail: t.thumbnail || null,
      query: t.url || `${t.artist || t.channel || ''} - ${t.title || ''}`,
      addedAt: now,
    })),
    syncedAt: now,
  };
}
