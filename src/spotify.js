/**
 * Fetch Spotify playlist tracks using the public embed/oembed endpoint.
 * No API key or Premium account needed.
 * Falls back to scraping the embed page for track data.
 */

/**
 * Extract playlist ID from a Spotify URL.
 */
function extractPlaylistId(url) {
  const urlMatch = url.match(/playlist\/([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  const uriMatch = url.match(/playlist:([a-zA-Z0-9]+)/);
  if (uriMatch) return uriMatch[1];
  return null;
}

/**
 * Fetch all tracks from a Spotify playlist using the embed page.
 * Returns { name, tracks: [{ title, artist, searchQuery, durationInSec }] }
 */
export async function fetchSpotifyPlaylist(url) {
  const playlistId = extractPlaylistId(url);
  if (!playlistId) {
    throw new Error('Invalid Spotify playlist URL. Use a link like `https://open.spotify.com/playlist/...`');
  }

  // Use the embed endpoint which doesn't require auth
  const embedUrl = `https://open.spotify.com/embed/playlist/${playlistId}`;

  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch playlist (${res.status}). Make sure the playlist is public.`);
  }

  const html = await res.text();

  // The embed page contains a <script id="__NEXT_DATA__"> tag with JSON data
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nextDataMatch) {
    // Fallback: try extracting from resource script
    return fetchViaAnonymousApi(playlistId);
  }

  try {
    const data = JSON.parse(nextDataMatch[1]);
    const entity = data?.props?.pageProps?.state?.data?.entity;

    if (!entity) {
      return fetchViaAnonymousApi(playlistId);
    }

    const playlistName = entity.name || 'Spotify Playlist';
    const trackList = entity.trackList || [];

    if (trackList.length === 0) {
      return fetchViaAnonymousApi(playlistId);
    }

    const tracks = trackList.map((t) => {
      const title = t.title || 'Unknown';
      const artist = t.subtitle || 'Unknown';
      return {
        title: `${title} - ${artist}`,
        artist,
        searchQuery: `${title} ${artist}`,
        durationInSec: Math.floor((t.duration || 0) / 1000),
      };
    });

    return { name: playlistName, tracks };
  } catch {
    return fetchViaAnonymousApi(playlistId);
  }
}

/**
 * Fallback: use Spotify's anonymous accesstoken endpoint to get playlist data.
 */
async function fetchViaAnonymousApi(playlistId) {
  // Get anonymous access token
  const tokenRes = await fetch('https://open.spotify.com/get_access_token?reason=transport&productType=embed', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    },
  });

  if (!tokenRes.ok) {
    throw new Error('Failed to get Spotify access. Try again later.');
  }

  const tokenData = await tokenRes.json();
  const token = tokenData.accessToken;

  if (!token) {
    throw new Error('Could not obtain Spotify access token.');
  }

  // Fetch playlist with anonymous token
  const playlistRes = await fetch(
    `https://api.spotify.com/v1/playlists/${playlistId}?fields=name,tracks.items(track(name,artists(name),duration_ms)),tracks.next`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (playlistRes.status === 404) throw new Error('Playlist not found. Make sure it\'s public.');
  if (!playlistRes.ok) {
    const body = await playlistRes.text().catch(() => '');
    throw new Error(`Spotify error: ${playlistRes.status} — ${body}`);
  }

  const playlist = await playlistRes.json();
  const playlistName = playlist.name || 'Spotify Playlist';

  const tracks = [];
  for (const item of playlist.tracks?.items || []) {
    if (!item.track) continue;
    const title = item.track.name || 'Unknown';
    const artist = item.track.artists?.map((a) => a.name).join(', ') || 'Unknown';
    tracks.push({
      title: `${title} - ${artist}`,
      artist,
      searchQuery: `${title} ${artist}`,
      durationInSec: Math.floor((item.track.duration_ms || 0) / 1000),
    });
  }

  // Handle pagination if needed (anonymous token may still support it)
  let nextUrl = playlist.tracks?.next;
  while (nextUrl) {
    const nextRes = await fetch(nextUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!nextRes.ok) break;
    const nextData = await nextRes.json();
    for (const item of nextData.items || []) {
      if (!item.track) continue;
      const title = item.track.name || 'Unknown';
      const artist = item.track.artists?.map((a) => a.name).join(', ') || 'Unknown';
      tracks.push({
        title: `${title} - ${artist}`,
        artist,
        searchQuery: `${title} ${artist}`,
        durationInSec: Math.floor((item.track.duration_ms || 0) / 1000),
      });
    }
    nextUrl = nextData.next || null;
  }

  if (tracks.length === 0) throw new Error('Playlist is empty or all tracks are unavailable.');

  return { name: playlistName, tracks };
}
