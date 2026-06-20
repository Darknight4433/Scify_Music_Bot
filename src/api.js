/**
 * api.js — Lightweight REST bridge for the Scify Music desktop app.
 *
 * The desktop app talks to this server (default: http://localhost:3456) to:
 *   - Get current playback state (now playing, position, queue)
 *   - Send play/pause/skip/seek commands
 *   - Browse recently played history
 *
 * Every request must include the header:
 *   Authorization: Bearer <API_SECRET>
 *
 * Set API_PORT and API_SECRET in your .env file.
 */

import express from 'express';
import cors from 'cors';
import { startYouTubeLogin, checkYouTubeAuth, cancelYouTubeLogin } from './ytAuth.js';
import { getPoolStatus, PROXY_POOL } from './proxy.js';

const PORT = process.env.API_PORT ? parseInt(process.env.API_PORT, 10) : 3456;
const SECRET = process.env.API_SECRET || '';

/**
 * Create and start the REST API server.
 * @param {import('./musicManager.js').MusicManager} music
 * @param {import('./store.js').Store} store
 * @param {import('discord.js').Client} discordClient
 */
export function startApiServer(music, store, discordClient) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  // ── Auth middleware ──────────────────────────────────────────────────────────
  app.use((req, res, next) => {
    if (!SECRET) return next(); // no secret configured → open (dev only)
    const auth = req.headers['authorization'] ?? '';
    if (auth !== `Bearer ${SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // ── Helper: resolve guildId ──────────────────────────────────────────────────
  function getGuildId(req) {
    return req.query.guildId || req.body?.guildId || null;
  }

  // ── GET /health — quick health check for the desktop app ─────────────────────
  app.get('/health', (_req, res) => {
    res.json({
      bot: true,
      api: true,
      discord: discordClient.isReady(),
      proxy: PROXY_POOL.length > 0,
      uptime: process.uptime(),
    });
  });

  // ── GET /guilds — list all guilds the bot is in ──────────────────────────────
  app.get('/guilds', (_req, res) => {
    const guilds = [];
    for (const [, guild] of discordClient.guilds.cache) {
      guilds.push({ id: guild.id, name: guild.name, iconURL: guild.iconURL() });
    }
    res.json({ guilds });
  });

  // ── GET /guilds/:guildId/channels — list voice channels in a guild ───────────
  app.get('/guilds/:guildId/channels', (req, res) => {
    const guild = discordClient.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    const channels = [];
    for (const [, ch] of guild.channels.cache) {
      if (ch.type === 2 /* GuildVoice */ || ch.type === 13 /* GuildStageVoice */) {
        channels.push({ id: ch.id, name: ch.name });
      }
    }
    res.json({ channels });
  });

  // ── POST /connect — join a voice channel without playing ───────────────────────
  app.post('/connect', async (req, res) => {
    const { guildId, channelId } = req.body ?? {};
    if (!guildId || !channelId) return res.status(400).json({ error: 'guildId and channelId required' });

    const guild = discordClient.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });
    const voiceChannel = guild.channels.cache.get(channelId);
    if (!voiceChannel) return res.status(404).json({ error: 'Voice channel not found' });

    try {
      const state = music.get(guildId);
      if (!state.connection || state.voiceChannelId !== channelId) {
        state.connect(voiceChannel);
      }
      res.json({ ok: true, channelName: voiceChannel.name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /disconnect — leave the voice channel ───────────────────────────
  app.post('/disconnect', (req, res) => {
    const { guildId } = req.body ?? {};
    if (!guildId) return res.status(400).json({ error: 'guildId required' });
    const state = music.peek(guildId);
    if (state) state.destroy();
    res.json({ ok: true });
  });

  // ── GET /status — current playback state ────────────────────────────────────
  app.get('/status', (req, res) => {
    const guildId = getGuildId(req);
    if (!guildId) return res.status(400).json({ error: 'guildId required' });

    const state = music.peek(guildId);
    if (!state || !state.current) {
      return res.json({
        playing: false,
        current: null,
        positionSec: 0,
        durationSec: 0,
        paused: false,
        loopMode: 'off',
        queue: [],
      });
    }

    res.json({
      playing: state.playing,
      current: {
        url: state.current.url,
        title: state.current.title,
        durationSec: state.current.durationInSec ?? 0,
        thumbnail: youtubeThumbnail(state.current.url),
        requestedBy: state.current.requestedBy ?? null,
      },
      positionSec: state.getPosition(),
      durationSec: state.getDuration(),
      paused: state.isPaused(),
      loopMode: state.loopMode,
      queue: state.queue.map((t, i) => ({
        index: i,
        url: t.url,
        title: t.title,
        durationSec: t.durationInSec ?? 0,
        thumbnail: youtubeThumbnail(t.url),
        requestedBy: t.requestedBy ?? null,
      })),
    });
  });

  // ── GET /history — recently played tracks ────────────────────────────────────
  app.get('/history', (req, res) => {
    const guildId = getGuildId(req);
    if (!guildId) return res.status(400).json({ error: 'guildId required' });

    const history = store.getHistory(guildId).map((t) => ({
      url: t.url,
      title: t.title,
      durationSec: t.durationInSec ?? 0,
      thumbnail: youtubeThumbnail(t.url),
    }));
    res.json({ history });
  });

  // ── POST /play — queue + play a track/playlist ────────────────────────────────
  app.post('/play', async (req, res) => {
    const { guildId, channelId, query, requestedBy } = req.body ?? {};
    if (!guildId || !query) {
      return res.status(400).json({ error: 'guildId and query are required' });
    }

    const guild = discordClient.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Guild not found' });

    // Resolve voice channel: use provided channelId, or find the first VC with members
    let voiceChannel = null;
    if (channelId) {
      voiceChannel = guild.channels.cache.get(channelId);
    }
    if (!voiceChannel) {
      // Auto-detect: find the first voice channel that has at least one human member
      for (const [, ch] of guild.channels.cache) {
        if ((ch.type === 2 || ch.type === 13) && ch.members.filter(m => !m.user.bot).size > 0) {
          voiceChannel = ch;
          break;
        }
      }
    }
    if (!voiceChannel) {
      return res.status(404).json({ error: 'No voice channel found. Join a VC first!' });
    }

    try {
      const { resolveTracks } = await import('./musicManager.js');
      const requester = requestedBy || 'Scify App';
      const { tracks, label } = await resolveTracks(query, requester);

      const state = music.get(guildId);
      state.textChannel = null; // desktop app, no text channel needed
      if (!state.connection || state.voiceChannelId !== voiceChannel.id) {
        state.connect(voiceChannel);
      }
      state.enqueue(tracks);
      await state.start();

      res.json({ ok: true, label, count: tracks.length });
    } catch (err) {
      console.error('[API /play]', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /control — playback actions ─────────────────────────────────────────
  app.post('/control', async (req, res) => {
    const { guildId, action } = req.body ?? {};
    if (!guildId || !action) return res.status(400).json({ error: 'guildId and action required' });

    const state = music.peek(guildId);
    if (!state) return res.status(404).json({ error: 'No active session' });

    try {
      switch (action) {
        case 'playpause':
          if (state.isPaused()) state.resume();
          else state.pause();
          break;
        case 'pause':
          state.pause();
          break;
        case 'resume':
          state.resume();
          break;
        case 'skip':
          state.skip();
          break;
        case 'stop':
          state.stop();
          break;
        case 'back':
          await state.seek(Math.max(0, state.getPosition() - 15));
          break;
        case 'forward':
          await state.seek(state.getPosition() + 15);
          break;
        case 'loop':
          state.cycleLoop();
          break;
        default:
          return res.status(400).json({ error: `Unknown action: ${action}` });
      }
      res.json({ ok: true, loopMode: state.loopMode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /seek — seek to absolute position ────────────────────────────────────
  app.post('/seek', async (req, res) => {
    const { guildId, seconds } = req.body ?? {};
    if (!guildId || seconds === undefined) {
      return res.status(400).json({ error: 'guildId and seconds required' });
    }

    const state = music.peek(guildId);
    if (!state || !state.current) return res.status(404).json({ error: 'Nothing is playing' });

    try {
      const target = await state.seek(Number(seconds));
      res.json({ ok: true, positionSec: target });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /queue/jump — jump to a specific track ───────────────────────────────
  app.post('/queue/jump', async (req, res) => {
    const { guildId, index } = req.body ?? {};
    if (!guildId || index === undefined) {
      return res.status(400).json({ error: 'guildId and index required' });
    }

    const state = music.peek(guildId);
    if (!state) return res.status(404).json({ error: 'No active session' });

    try {
      const track = await state.jumpTo(Number(index));
      res.json({ ok: true, track: { title: track.title, url: track.url } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /queue/remove — remove a track by index ─────────────────────────────
  app.post('/queue/remove', (req, res) => {
    const { guildId, index } = req.body ?? {};
    if (!guildId || index === undefined) {
      return res.status(400).json({ error: 'guildId and index required' });
    }

    const state = music.peek(guildId);
    if (!state) return res.status(404).json({ error: 'No active session' });

    const i = Number(index);
    if (i < 0 || i >= state.queue.length) {
      return res.status(400).json({ error: 'Index out of range' });
    }

    state.queue.splice(i, 1);
    res.json({ ok: true });
  });

  // ── POST /yt-auth/start — begin YouTube OAuth device-code flow ────────────
  app.post('/yt-auth/start', async (_req, res) => {
    try {
      const result = await startYouTubeLogin();
      if (result.alreadyAuth) {
        return res.json({ ok: true, alreadyAuth: true });
      }
      res.json({ ok: true, verificationUrl: result.verificationUrl, userCode: result.userCode });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /yt-auth/status — check if yt-dlp has a cached token ──────────────
  app.get('/yt-auth/status', async (_req, res) => {
    try {
      const authenticated = await checkYouTubeAuth();
      res.json({ authenticated });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /yt-auth/cancel — cancel in-progress auth ───────────────────────
  app.post('/yt-auth/cancel', (_req, res) => {
    cancelYouTubeLogin();
    res.json({ ok: true });
  });

  // ── GET /proxy/status — proxy pool health diagnostics ─────────────────────
  app.get('/proxy/status', (_req, res) => {
    res.json({
      poolSize: PROXY_POOL.length,
      proxies: getPoolStatus(),
    });
  });

  // ── Start listening ───────────────────────────────────────────────────────────
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`[API] REST bridge listening on http://127.0.0.1:${PORT}`);
    if (!SECRET) {
      console.warn('[API] WARNING: API_SECRET is not set — the API is unprotected!');
    }
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────────

function youtubeThumbnail(url) {
  if (!url) return null;
  const match = url.match(/(?:v=|youtu\.be\/|\/embed\/|\/shorts\/)([A-Za-z0-9_-]{11})/);
  if (!match) return null;
  return `https://img.youtube.com/vi/${match[1]}/mqdefault.jpg`;
}
