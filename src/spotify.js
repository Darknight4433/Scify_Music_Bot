import process from 'node:process';

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get an access token using Client Credentials flow (no user login needed).
 */
async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    throw new Error('Spotify API credentials not configured. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env');
  }

  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    throw new Error(`Spotify auth failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // Expire 60s early to be safe
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * Extract playlist ID from a Spotify URL.
 * Supports:
 *   https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
 *   https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=...
 *   spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
 */
function extractPlaylistId(url) {
  // URL format
  const urlMatch = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  // URI format
  const uriMatch = url.match(/playlist:([a-zA-Z0-9]+)/);
  if (uriMatch) return uriMatch[1];
  return null;
}

/**
 * Fetch all tracks from a Spotify playlist (handles pagination).
 * Returns { name, tracks: [{ title, artist, searchQuery }] }
 */
export async function fetchSpotifyPlaylist(url) {
  const playlistId = extractPlaylistId(url);
  if (!playlistId) {
    throw new Error('Invalid Spotify playlist URL. Use a link like `https://open.spotify.com/playlist/...`');
  }

  const token = await getToken();

  // Get playlist name + first page of tracks
  const tracks = [];
  let nextUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100&fields=next,items(track(name,artists(name),duration_ms))`;

  while (nextUrl) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 404) throw new Error('Playlist not found. Make sure it\'s public.');
    if (!res.ok) throw new Error(`Spotify API error: ${res.status}`);

    const data = await res.json();

    for (const item of data.items) {
      if (!item.track) continue; // local files or removed tracks
      const artist = item.track.artists?.map((a) => a.name).join(', ') || 'Unknown';
      const title = item.track.name;
      tracks.push({
        title: `${title} - ${artist}`,
        artist,
        searchQuery: `${title} ${artist}`,
        durationInSec: Math.floor((item.track.duration_ms || 0) / 1000),
      });
    }

    nextUrl = data.next || null;
  }

  // Get playlist name separately
  const infoRes = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}?fields=name,owner(display_name)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let playlistName = 'Spotify Playlist';
  if (infoRes.ok) {
    const info = await infoRes.json();
    playlistName = info.name || playlistName;
  }

  if (tracks.length === 0) throw new Error('Playlist is empty or all tracks are unavailable.');

  return { name: playlistName, tracks };
}
