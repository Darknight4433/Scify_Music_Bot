/**
 * main.js — Electron main process for Scify Music desktop app.
 *
 * Responsibilities:
 *  - Creates and manages the BrowserWindow
 *  - AUTO-STARTS the bot (node bot.js) as a child process
 *  - AUTO-JOINS the configured voice channel once bot is online
 *  - Handles IPC from the renderer (via preload.js)
 *  - Manages Discord Rich Presence lifecycle
 *  - Polls the bot REST API and forwards updates to renderer
 *  - Spotify playlist sync (scrape, no API key needed)
 *  - YouTube OAuth login flow
 */

import crypto from 'node:crypto';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import Store from 'electron-store';
import { updatePresence, clearPresence, connectRPC, disconnectRPC } from './rpc.js';
import { fetchPlaylistTracks, syncAllPlaylists, scheduleDailySync, stopSync } from './spotify.js';
import { createTray } from './tray.js';
import { registerMediaKeys, unregisterMediaKeys } from './mediaKeys.js';
import { showNowPlayingNotification } from './notifications.js';
import { createReconnectManager } from './reconnect.js';
import { createRecoveryManager } from './recovery.js';
import { createLogger } from './logger.js';
import { deserializePlaylist, upsertPlaylist } from './playlistStore.js';
import { fetchYouTubePlaylist } from './youtube.js';
import { createLocalAudioPipeline } from './localAudio.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Structured logger ────────────────────────────────────────────────────────
const logger = createLogger();

// ── Persistent settings ──────────────────────────────────────────────────────
const settings = new Store({
  defaults: {
    apiUrl: 'http://127.0.0.1:3456',
    apiSecret: '',
    guildId: '',
    channelId: '',
    richPresence: true,
    volume: 80,
    autoStartBot: true,
    autoJoinVc: true,
    botFolder: path.resolve(__dirname, '..'), // one level up from desktop/
    spotifyPlaylists: [],
    spotifyLastSync: null,
    spotifySyncIntervalHours: 24,
    playlists: [],
    likedSongs: [],
    playlistViewMode: 'list',
    playlistLastSort: 'custom',
    localVolume: 80,
    playbackMode: 'discord',
  },
});

let mainWindow = null;
let pollInterval = null;
let lastStatus = null;
let lastPlayingTitle = null;
let botProcess = null;
let botOnline = false;
let autoJoinDone = false;
let isQuitting = false;
let trayManager = null;
let reconnectManager = null;
let recoveryManager = null;
let localAudioPipeline = null;

