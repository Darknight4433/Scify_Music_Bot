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

// --- Anti-bot / authentication options (important on VPS / datacenter IPs) ---
//
// YouTube blocks datacenter IPs with "Sign in to confirm you're not a bot".
// The reliable fix is to supply cookies from a logged-in YouTube account:
//   - YT_COOKIES_FILE: absolute path to a Netscape-format cookies.txt
//   - YT_COOKIES_FROM_BROWSER: e.g. "chrome", "firefox" (only useful if a
//     browser profile exists on the machine, which it usually doesn't on a VPS)
//
// We also pass player_client args that can help bypass the check without cookies.
const COOKIES_FILE = process.env.YT_COOKIES_FILE;
const COOKIES_FROM_BROWSER = process.env.YT_COOKIES_FROM_BROWSER;

function authArgs() {
  const args = [];
  if (COOKIES_FILE) {
    if (existsSync(COOKIES_FILE)) {
      args.push('--cookies', COOKIES_FILE);
    } else {
      console.warn(`YT_COOKIES_FILE is set but the file does not exist: ${COOKIES_FILE}`);
    }
  } else if (COOKIES_FROM_BROWSER) {
    args.push('--cookies-from-browser', COOKIES_FROM_BROWSER);
  }
  // Prefer player clients that are less likely to trigger the bot check.
  args.push('--extractor-args', 'youtube:player_client=default,web_safari,android');
  return args;
}

/**
 * Spawn yt-dlp to download the best audio for a video and stream it to stdout.
 * yt-dlp performs the authenticated fetch (using cookies if provided), which
 * is far more reliable on a VPS than letting FFmpeg fetch a googlevideo URL.
 */
function spawnYtDlp(videoUrl) {
  const args = [
    '-f', 'bestaudio/best',
    '--no-playlist',
    '--no-warnings',
    '--quiet',
    ...authArgs(),
    '-o', '-', // write the media to stdout
    videoUrl,
  ];
  return spawn(YT_DLP, args, { windowsHide: true });
}

/**
 * Create an Ogg/Opus stream for a YouTube video, optionally seeking to
 * `seekSeconds`. Returns { stream, cleanup }.
 *
 * Pipeline: yt-dlp (authenticated download) -> FFmpeg (encode to Ogg/Opus).
 * Discord plays Opus natively, so we avoid a lossy re-encode and get good audio.
 */
export async function createOpusStream(videoUrl, seekSeconds = 0) {
  const ytdlp = spawnYtDlp(videoUrl);

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

  const ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
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

  const cleanup = () => {
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
            'YouTube blocked this request with a bot check. On a VPS you must ' +
              'provide cookies: set YT_COOKIES_FILE to a cookies.txt from a ' +
              'logged-in YouTube account.',
          ),
        );
      } else {
        reject(new Error(`Could not fetch audio: ${msg.slice(-200) || 'yt-dlp failed'}`));
      }
    };

    // Observe the first data chunk without consuming it (pipe still forwards it).
    ytdlp.stdout.on('data', onData);
    ytdlp.once('close', onClose);
  });

  return { stream: ffmpeg.stdout, cleanup };
}
