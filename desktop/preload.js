/**
 * preload.js — Secure bridge between Electron's main process and renderer.
 *
 * Uses contextBridge to expose a safe, limited API to the renderer.
 * The renderer CANNOT access Node.js APIs directly.
 *
 * NOTE: Preload scripts MUST use CommonJS (require), not ES modules (import).
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scify', {
  // Window controls
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings-get-all'),
  setSetting: (key, value) => ipcRenderer.invoke('settings-set', key, value),

  // API proxy (all bot API calls go through main process)
  api: {
    get: (path) => ipcRenderer.invoke('api-request', 'GET', path),
    post: (path, body) => ipcRenderer.invoke('api-request', 'POST', path, body),
  },

  // Guilds / channels discovery
  getGuilds: () => ipcRenderer.invoke('get-guilds'),
  getChannels: (guildId) => ipcRenderer.invoke('get-channels', guildId),

  // Open URL in system browser
  openUrl: (url) => ipcRenderer.send('open-url', url),

  // Status updates pushed from main process
  onStatusUpdate: (callback) => {
    ipcRenderer.on('status-update', (_event, status) => callback(status));
  },

  // Bot process management
  startBot: () => ipcRenderer.invoke('bot-start'),
  stopBot: () => ipcRenderer.invoke('bot-stop'),
  getBotStatus: () => ipcRenderer.invoke('bot-status-get'),
  onBotStatus: (callback) => {
    ipcRenderer.on('bot-status', (_event, status) => callback(status));
  },
  onBotLog: (callback) => {
    ipcRenderer.on('bot-log', (_event, log) => callback(log));
  },

  // Spotify sync
  addSpotifyPlaylist: (url) => ipcRenderer.invoke('spotify-add-playlist', url),
  getSpotifyPlaylists: () => ipcRenderer.invoke('spotify-get-playlists'),
  removeSpotifyPlaylist: (id) => ipcRenderer.invoke('spotify-remove-playlist', id),
  syncSpotify: () => ipcRenderer.invoke('spotify-sync'),

  // YouTube OAuth login
  ytAuthStart: () => ipcRenderer.invoke('yt-auth-start'),
  ytAuthStatus: () => ipcRenderer.invoke('yt-auth-status'),
  ytAuthCancel: () => ipcRenderer.invoke('yt-auth-cancel'),

  // Settings auto-update (when auto-config detects guild/channel)
  onSettingsUpdated: (callback) => {
    ipcRenderer.on('settings-updated', (_event, settings) => callback(settings));
  },

  // Setup / onboarding
  checkSetup: () => ipcRenderer.invoke('setup-check'),
  getInviteUrl: () => ipcRenderer.invoke('setup-get-invite-url'),
  saveToken: (token) => ipcRenderer.invoke('setup-save-token', token),
});