// ── Single instance lock ──────────────────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  // Another instance is already running — quit this one
  app.quit();
} else {
  // When a second instance is attempted, focus the existing window
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Window creation ──────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1150,
    height: 740,
    minWidth: 820,
    minHeight: 620,
    frame: false,
    backgroundColor: '#0d0d0f',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Intercept close to hide window instead of quitting (minimize-to-tray)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Bot process management ───────────────────────────────────────────────────
function spawnBot() {
  if (botProcess) return; // already running

  const botDir = settings.get('botFolder');
  const botEntry = path.join(botDir, 'bot.js');

  console.log(`[Bot] Spawning: node ${botEntry}`);

  botProcess = spawn('node', [botEntry], {
    cwd: botDir,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' },
  });

  botOnline = false;
  autoJoinDone = false;
  mainWindow?.webContents.send('bot-status', 'starting');

  botProcess.stdout.on('data', (chunk) => {
    const line = chunk.toString().trim();
    console.log(`[Bot] ${line}`);
    mainWindow?.webContents.send('bot-log', line);

    // Detect when the bot is fully ready
    if (line.includes('Logged in as') || line.includes('REST bridge listening')) {
      if (!botOnline) {
        botOnline = true;
        mainWindow?.webContents.send('bot-status', 'online');
        // Start polling now that the API is available
        startPolling();
        // Auto-configure guild if not set
        autoConfigureGuild();
        if (settings.get('autoJoinVc') && !autoJoinDone) {
          autoJoinVc();
        }
      }
    }
  });

  botProcess.stderr.on('data', (chunk) => {
    const line = chunk.toString().trim();
    if (line) {
      console.warn(`[Bot ERR] ${line}`);
      mainWindow?.webContents.send('bot-log', `⚠ ${line}`);
    }
  });

  botProcess.on('close', (code) => {
    console.log(`[Bot] Process exited with code ${code}`);
    botProcess = null;
    botOnline = false;
    mainWindow?.webContents.send('bot-status', code === 0 ? 'stopped' : 'error');

    // Trigger crash recovery for non-zero exits when not intentionally quitting
    if (code !== 0 && !isQuitting && recoveryManager) {
      recoveryManager.handleExit(code);
    }
  });

  botProcess.on('error', (err) => {
    console.error('[Bot] Failed to start:', err.message);
    botProcess = null;
    botOnline = false;
    mainWindow?.webContents.send('bot-status', 'error');
    mainWindow?.webContents.send('bot-log', `❌ Failed to start bot: ${err.message}`);
  });
}

function killBot() {
  if (!botProcess) return;
  console.log('[Bot] Stopping…');
  botProcess.kill('SIGTERM');
  botProcess = null;
  botOnline = false;
}

async function autoJoinVc() {
  const guildId   = settings.get('guildId');
  const channelId = settings.get('channelId');
  if (!guildId || !channelId) return;

  // Wait a moment for the bot's Discord connection to fully stabilize
  await new Promise((r) => setTimeout(r, 3000));

  try {
    await apiRequest('POST', '/connect', { guildId, channelId });
    autoJoinDone = true;
    console.log('[Bot] Auto-joined voice channel');
    mainWindow?.webContents.send('bot-log', '🔊 Auto-joined voice channel');
  } catch (err) {
    console.warn('[Bot] Auto-join failed:', err.message);
  }
}

/**
 * On first launch (or when guildId is empty), auto-detect the guild the bot is
 * in. If the bot is in exactly one guild, just use it. Also pick the first
 * voice channel with members (or the first VC) as the default channel.
 * Retries a few times since the guild cache may not be populated immediately.
 */
async function autoConfigureGuild() {
  // Only auto-configure if guildId is not already set
  if (settings.get('guildId')) return;

  const maxRetries = 5;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Wait progressively longer between retries
    await new Promise((r) => setTimeout(r, 3000 + attempt * 2000));

    try {
      const data = await apiRequest('GET', '/guilds');
      if (!data.guilds || data.guilds.length === 0) {
        console.log(`[Auto-Config] No guilds yet (attempt ${attempt + 1}/${maxRetries})`);
        continue;
      }

      // Pick the first (or only) guild
      const guild = data.guilds[0];
      settings.set('guildId', guild.id);
      console.log(`[Auto-Config] Selected guild: ${guild.name} (${guild.id})`);
      mainWindow?.webContents.send('bot-log', `⚙️ Auto-selected server: ${guild.name}`);

      // Try to pick a voice channel
      const channels = await apiRequest('GET', `/guilds/${encodeURIComponent(guild.id)}/channels`);
      if (channels.channels && channels.channels.length > 0) {
        const vc = channels.channels[0];
        settings.set('channelId', vc.id);
        console.log(`[Auto-Config] Selected channel: ${vc.name} (${vc.id})`);
        mainWindow?.webContents.send('bot-log', `⚙️ Auto-selected voice channel: ${vc.name}`);
      }

      // Notify renderer to refresh its settings
      mainWindow?.webContents.send('settings-updated', settings.store);

      // Now try auto-join since we have guild+channel
      if (settings.get('autoJoinVc') && !autoJoinDone) {
        autoJoinVc();
      }
      return; // Success — stop retrying
    } catch (err) {
      console.warn(`[Auto-Config] Attempt ${attempt + 1} failed:`, err.message);
    }
  }

  // All retries exhausted — bot might not be in any server
  console.warn('[Auto-Config] Could not detect any guild. Bot may not be invited to a server.');
  mainWindow?.webContents.send('bot-log', '⚠️ Bot is not in any Discord server. Use Settings → Load Servers after inviting it.');
}

