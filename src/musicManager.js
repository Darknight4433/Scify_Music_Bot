import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} from '@discordjs/voice';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createOpusStream } from './stream.js';
import { store } from './store.js';

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

function resolveYtDlpPath() {
  const pkgJson = require.resolve('youtube-dl-exec/package.json');
  const pkgDir = path.dirname(pkgJson);
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(pkgDir, 'bin', binName);
}

const YT_DLP = resolveYtDlpPath();
const YT_PROXY = process.env.YT_PROXY;
const COOKIES_FILE = process.env.YT_COOKIES_FILE;

function baseArgs() {
  const args = [];
  if (YT_PROXY) args.push('--proxy', YT_PROXY);
  if (COOKIES_FILE && existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  args.push('--extractor-args', 'youtube:player_client=default,web_safari,android');
  return args;
}

/**
 * Run yt-dlp with JSON output and return parsed result(s).
 */
async function ytDlpJson(args) {
  const { stdout } = await execFileAsync(YT_DLP, [
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    ...baseArgs(),
    ...args,
  ], { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
  // yt-dlp outputs one JSON object per line (for playlists).
  const lines = stdout.trim().split('\n');
  return lines.map((l) => JSON.parse(l));
}

async function ytDlpPlaylist(url) {
  const { stdout } = await execFileAsync(YT_DLP, [
    '--dump-json',
    '--flat-playlist',
    '--no-warnings',
    ...baseArgs(),
    url,
  ], { windowsHide: true, maxBuffer: 50 * 1024 * 1024 });
  const lines = stdout.trim().split('\n');
  return lines.map((l) => JSON.parse(l));
}

/**
 * Resolve a YouTube / YouTube Music URL or search term into one or more tracks.
 * Uses yt-dlp for all lookups so everything goes through the proxy.
 * Returns { tracks: [{ url, title, durationInSec }], label }.
 */
export async function resolveTracks(query, requestedBy) {
  const isPlaylist = /[?&]list=/.test(query);

  if (isPlaylist) {
    const entries = await ytDlpPlaylist(query);
    const tracks = entries.map((e) => ({
      url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
      title: e.title || 'Unknown',
      durationInSec: e.duration ?? 0,
      requestedBy,
    }));
    const playlistTitle = entries[0]?.playlist_title || 'playlist';
    return { tracks, label: `${tracks.length} tracks from playlist "${playlistTitle}"` };
  }

  // If it looks like a URL, get info directly. Otherwise search.
  const isUrl = /^https?:\/\//.test(query);
  const args = isUrl ? [query] : [`ytsearch1:${query}`];

  const results = await ytDlpJson(args);
  if (!results.length) throw new Error('No results found for that query.');

  const v = results[0];
  return {
    tracks: [{
      url: v.webpage_url || v.url || query,
      title: v.title || 'Unknown',
      durationInSec: v.duration ?? 0,
      requestedBy,
    }],
    label: v.title || 'Unknown',
  };
}

/**
 * Holds the playback state for a single guild (server).
 */
class GuildMusicState {
  constructor(guildId) {
    this.guildId = guildId;
    this.queue = []; // upcoming tracks
    this.connection = null;
    this.player = createAudioPlayer();
    this.textChannel = null;
    this.voiceChannelId = null;
    this.playing = false;

    // The user who last started playback (used to DM them privately when the
    // queue finishes, instead of posting a public message).
    this.starterUser = null;

    // Currently playing track + the audio resource (used to read playback position).
    this.current = null;
    this.resource = null;

    // Cleanup function for the active FFmpeg/yt-dlp process, if any.
    this.cleanupStream = null;

    // Offset (seconds) applied when the current track was started via seek.
    this.seekOffset = 0;

    // Loop mode: 'off' | 'track' | 'queue'.
    this.loopMode = 'off';

    // Priority lock: the user ID that currently holds exclusive control, or null.
    this.lockHolderId = null;

    this.player.on(AudioPlayerStatus.Idle, () => {
      // A manual seek/jump replaces the resource without finishing the track,
      // so we guard against that case using the `seeking` flag.
      if (this.seeking) {
        this.seeking = false;
        return;
      }
      this.advance().catch((err) => console.error('advance error:', err));
    });

    this.player.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[player ${this.guildId}] ${oldState.status} -> ${newState.status}`);
      }
    });

    this.player.on('error', (error) => {
      console.error('Audio player error:', error.message);
      this.advance().catch((err) => console.error('advance error:', err));
    });
  }

  connect(voiceChannel) {
    this.voiceChannelId = voiceChannel.id;
    this.connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId: voiceChannel.guild.id,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
    });
    this.connection.subscribe(this.player);

    this.connection.on('stateChange', (oldState, newState) => {
      if (oldState.status !== newState.status) {
        console.log(`[voice ${this.guildId}] ${oldState.status} -> ${newState.status}`);
      }
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        this.destroy();
      }
    });
  }

  /**
   * Wait until the voice connection is fully ready to transmit audio.
   * Throws if it can't connect within the timeout.
   */
  async waitUntilReady(timeoutMs = 20_000) {
    if (!this.connection) throw new Error('Not connected to a voice channel.');
    if (this.connection.state.status === VoiceConnectionStatus.Ready) return;
    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, timeoutMs);
    } catch {
      throw new Error(
        'Could not establish the voice connection (UDP handshake failed). ' +
          'This is usually caused by a firewall, VPN, or network blocking Discord voice (UDP). ' +
          'Check Windows Firewall / your VPN, or try a different network.',
      );
    }
  }

  enqueue(tracks) {
    this.queue.push(...tracks);
  }

  async start() {
    if (!this.playing) {
      await this.waitUntilReady();
      await this.playNext();
    }
  }

  /**
   * Stream a track starting at `seekSeconds` and play it.
   */
  async streamAndPlay(track, seekSeconds = 0) {
    // Kill any previous stream process before starting a new one.
    if (this.cleanupStream) {
      this.cleanupStream();
      this.cleanupStream = null;
    }

    // yt-dlp extracts the clean audio stream directly from YouTube (no video
    // ads), and FFmpeg encodes it to Ogg/Opus. Discord plays Opus natively,
    // so we skip the lossy PCM -> opusscript re-encode for better quality.
    const { stream, cleanup } = await createOpusStream(track.url, seekSeconds);
    this.cleanupStream = cleanup;

    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus });

    this.resource = resource;
    this.seekOffset = seekSeconds;
    this.player.play(resource);
  }

  async playNext() {
    const track = this.queue.shift();
    if (!track) {
      this.playing = false;
      this.current = null;
      this.resource = null;
      if (this.cleanupStream) {
        this.cleanupStream();
        this.cleanupStream = null;
      }
      this.lockHolderId = null;
      return;
    }

    this.current = track;
    this.playing = true;
    // Record this track in the guild's history and persist the session.
    store.addHistory(this.guildId, track);

    try {
      await this.streamAndPlay(track, 0);
      this.failStreak = 0;
      this.persistSession();
    } catch (err) {
      // Extraction failed (e.g. bot check, deleted/age-restricted video).
      this.failStreak = (this.failStreak ?? 0) + 1;
      console.error(`Failed to play "${track.title}": ${err.message}`);

      // A bot check fails every track, so don't churn the whole queue —
      // stop after a few consecutive failures and report it.
      if (this.failStreak >= 3 || this.queue.length === 0) {
        this.stop();
        throw err;
      }
      // Otherwise skip this track and try the next one.
      await this.playNext();
    }
  }

  /**
   * Save the current playback session (track + position + remaining queue)
   * so it can be resumed after a stop or a restart.
   */
  persistSession() {
    if (!this.current) {
      store.clearSession(this.guildId);
      return;
    }
    store.saveSession(this.guildId, {
      track: {
        url: this.current.url,
        title: this.current.title,
        durationInSec: this.current.durationInSec ?? 0,
      },
      positionSec: this.getPosition(),
      queue: this.queue.map((t) => ({
        url: t.url,
        title: t.title,
        durationInSec: t.durationInSec ?? 0,
      })),
    });
  }

  /**
   * Called when a track finishes naturally. Honors the loop mode:
   * - 'track': replay the current track.
   * - 'queue': push the finished track to the back, then play the next.
   * - 'off':   just play the next track.
   */
  async advance() {
    if (this.loopMode === 'track' && this.current) {
      await this.streamAndPlay(this.current, 0);
      return;
    }
    if (this.loopMode === 'queue' && this.current) {
      this.queue.push(this.current);
    }
    await this.playNext();
  }

  /**
   * Cycle the loop mode: off -> track -> queue -> off. Returns the new mode.
   */
  cycleLoop() {
    this.loopMode = this.loopMode === 'off' ? 'track' : this.loopMode === 'track' ? 'queue' : 'off';
    return this.loopMode;
  }

  /**
   * Jump directly to a track in the queue by its index (0-based) and play it.
   */
  async jumpTo(index) {
    if (index < 0 || index >= this.queue.length) {
      throw new Error('That track is no longer in the queue.');
    }
    const [track] = this.queue.splice(index, 1);
    this.current = track;
    this.playing = true;
    this.seeking = true; // replacing the resource shouldn't trigger auto-advance
    await this.streamAndPlay(track, 0);
    return track;
  }

  /**
   * Current playback position in seconds (accounts for any seek offset).
   */
  getPosition() {
    if (!this.resource) return 0;
    return this.seekOffset + Math.floor(this.resource.playbackDuration / 1000);
  }

  getDuration() {
    return this.current?.durationInSec ?? 0;
  }

  /**
   * Seek the current track to an absolute position (seconds).
   */
  async seek(seconds) {
    if (!this.current) throw new Error('Nothing is playing.');
    const duration = this.getDuration();
    let target = Math.max(0, Math.floor(seconds));
    if (duration && target >= duration) target = Math.max(0, duration - 1);

    this.seeking = true; // prevent the Idle handler from advancing the queue
    await this.streamAndPlay(this.current, target);
    return target;
  }

  skip() {
    this.player.stop(true);
  }

  pause() {
    return this.player.pause();
  }

  resume() {
    return this.player.unpause();
  }

  isPaused() {
    return this.player.state.status === AudioPlayerStatus.Paused;
  }

  stop() {
    // Capture the session (track + position + queue) before clearing, so the
    // user can "continue" from where they stopped later.
    if (this.current) {
      store.saveSession(this.guildId, {
        track: {
          url: this.current.url,
          title: this.current.title,
          durationInSec: this.current.durationInSec ?? 0,
        },
        positionSec: this.getPosition(),
        queue: this.queue.map((t) => ({
          url: t.url,
          title: t.title,
          durationInSec: t.durationInSec ?? 0,
        })),
      });
    }

    this.queue = [];
    this.seeking = false;
    this.loopMode = 'off';
    this.player.stop(true);
    if (this.cleanupStream) {
      this.cleanupStream();
      this.cleanupStream = null;
    }
    this.playing = false;
    this.current = null;
    this.resource = null;
    this.lockHolderId = null;
  }

  /**
   * Resume a saved session: load its queue, then play its track at the saved
   * position. `session` comes from the persistent store.
   */
  async resumeSession(session) {
    if (!session?.track) throw new Error('No saved session to continue.');
    await this.waitUntilReady();

    this.queue = (session.queue ?? []).map((t) => ({ ...t }));
    // Only guard against the replaced-resource Idle event if something is
    // already playing; when starting from idle no such event fires.
    if (this.current) this.seeking = true;
    this.current = { ...session.track };
    this.playing = true;
    store.addHistory(this.guildId, this.current);

    const start = Math.max(0, Math.floor(session.positionSec ?? 0));
    await this.streamAndPlay(this.current, start);
    this.persistSession();
  }

  /**
   * Play a single track immediately (used by the library "replay" buttons),
   * keeping any existing queue intact.
   */
  async playTrackNow(track) {
    await this.waitUntilReady();
    if (this.current) this.seeking = true;
    this.current = { ...track };
    this.playing = true;
    store.addHistory(this.guildId, this.current);
    await this.streamAndPlay(this.current, 0);
    this.persistSession();
  }

  destroy() {
    this.stop();
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        // already destroyed
      }
      this.connection = null;
    }
    this.voiceChannelId = null;
  }
}

/**
 * Tracks one GuildMusicState per guild.
 */
export class MusicManager {
  constructor() {
    this.states = new Map();
  }

  get(guildId) {
    if (!this.states.has(guildId)) {
      this.states.set(guildId, new GuildMusicState(guildId));
    }
    return this.states.get(guildId);
  }

  peek(guildId) {
    return this.states.get(guildId) ?? null;
  }

  remove(guildId) {
    const state = this.states.get(guildId);
    if (state) {
      state.destroy();
      this.states.delete(guildId);
    }
  }
}
