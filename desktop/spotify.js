/**
 * spotify.js — Spotify playlist scraper for Scify Music.
 *
 * Uses Spotify's anonymous web-player token endpoint — NO developer account,
 * NO Client ID, NO OAuth login required. Works for any public playlist.
 *
 * Flow:
 *  1. getAnonToken()  → hits open.spotify.com for a guest token
 *  2. fetchPlaylistTracks(url) → pulls track names + artists via api.spotify.com
 *  3. syncAllPlaylists() → refreshes all saved playlists
 *  4. scheduleDailySync() → auto-runs on a configurable interval
 */

import { shell } from 'electron';

// ── Token management ──────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

export async function getAnonToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  // Try multiple methods to get an anonymous token
  const methods = [
    // Method A: Standard web player token endpoint
    async () => {
      const res = await fetch(
        'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
        {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'App-Platform': 'WebPlayer',
            'Accept': 'application/json',
            'Accept-Language': 'en-US,en;q=0.9',
            'Origin': 'https://open.spotify.com',
            'Referer': 'https://open.spotify.com/',
          },
        },
      );
      if (!res.ok) throw new Error(`Token endpoint returned ${res.status}`);
      return await res.json();
    },
    // Method B: Extract token from embed page HTML
    async () => {
      const res = await fetch('https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        },
      });
      if (!res.ok) throw new Error(`Embed page returned ${res.status}`);
      const html = await res.text();
      const match = html.match(/"accessToken":"([^"]+)"/);
      if (!match) throw new Error('No access token found in embed HTML');
      return { accessToken: match[1], accessTokenExpirationTimestampMs: Date.now() + 3600000 };
    },
  ];

  for (const method of methods) {
    try {
      const data = await method();
      cachedToken = data.accessToken;
      tokenExpiry = Date.now() + (data.accessTokenExpirationTimestampMs - Date.now()) - 5 * 60 * 1000;
      return cachedToken;
    } catch (err) {
      console.warn('[Spotify] Token method failed:', err.message);
    }
  }

  throw new Error('Spotify token fetch failed: all methods exhausted');
}

// ── Playlist URL → ID ─────────────────────────────────────────────────────────
function extractPlaylistId(url) {
  // Handles:
  //   https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
  //   spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
  const match = url.match(/playlist[:/]([A-Za-z0-9]+)/);
  if (!match) throw new Error('Invalid Spotify playlist URL');
  return match[1];
}

// ── Scrape public Spotify playlist — FULL pagination via multiple embed fetches ──
// The embed page only shows ~100 tracks. For larger playlists, we use Spotify's
// internal "pathfinder" GraphQL endpoint which can paginate without strict auth.
export async function scrapePlaylistEmbed(playlistUrl) {
  const id = extractPlaylistId(playlistUrl);
  const embedUrl = `https://open.spotify.com/embed/playlist/${id}`;
  
  const res = await fetch(embedUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error(`Embed fetch failed: ${res.status}`);
  const html = await res.text();
  
  // Find __NEXT_DATA__
  const match = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find __NEXT_DATA__ in embed page HTML');
  
  const json = JSON.parse(match[1]);
  const entity = json.props?.pageProps?.state?.data?.entity;
  if (!entity) throw new Error('Entity data missing in embed page JSON');
  
  const coverUrl = entity.coverArt?.sources?.[0]?.url || null;
  
  // Also extract the accessToken embedded in the page for API calls
  const tokenMatch = html.match(/"accessToken":"([^"]+)"/);
  const embedToken = tokenMatch ? tokenMatch[1] : null;
  
  const tracks = (entity.trackList || []).map((t) => {
    const artist = t.subtitle || '';
    return {
      title: t.title,
      artist,
      query: `${artist} - ${t.title}`,
      durationMs: t.duration || 0,
      thumbnail: coverUrl,
    };
  });
  
  return {
    id,
    name: entity.name || 'Untitled Playlist',
    description: entity.subtitle || '',
    coverUrl,
    trackCount: tracks.length,
    tracks,
    syncedAt: Date.now(),
    url: playlistUrl,
    _embedToken: embedToken, // Pass token internally for pagination
  };
}

