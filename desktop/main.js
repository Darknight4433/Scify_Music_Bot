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

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import Store from 'electron-store';
import { updatePresence, clearPresence, connectRPC, disconnectRPC } from './rpc.js';
import { fetchPlaylistTracks, syncAllPlaylists, scheduleDailySync, stopSync } from './spotify.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
  },
});

let mainWindow = null;
let pollInterval = null;
let lastStatus = null;
let botProcess = null;
let botOnline = false;
let autoJoinDone = false;

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

app.on('activate', () => {
  if (!mainWindow) createWindow();
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
      if (settings.get('richPresence') && status.playing && status.current) {
        updatePresence({ title: status.current.title, positionSec: status.positionSec, durationSec: status.durationSec, paused: status.paused }).catch(() => {});
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