// ── App lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow();

  // Create local audio pipeline for speaker playback
  localAudioPipeline = createLocalAudioPipeline(mainWindow, settings);

  // Register IPC handlers for local audio playback
  ipcMain.handle('local-play', (_e, url, seekSeconds) => localAudioPipeline.play(url, seekSeconds));
  ipcMain.handle('local-stop', () => localAudioPipeline.stop());

  // Create system tray icon with context menu
  trayManager = createTray({
    iconPath: path.join(__dirname, 'assets', 'tray-icon.png'),
    window: mainWindow,
    onPlay: () => apiRequest('POST', '/resume', { guildId: settings.get('guildId') }).catch(() => {}),
    onPause: () => apiRequest('POST', '/pause', { guildId: settings.get('guildId') }).catch(() => {}),
    onSkip: () => apiRequest('POST', '/skip', { guildId: settings.get('guildId') }).catch(() => {}),
    onOpen: () => { mainWindow?.show(); mainWindow?.focus(); },
    onExit: async () => {
      isQuitting = true;
      const guildId = settings.get('guildId');
      if (guildId) {
        await apiRequest('POST', '/disconnect', { guildId }).catch(() => {});
      }
      killBot();
      app.quit();
    },
  });

  // Register global media keys for playback control
  const mediaKeyHandlers = {
    onPlayPause: async () => {
      const guildId = settings.get('guildId');
      if (!guildId) return;
      try {
        const status = await apiRequest('GET', `/status?guildId=${encodeURIComponent(guildId)}`);
        if (status.paused) {
          await apiRequest('POST', '/resume', { guildId });
        } else {
          await apiRequest('POST', '/pause', { guildId });
        }
      } catch {}
    },
    onNextTrack: () => {
      const guildId = settings.get('guildId');
      if (guildId) apiRequest('POST', '/skip', { guildId }).catch(() => {});
    },
    onPreviousTrack: () => {
      const guildId = settings.get('guildId');
      if (guildId) apiRequest('POST', '/seek', { guildId, position: 0 }).catch(() => {});
    },
  };
  registerMediaKeys(mediaKeyHandlers);

  // Re-attempt media key registration when window is restored from tray
  mainWindow.on('show', () => {
    registerMediaKeys(mediaKeyHandlers);
  });

  // Check if the bot token exists — only auto-start if setup is done
  const botDir = settings.get('botFolder');
  const envPath = path.join(botDir, '.env');
  let hasToken = false;
  try {
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/DISCORD_TOKEN=(.+)/);
    const token = match?.[1]?.trim();
    hasToken = !!token && token !== 'your-bot-token-here';
  } catch { /* no .env yet */ }

  // Auto-start bot if enabled AND token exists
  if (settings.get('autoStartBot') && hasToken) {
    spawnBot();
  }

  // Create reconnect manager for network resilience
  reconnectManager = createReconnectManager({
    logger,
    onStatusChange: (status) => {
      mainWindow?.webContents.send('network-status', status);
    },
    onReconnect: async () => {
      // Restart bot and rejoin VC
      killBot();
      await new Promise(r => setTimeout(r, 1000));
      spawnBot();
      // The bot's stdout handler already triggers autoJoinVc when it detects "Logged in"
    },
    maxRetries: 5,
    baseDelay: 5000,
    maxDelay: 60000,
  });
  reconnectManager.start();

  // IPC handlers for network state from renderer
  ipcMain.on('network-offline', () => reconnectManager.triggerOffline());
  ipcMain.on('network-online', () => reconnectManager.triggerOnline());

  // Create crash recovery manager for automatic bot restarts
  recoveryManager = createRecoveryManager({
    logger,
    spawnBot: () => {
      spawnBot();
      return botProcess;
    },
    onStatusChange: (status) => {
      mainWindow?.webContents.send('crash-recovery', { event: status });
    },
    crashThreshold: 3,
    crashWindow: 60000,
    restartDelay: 3000,
  });

  // Try to connect Discord RPC
  if (settings.get('richPresence')) {
    connectRPC().catch(() => {});
  }

  // Polling starts when bot signals it's online (see spawnBot stdout handler).
  // If bot is NOT auto-started, start polling anyway so user sees "Bot offline".
  if (!settings.get('autoStartBot') || !hasToken) {
    startPolling();
  }

  // Start Spotify daily sync
  scheduleDailySync(settings, settings.get('spotifySyncIntervalHours'));
});

