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

  const res = await fetch(
    'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
        'App-Platform': 'WebPlayer',
      },
    },
  );

  if (!res.ok) throw new Error(`Spotify token fetch failed: ${res.status}`);
  const data = await res.json();

  cachedToken = data.accessToken;
  // Spotify tokens last ~1 hour; refresh 5 min early
  tokenExpiry = Date.now() + (data.accessTokenExpirationTimestampMs - Date.now()) - 5 * 60 * 1000;
  return cachedToken;
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

// ── Scrape public Spotify playlist using Embed page scraping ─────────────────
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
  const tracks = (entity.trackList || []).map((t) => {
    const artist = t.subtitle || '';
    return {
      title: t.title,
      artist,
      query: `${artist} - ${t.title}`,
      durationMs: t.duration || 0,
      thumbnail: coverUrl, // embed doesn't have per-track cover arts in trackList, use playlist cover as default
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
  };
}

// ── Fetch all tracks from a playlist (scrapes Embed, falls back to Anon Token API) ──
export async function fetchPlaylistTracks(playlistUrl) {
  console.log(`[Spotify] Fetching playlist tracks: ${playlistUrl}`);
  
  try {
    // Method 1: Embed page scraping
    console.log('[Spotify] Trying Method 1: Embed page scraping...');
    const playlist = await scrapePlaylistEmbed(playlistUrl);
    console.log(`[Spotify] Method 1 succeeded! Loaded ${playlist.trackCount} tracks.`);
    return playlist;
  } catch (embedErr) {
    console.warn('[Spotify] Method 1 failed, falling back to Method 2. Error:', embedErr.message);
    
    // Method 2: Anonymous token API fallback
    try {
      console.log('[Spotify] Trying Method 2: Anonymous token API fallback...');
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

      function processTracks(items) {
        for (const item of items) {
          const t = item?.track;
          if (!t || !t.name) continue;
          const artist = t.artists?.[0]?.name ?? '';
          tracks.push({
            title:      t.name,
            artist,
            query:      `${artist} - ${t.name}`,          // YouTube search query
            durationMs: t.duration_ms ?? 0,
            thumbnail:  t.album?.images?.[1]?.url ?? t.album?.images?.[0]?.url ?? null,
          });
        }
      }

      processTracks(data.tracks.items);

      // Paginate through remaining tracks
      let nextUrl = data.tracks.next;
      while (nextUrl) {
        const pageRes = await fetch(nextUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!pageRes.ok) break;
        const page = await pageRes.json();
        processTracks(page.items);
        nextUrl = page.next;
      }

      console.log(`[Spotify] Method 2 succeeded! Loaded ${tracks.length} tracks.`);
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
    } catch (apiErr) {
      console.error('[Spotify] All fetch methods failed.');
      throw new Error(`Failed to load playlist: ${apiErr.message} (Embed error: ${embedErr.message})`);
    }
  }
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