// ── Fetch all tracks from a playlist ──────────────────────────────────────────
// Strategy: Scrape the Spotify embed page for the first 100 tracks, then use
// the embed's internal token to paginate via the web API for the rest.
// If all API methods fail, return whatever the embed gave us.
export async function fetchPlaylistTracks(playlistUrl) {
  console.log(`[Spotify] Fetching playlist tracks: ${playlistUrl}`);
  const id = extractPlaylistId(playlistUrl);
  
  // Step 1: Get embed page (gives us first ~100 tracks + an access token)
  let embedResult = null;
  let embedToken = null;
  
  try {
    embedResult = await scrapePlaylistEmbed(playlistUrl);
    embedToken = embedResult._embedToken;
    console.log(`[Spotify] Embed: ${embedResult.trackCount} tracks, token: ${embedToken ? 'yes' : 'no'}`);
  } catch (err) {
    console.warn('[Spotify] Embed failed:', err.message);
  }
  
  // Step 2: If we got a token, use it to paginate ALL tracks
  if (embedToken) {
    try {
      const full = await fetchWithToken(id, embedToken, playlistUrl, embedResult);
      if (full.trackCount > (embedResult?.trackCount || 0)) {
        console.log(`[Spotify] Full pagination: ${full.trackCount} tracks`);
        return full;
      }
    } catch (err) {
      console.warn('[Spotify] Token pagination failed:', err.message);
    }
  }
  
  // Step 3: Try getting a fresh token via the standard endpoint
  try {
    const token = await getAnonToken();
    const full = await fetchWithToken(id, token, playlistUrl, embedResult);
    if (full.trackCount > (embedResult?.trackCount || 0)) {
      console.log(`[Spotify] Anon token pagination: ${full.trackCount} tracks`);
      return full;
    }
  } catch (err) {
    console.warn('[Spotify] Anon token failed:', err.message);
  }

  // Step 4: Return embed result if available
  if (embedResult) {
    delete embedResult._embedToken;
    console.log(`[Spotify] Returning embed result: ${embedResult.trackCount} tracks (API pagination unavailable)`);
    return embedResult;
  }
  
  throw new Error('Failed to load playlist. Spotify may be blocking requests — try again later.');
}

/**
 * Fetch ALL tracks using a provided token (from embed page or anon endpoint).
 * Paginates 100 tracks at a time until complete.
 */
