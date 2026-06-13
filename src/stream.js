import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';
import ffmpegPath from 'ffmpeg-static';

const require = createRequire(import.meta.url);

function resolveYtDlpPath() {
  const pkgJson = require.resolve('youtube-dl-exec/package.json');
  const pkgDir = path.dirname(pkgJson);
  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.join(pkgDir, 'bin', binName);
}

const YT_DLP = resolveYtDlpPath();

import { getNextProxy, PROXY_POOL } from './proxy.js';

const COOKIES_FILE = process.env.YT_COOKIES_FILE;
const COOKIES_FROM_BROWSER = process.env.YT_COOKIES_FROM_BROWSER;

function authArgs(proxy) {
  const args = [];
  if (proxy) {
    args.push('--proxy', proxy);
  }

  if (COOKIES_FILE) {
    if (existsSync(COOKIES_FILE)) {
      args.push('--cookies', COOKIES_FILE);
    } else {
      console.warn(`YT_COOKIES_FILE is set but the file does not exist: ${COOKIES_FILE}`);
    }
  } else if (COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', COOKIES_FROM_BROWSER);
  }
  return args;
}

/**
 * Spawn yt-dlp to download the best audio for a video and stream it to stdout.
 */
function spawnYtDlp(videoUrl, proxy) {
  const args = [
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    ...authArgs(proxy),
    '-o', '-', // write the media to stdout
    videoUrl,
  ];
  return spawn(YT_DLP, args, { windowsHide: true });
}

/**
 * Create an Ogg/Opus stream for a YouTube video, optionally seeking to
 * `seekSeconds`. Returns { stream, cleanup }.
 *
 * Rotates through the residential proxy pool automatically if a block is detected.
 */
export async function createOpusStream(videoUrl, seekSeconds = 0) {
  const maxAttempts = PROXY_POOL.length > 0 ? Math.min(5, PROXY_POOL.length) : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const proxy = getNextProxy();
    console.log(`[Stream] Attempt ${attempt}/${maxAttempts} for ${videoUrl} using proxy: ${proxy || 'Direct/None'}`);

    let ytdlp = null;
    let ffmpeg = null;
    let cleanupCalled = false;

    const cleanup = () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      for (const proc of [ytdlp, ffmpeg]) {
        if (proc && !proc.killed) {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
    };

    try {
      ytdlp = spawnYtDlp(videoUrl, proxy);

      // Collect yt-dlp's stderr so we can report a useful error (e.g. bot check).
      let ytErr = '';
      ytdlp.stderr.on('data', (d) => {
        ytErr = (ytErr + d.toString()).slice(-2000);
      });
      ytdlp.on('error', (e) => console.error('yt-dlp spawn error:', e.message));

      const ffmpegArgs = [];
      // Input seeking before -i. With a pipe this isn't a fast range seek, but it
      // still works (FFmpeg decodes and discards up to the target).
      if (seekSeconds > 0) {
        ffmpegArgs.push('-ss', String(seekSeconds));
      }
      ffmpegArgs.push(
        '-i', 'pipe:0',
        '-vn',
        '-loglevel', 'error',
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-ar', '48000',
        '-ac', '2',
        '-vbr', 'on',
        '-application', 'audio',
        '-frame_duration', '20',
        '-f', 'ogg',
        'pipe:1',
      );

      ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      ffmpeg.on('error', (e) => console.error('FFmpeg spawn error:', e.message));

      let ffErr = '';
      ffmpeg.stderr.on('data', (d) => {
        ffErr = (ffErr + d.toString()).slice(-1000);
      });
      ffmpeg.on('close', (code) => {
        if (code && code !== 0 && code !== 255) {
          console.error(`FFmpeg exited with code ${code}:`, ffErr.trim().slice(-400));
        }
      });

      // Pipe yt-dlp's audio into FFmpeg's stdin.
      ytdlp.stdout.pipe(ffmpeg.stdin);
      // Ignore EPIPE when FFmpeg closes stdin early (e.g. on skip/stop).
      ffmpeg.stdin.on('error', () => {});

      ffmpeg.stdout.on('close', cleanup);

      // Gate: only succeed once yt-dlp actually starts producing audio. If yt-dlp
      // exits before emitting any data (e.g. the bot check), reject with a clear
      // error instead of handing an empty stream to FFmpeg (which would spin).
      await new Promise((resolve, reject) => {
        let settled = false;

        const onData = () => {
          if (settled) return;
          settled = true;
          resolve();
        };

        const onClose = () => {
          if (settled) return;
          settled = true;
          cleanup();
          const msg = ytErr.trim();
          if (/not a bot|Sign in to confirm/i.test(msg)) {
            reject(
              new Error(
                `YouTube blocked this request with a bot check (Proxy: ${proxy || 'Direct/None'}).`
              )
            );
          } else {
            reject(
              new Error(
                `Could not fetch audio: ${msg.slice(-200) || 'yt-dlp failed'} (Proxy: ${proxy || 'Direct/None'}).`
              )
            );
          }
        };

        // Observe the first data chunk without consuming it (pipe still forwards it).
        ytdlp.stdout.on('data', onData);
        ytdlp.once('close', onClose);
      });

      return { stream: ffmpeg.stdout, cleanup };

    } catch (err) {
      console.warn(`[Stream] Attempt ${attempt} failed with proxy ${proxy || 'Direct/None'}: ${err.message}`);
      lastError = err;
      cleanup();

      // If this is the last attempt, bubble up the error
      if (attempt === maxAttempts) {
        throw new Error(
          `All ${maxAttempts} streaming attempts failed. ` +
          `Last error: ${lastError.message}. ` +
          `Please check your residential proxies in YT_PROXY.`
        );
      }
    }
  }
}