app.on('window-all-closed', async () => {
  stopPolling();
  stopSync();

  // Disconnect bot from VC before killing it
  const guildId = settings.get('guildId');
  if (guildId) {
    apiRequest('POST', '/disconnect', { guildId }).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  }

  killBot();
  clearPresence().catch(() => {});
  disconnectRPC().catch(() => {});

  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  // Stop local audio pipeline processes on quit
  localAudioPipeline?.stop();
  // Destroy tray icon to prevent ghost icons in the system tray
  if (trayManager) {
    trayManager.destroy();
    trayManager = null;
  }
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

app.on('will-quit', () => {
  unregisterMediaKeys();
});

// ── Bot API polling ──────────────────────────────────────────────────────────
function startPolling() {
  if (pollInterval) return;
  pollInterval = setInterval(pollStatus, 3000);
  pollStatus();
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function pollStatus() {
  const guildId = settings.get('guildId');
  if (!mainWindow) return;

  // If no guildId configured, tell renderer to show a helpful message
  if (!guildId) {
    if (lastStatus !== '__no_guild__') {
      lastStatus = '__no_guild__';
      mainWindow.webContents.send('status-update', { noGuild: true });
    }
    return;
  }

  try {
    const status = await apiRequest('GET', `/status?guildId=${encodeURIComponent(guildId)}`);
    const statusStr = JSON.stringify(status);
    if (statusStr !== lastStatus) {
      lastStatus = statusStr;
      mainWindow?.webContents.send('status-update', status);

      // Update tray now-playing display
      if (trayManager) {
        trayManager.updateNowPlaying(status.current?.title || null);
      }

      // Show notification on track change
      const currentTitle = status.current?.title || null;
      if (currentTitle && currentTitle !== lastPlayingTitle) {
        showNowPlayingNotification({
          title: currentTitle,
          onActivated: () => { mainWindow?.show(); mainWindow?.focus(); },
        });
      }
      lastPlayingTitle = currentTitle;

      if (settings.get('richPresence') && status.playing && status.current) {
        console.log('[RPC] Updating presence:', status.current.title);
        updatePresence({
          title: status.current.title,
          positionSec: status.positionSec,
          durationSec: status.durationSec,
          paused: status.paused,
          channelName: status.channelName || null,
          queueLength: status.queue?.length || 0,
        }).catch((e) => console.warn('[RPC] updatePresence error:', e.message));
      } else if (!status.playing) {
        clearPresence().catch(() => {});
      }
    }
  } catch {
    if (lastStatus !== null) {
      lastStatus = null;
      mainWindow?.webContents.send('status-update', null);
    }
  }
}

// ── IPC handlers ─────────────────────────────────────────────────────────────

// Window controls
ipcMain.on('win-minimize', () => mainWindow?.minimize());
ipcMain.on('win-maximize', () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); });
ipcMain.on('win-close', () => mainWindow?.close());

// Settings
ipcMain.handle('settings-get-all', () => settings.store);
ipcMain.handle('settings-set', (_e, key, value) => {
  settings.set(key, value);
  if (key === 'richPresence') {
    if (value) connectRPC().catch(() => {}); else disconnectRPC().catch(() => {});
  }
  if (key === 'spotifySyncIntervalHours') {
    scheduleDailySync(settings, value);
  }
});

// API proxy
ipcMain.handle('api-request', async (_e, method, urlPath, body) => apiRequest(method, urlPath, body));

// Open URLs in browser
ipcMain.on('open-url', (_e, url) => shell.openExternal(url));

// Guild / channel discovery
ipcMain.handle('get-guilds',   ()         => apiRequest('GET', '/guilds'));
ipcMain.handle('get-channels', (_e, gid)  => apiRequest('GET', `/guilds/${encodeURIComponent(gid)}/channels`));

// Bot control
ipcMain.handle('bot-start', () => { spawnBot(); return { ok: true }; });
ipcMain.handle('bot-stop',  () => { killBot();  return { ok: true }; });
ipcMain.handle('bot-status-get', () => ({ online: botOnline, running: !!botProcess }));

// Setup / onboarding
ipcMain.handle('setup-check', () => {
  // Check if bot is in any guild — if not, user needs to invite it
  // We check the .env for a token first
  const botDir = settings.get('botFolder');
  const envPath = path.join(botDir, '.env');
  try {
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/DISCORD_TOKEN=(.+)/);
    const token = match?.[1]?.trim();
    if (!token || token === 'your-bot-token-here') {
      return { needsSetup: true, reason: 'no-token' };
    }
    // Token exists — check if we already have a guildId configured
    if (settings.get('guildId')) {
      return { needsSetup: false };
    }
    return { needsSetup: true, reason: 'no-guild' };
  } catch {
    return { needsSetup: true, reason: 'no-token' };
  }
});