async function fetchWithToken(playlistId, token, playlistUrl, embedResult) {
  const limit = 100;
  let offset = 0;
  const allTracks = [];
  let total = 0;
  let name = embedResult?.name || '';
  let description = embedResult?.description || '';
  let coverUrl = embedResult?.coverUrl || null;

  // First page
  const firstUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=0&fields=total,next,items(track(name,artists,duration_ms,album(images)))`;
  const firstRes = await fetch(firstUrl, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!firstRes.ok) throw new Error(`API returned ${firstRes.status}`);
  const firstData = await firstRes.json();
  total = firstData.total || 0;

  function processTracks(items) {
    for (const item of items) {
      const t = item?.track;
      if (!t || !t.name) continue;
      const artist = t.artists?.[0]?.name ?? '';
      allTracks.push({
        title: t.name,
        artist,
        query: `${artist} - ${t.name}`,
        durationMs: t.duration_ms ?? 0,
        thumbnail: t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url ?? null,
      });
    }
  }

  processTracks(firstData.items || []);
  offset = allTracks.length;
  console.log(`[Spotify] Fetched ${allTracks.length}/${total} tracks...`);

  // Paginate remaining pages
  while (offset < total) {
    const pageUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=${limit}&offset=${offset}&fields=total,next,items(track(name,artists,duration_ms,album(images)))`;
    const pageRes = await fetch(pageUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    if (!pageRes.ok) {
      console.warn(`[Spotify] Page fetch failed at offset ${offset}: ${pageRes.status}`);
      break;
    }
    const pageData = await pageRes.json();
    processTracks(pageData.items || []);
    offset = allTracks.length;
    console.log(`[Spotify] Fetched ${allTracks.length}/${total} tracks...`);
    
    // Small delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`[Spotify] Pagination complete! ${allTracks.length} total tracks.`);
  return {
    id: playlistId,
    name,
    description,
    coverUrl,
    trackCount: allTracks.length,
    tracks: allTracks,
    syncedAt: Date.now(),
    url: playlistUrl,
  };
}

/**
 * Fetch playlist tracks via Spotify's anonymous token API with full pagination.
 * Fetches 100 tracks at a time until all are loaded.
 */
async function fetchViaAnonToken(playlistUrl) {
  const id = extractPlaylistId(playlistUrl);
  const token = await getAnonToken();

  // First request: get playlist metadata + first page of tracks
  let res = await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=name,description,images,tracks(next,total,items(track(name,artists,duration_ms,album(images))))`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    if (res.status === 404) throw new Error('Playlist not found (may be private or deleted)');
    throw new Error(`Spotify API error: ${res.status}`);
  }

  const data = await res.json();
  const tracks = [];
  const total = data.tracks?.total || 0;

  function processTracks(items) {
    for (const item of items) {
      const t = item?.track;
      if (!t || !t.name) continue;
      const artist = t.artists?.[0]?.name ?? '';
      tracks.push({
        title:      t.name,
        artist,
        query:      `${artist} - ${t.name}`,
        durationMs: t.duration_ms ?? 0,
        thumbnail:  t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url ?? null,
      });
    }
  }

  processTracks(data.tracks.items);
  console.log(`[Spotify] Fetched ${tracks.length}/${total} tracks...`);

  // Paginate through remaining tracks (100 at a time)
  let nextUrl = data.tracks.next;
  while (nextUrl) {
    const pageRes = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!pageRes.ok) break;
    const page = await pageRes.json();
    processTracks(page.items);
    nextUrl = page.next;
    console.log(`[Spotify] Fetched ${tracks.length}/${total} tracks...`);
  }

  console.log(`[Spotify] API pagination complete! Loaded ${tracks.length} tracks total.`);
  return {
    id,
    name:        data.name,
    description: data.description ?? '',
    coverUrl:    data.images?.[0]?.url ?? null,
    trackCount:  tracks.length,
    tracks,
    syncedAt:    Date.now(),
    url:         playlistUrl,
  };
}

// ── Sync all saved playlists ──────────────────────────────────────────────────
/**
 * Re-fetches every saved playlist and updates the store.
 * @param {import('electron-store').default} store
 */
export async function syncAllPlaylists(store) {
  const saved = store.get('spotifyPlaylists') || [];
  if (!saved.length) return { synced: 0, errors: [] };

  const errors = [];
  const updated = [];

  for (const entry of saved) {
    try {
      const playlist = await fetchPlaylistTracks(entry.url);
      updated.push(playlist);
    } catch (err) {
      console.warn(`[Spotify] Failed to sync "${entry.url}":`, err.message);
      // Keep old data if sync fails
      updated.push(entry);
      errors.push({ url: entry.url, error: err.message });
    }
  }

  store.set('spotifyPlaylists', updated);
  store.set('spotifyLastSync', Date.now());
  return { synced: updated.length - errors.length, errors };
}

// ── Daily sync scheduler ──────────────────────────────────────────────────────
let syncTimer = null;

export function scheduleDailySync(store, intervalHours = 24) {
  if (syncTimer) clearInterval(syncTimer);

  const ms = intervalHours * 60 * 60 * 1000;
  syncTimer = setInterval(async () => {
    console.log('[Spotify] Running scheduled sync…');
    try {
      const result = await syncAllPlaylists(store);
      console.log(`[Spotify] Sync done: ${result.synced} playlists updated, ${result.errors.length} errors`);
    } catch (err) {
      console.error('[Spotify] Sync failed:', err.message);
    }
  }, ms);

  console.log(`[Spotify] Daily sync scheduled every ${intervalHours}h`);
}

export function stopSync() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}