ipcMain.handle('setup-get-invite-url', () => {
  const botDir = settings.get('botFolder');
  const envPath = path.join(botDir, '.env');
  try {
    const content = readFileSync(envPath, 'utf8');
    const match = content.match(/DISCORD_TOKEN=(.+)/);
    const token = match?.[1]?.trim();
    if (!token) return { ok: false, error: 'No bot token found in .env' };

    // Decode client ID from the bot token (base64 first segment)
    let part = token.split('.')[0];
    const pad = part.length % 4;
    if (pad > 0) part += '='.repeat(4 - pad);
    const clientId = Buffer.from(part, 'base64').toString();

    if (!/^\d+$/.test(clientId)) {
      return { ok: false, error: 'Could not extract client ID from token.' };
    }

    const permissions = 3145728; // Connect + Speak + Send Messages
    const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
    return { ok: true, inviteUrl };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('setup-save-token', async (_e, token) => {
  const botDir = settings.get('botFolder');
  const envPath = path.join(botDir, '.env');

  // Decode client ID from the bot token (base64 first segment)
  let clientId;
  try {
    let part = token.split('.')[0];
    const pad = part.length % 4;
    if (pad > 0) part += '='.repeat(4 - pad);
    clientId = Buffer.from(part, 'base64').toString();
    if (!/^\d+$/.test(clientId)) throw new Error('invalid');
  } catch {
    return { ok: false, error: 'Invalid token format. Copy the full token from the Developer Portal.' };
  }

  // Write or update .env
  let content = '';
  if (existsSync(envPath)) {
    content = readFileSync(envPath, 'utf8');
    if (content.includes('DISCORD_TOKEN=')) {
      content = content.replace(/DISCORD_TOKEN=.*/, `DISCORD_TOKEN=${token}`);
    } else {
      content += `\nDISCORD_TOKEN=${token}\n`;
    }
  } else {
    content = `DISCORD_TOKEN=${token}\nAPI_PORT=3456\nAPI_SECRET=\n`;
  }
  writeFileSync(envPath, content, 'utf8');

  const permissions = 3145728;
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${clientId}&permissions=${permissions}&scope=bot%20applications.commands`;
  return { ok: true, clientId, inviteUrl };
});

// Spotify
ipcMain.handle('spotify-add-playlist', async (_e, url) => {
  try {
    const playlist = await fetchPlaylistTracks(url);
    const saved = settings.get('spotifyPlaylists') || [];
    // Replace if already exists, otherwise add
    const idx = saved.findIndex((p) => p.id === playlist.id);
    if (idx >= 0) saved[idx] = playlist; else saved.push(playlist);
    settings.set('spotifyPlaylists', saved);
    settings.set('spotifyLastSync', Date.now());
    return { ok: true, playlist };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('spotify-get-playlists', () => ({
  playlists: settings.get('spotifyPlaylists') || [],
  lastSync: settings.get('spotifyLastSync'),
}));

ipcMain.handle('spotify-remove-playlist', (_e, playlistId) => {
  const saved = (settings.get('spotifyPlaylists') || []).filter((p) => p.id !== playlistId);
  settings.set('spotifyPlaylists', saved);
  return { ok: true };
});

ipcMain.handle('spotify-sync', async () => {
  try {
    const result = await syncAllPlaylists(settings);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// YouTube auth
ipcMain.handle('yt-auth-start',  () => apiRequest('POST', '/yt-auth/start'));
ipcMain.handle('yt-auth-status', () => apiRequest('GET',  '/yt-auth/status'));
ipcMain.handle('yt-auth-cancel', () => apiRequest('POST', '/yt-auth/cancel'));

// ── Playlist management IPC handlers ─────────────────────────────────────────

// Import a Spotify playlist into the unified playlists store
ipcMain.handle('playlist-import-spotify', async (_e, url) => {
  try {
    const result = await fetchPlaylistTracks(url);
    const now = result.syncedAt || Date.now();

    // Normalize into StoredPlaylist schema
    const playlist = {
      id: result.id,
      name: result.name,
      description: result.description || '',
      coverUrl: result.coverUrl || null,
      source: 'spotify',
      sourceUrl: url,
      trackCount: result.tracks.length,
      tracks: result.tracks.map((t) => ({
        title: t.title || '',
        artist: t.artist || '',
        album: t.album || '',
        durationMs: t.durationMs || 0,
        thumbnail: t.thumbnail || null,
        query: t.query || '',
        addedAt: now,
      })),
      syncedAt: now,
    };

    // Upsert into the unified playlists array
    const playlists = settings.get('playlists') || [];
    const updated = upsertPlaylist(playlists, playlist);
    settings.set('playlists', updated);

    // Return metadata without the tracks array for response size
    const { tracks, ...metadata } = playlist;
    return { ok: true, playlist: metadata };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Import a YouTube playlist via bot API (yt-dlp)
ipcMain.handle('playlist-import-youtube', async (_e, url) => {
  try {
    const playlist = await fetchYouTubePlaylist(url, apiRequest);
    const updatedPlaylists = upsertPlaylist(settings.get('playlists') || [], playlist);
    settings.set('playlists', updatedPlaylists);
    // Return metadata only (without tracks) to keep response size small
    const { tracks, ...metadata } = playlist;
    return { ok: true, playlist: metadata };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// Get all playlists (metadata only, without tracks array for performance)
ipcMain.handle('playlist-get-all', () => {
  const playlists = settings.get('playlists') || [];
  return playlists.map((p) => {
    const deserialized = deserializePlaylist(p);
    // Return without the tracks array for list view performance
    const { tracks, ...metadata } = deserialized;
    return metadata;
  });
});

// Get full track list for a specific playlist ID (includes metadata for detail view)
ipcMain.handle('playlist-get-tracks', (_e, playlistId) => {
  const playlists = settings.get('playlists') || [];
  const raw = playlists.find((p) => p.id === playlistId);
  if (!raw) return { ok: false, error: 'Playlist not found' };
  const deserialized = deserializePlaylist(raw);
  return {
    ok: true,
    id: deserialized.id,
    name: deserialized.name,
    coverUrl: deserialized.coverUrl,
    source: deserialized.source,
    trackCount: deserialized.trackCount,
    tracks: deserialized.tracks,
  };
});

// Remove a playlist from the store
ipcMain.handle('playlist-remove', (_e, playlistId) => {
  const playlists = (settings.get('playlists') || []).filter((p) => p.id !== playlistId);
  settings.set('playlists', playlists);
  return { ok: true };
});

// Get the persisted view mode preference (returns object with viewMode + sortCriterion)
ipcMain.handle('playlist-get-view-mode', () => {
  return {
    viewMode: settings.get('playlistViewMode') || 'list',
    sortCriterion: settings.get('playlistLastSort') || 'custom',
  };
});

// Set the view mode preference (accepts object or string for backward compat)
ipcMain.handle('playlist-set-view-mode', (_e, mode) => {
  if (typeof mode === 'object' && mode !== null) {
    if (mode.viewMode === 'list' || mode.viewMode === 'compact') {
      settings.set('playlistViewMode', mode.viewMode);
    }
    if (mode.sortCriterion && typeof mode.sortCriterion === 'string') {
      settings.set('playlistLastSort', mode.sortCriterion);
    }
  } else if (mode === 'list' || mode === 'compact') {
    settings.set('playlistViewMode', mode);
  }
  return { ok: true };
});

// ── Custom Playlist & Liked Songs IPC handlers ───────────────────────────────

// Create a new custom playlist
ipcMain.handle('playlist-create', (_e, name, description) => {
  const playlist = {
    id: crypto.randomUUID(),
    name: name || 'Untitled Playlist',
    description: description || '',
    coverUrl: null,
    source: 'custom',
    sourceUrl: '',
    trackCount: 0,
    tracks: [],
    syncedAt: Date.now(),
    url: '',
  };
  const playlists = settings.get('playlists') || [];
  playlists.push(playlist);
  settings.set('playlists', playlists);
  const { tracks, ...metadata } = playlist;
  return { ok: true, playlist: metadata };
});

// Add a track to a specific playlist by ID
ipcMain.handle('playlist-add-track', (_e, playlistId, track) => {
  const playlists = settings.get('playlists') || [];
  const idx = playlists.findIndex((p) => p.id === playlistId);
  if (idx < 0) return { ok: false, error: 'Playlist not found' };
  const playlist = playlists[idx];
  if (!playlist.tracks) playlist.tracks = [];
  playlist.tracks.push(track);
  playlist.trackCount = playlist.tracks.length;
  playlists[idx] = playlist;
  settings.set('playlists', playlists);
  return { ok: true };
});

// Remove a track from a playlist by index
ipcMain.handle('playlist-remove-track', (_e, playlistId, index) => {
  const playlists = settings.get('playlists') || [];
  const idx = playlists.findIndex((p) => p.id === playlistId);
  if (idx < 0) return { ok: false, error: 'Playlist not found' };
  const playlist = playlists[idx];
  if (!playlist.tracks || index < 0 || index >= playlist.tracks.length) {
    return { ok: false, error: 'Invalid track index' };
  }
  playlist.tracks.splice(index, 1);
  playlist.trackCount = playlist.tracks.length;
  playlists[idx] = playlist;
  settings.set('playlists', playlists);
  return { ok: true };
});

// Get liked songs
ipcMain.handle('liked-songs-get', () => {
  return settings.get('likedSongs') || [];
});

// Add a song to liked songs
ipcMain.handle('liked-songs-add', (_e, track) => {
  const liked = settings.get('likedSongs') || [];
  // Avoid duplicates by query
  if (liked.some((t) => t.query === track.query)) {
    return { ok: true, alreadyLiked: true };
  }
  liked.push(track);
  settings.set('likedSongs', liked);
  return { ok: true };
});

// Remove a song from liked songs by query match
ipcMain.handle('liked-songs-remove', (_e, query) => {
  const liked = (settings.get('likedSongs') || []).filter((t) => t.query !== query);
  settings.set('likedSongs', liked);
  return { ok: true };
});

// Check if a song is liked by query
ipcMain.handle('liked-songs-check', (_e, query) => {
  const liked = settings.get('likedSongs') || [];
  return { liked: liked.some((t) => t.query === query) };
});

// ── API request helper ────────────────────────────────────────────────────────
async function apiRequest(method, urlPath, body) {
  const base   = settings.get('apiUrl') || 'http://127.0.0.1:3456';
  const secret = settings.get('apiSecret') || '';

  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${base}${urlPath}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}
