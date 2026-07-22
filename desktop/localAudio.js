/**
 * localAudio.js — Local audio pipeline for Scify Music.
 *
 * Spawns yt-dlp piped to FFmpeg to produce MP3 audio data,
 * then delivers chunks to the renderer process via IPC events.
 *
 * Export: createLocalAudioPipeline(mainWindow, settings)
 * Returns: { play(url, seekSeconds), stop(), isActive() }
 */

import { spawn } from 'child_process';

/**
 * Create a local audio pipeline that streams MP3 data to the renderer.
 *
 * @param {import('electron').BrowserWindow} mainWindow - The main Electron window
 * @param {import('electron-store')} settings - Electron Store instance for settings
 * @returns {{ play: (url: string, seekSeconds?: number) => void, stop: () => void, isActive: () => boolean }}
 */
export function createLocalAudioPipeline(mainWindow, settings) {
  /** @type {import('child_process').ChildProcess | null} */
  let ytdlpProcess = null;
  /** @type {import('child_process').ChildProcess | null} */
  let ffmpegProcess = null;
  let active = false;
  /** @type {string | null} */
  let currentUrl = null;

  /**
   * Stop and kill any running pipeline processes.
   */
  function stop() {
    active = false;
    currentUrl = null;

    if (ytdlpProcess) {
      try {
        ytdlpProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      ytdlpProcess = null;
    }

    if (ffmpegProcess) {
      try {
        ffmpegProcess.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      ffmpegProcess = null;
    }
  }

  /**
   * Start processing a track for local playback.
   * Spawns yt-dlp → FFmpeg pipeline, streams MP3 chunks to renderer.
   *
   * @param {string} url - YouTube URL or search query
   * @param {number} seekSeconds - Start position in seconds (default 0)
   */
  function play(url, seekSeconds = 0) {
    // Kill any prior pipeline before starting a new one (Requirement 2.4)
    stop();

    active = true;
    currentUrl = url;

    let durationSec = 0;
    let ytdlpErrorOutput = '';
    let ffmpegErrorOutput = '';
    let pipelineFinished = false;

    // Spawn yt-dlp to fetch audio stream
    const ytdlpArgs = [
      '--no-playlist',
      '-f', 'bestaudio',
      '-o', '-',       // output to stdout
      url,
    ];

    ytdlpProcess = spawn('yt-dlp', ytdlpArgs, {
      windowsHide: true,
    });

    // Build FFmpeg args for MP3 128kbps transcoding
    const ffmpegArgs = [
      '-i', 'pipe:0',        // read from stdin (piped from yt-dlp)
      '-vn',                  // no video
    ];

    // Add seek if requested
    if (seekSeconds > 0) {
      ffmpegArgs.push('-ss', String(seekSeconds));
    }

    ffmpegArgs.push(
      '-codec:a', 'libmp3lame',
      '-b:a', '128k',
      '-f', 'mp3',
      'pipe:1',              // output to stdout
    );

    ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
      windowsHide: true,
    });

    // Pipe yt-dlp stdout → FFmpeg stdin
    ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);

    // Capture yt-dlp stderr for duration parsing and error reporting
    ytdlpProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      ytdlpErrorOutput += text;

      // Try to parse duration from yt-dlp output
      const durationMatch = text.match(/Duration:\s*(\d+)/);
      if (durationMatch) {
        durationSec = parseInt(durationMatch[1], 10);
      }
    });

    // Capture FFmpeg stderr for duration and error reporting
    ffmpegProcess.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      ffmpegErrorOutput += text;

      // Parse duration from FFmpeg output (format: Duration: HH:MM:SS.ms)
      const durationMatch = text.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
      if (durationMatch) {
        const hours = parseInt(durationMatch[1], 10);
        const minutes = parseInt(durationMatch[2], 10);
        const seconds = parseInt(durationMatch[3], 10);
        durationSec = hours * 3600 + minutes * 60 + seconds;
      }
    });

    // Stream MP3 chunks from FFmpeg stdout to renderer via IPC
    ffmpegProcess.stdout.on('data', (chunk) => {
      if (!active) return;
      try {
        mainWindow.webContents.send('local-audio-chunk', { chunk });
      } catch {
        // Window may have been destroyed
      }
    });

    // Handle yt-dlp process exit
    ytdlpProcess.on('error', (err) => {
      if (!active) return;
      const message = `yt-dlp failed to start: ${err.message}`;
      emitError(message);
      stop();
    });

    ytdlpProcess.on('close', (code) => {
      ytdlpProcess = null;

      if (code !== 0 && active && !pipelineFinished) {
        const message = ytdlpErrorOutput.trim()
          ? `yt-dlp error: ${ytdlpErrorOutput.trim().split('\n').pop()}`
          : `yt-dlp exited with code ${code}`;
        emitError(message);
        stop();
      }
    });

    // Handle FFmpeg process exit
    ffmpegProcess.on('error', (err) => {
      if (!active) return;
      const message = `FFmpeg failed to start: ${err.message}`;
      emitError(message);
      stop();
    });

    ffmpegProcess.on('close', (code) => {
      ffmpegProcess = null;

      if (!active) return;

      if (code === 0) {
        // Pipeline completed successfully
        pipelineFinished = true;
        active = false;
        try {
          mainWindow.webContents.send('local-audio-ready', { durationSec });
        } catch {
          // Window may have been destroyed
        }
      } else if (!pipelineFinished) {
        const message = ffmpegErrorOutput.trim()
          ? `FFmpeg error: ${ffmpegErrorOutput.trim().split('\n').pop()}`
          : `FFmpeg exited with code ${code}`;
        emitError(message);
        stop();
      }
    });

    // Handle broken pipe from yt-dlp to FFmpeg
    ffmpegProcess.stdin.on('error', () => {
      // Ignore EPIPE — this happens when FFmpeg closes before yt-dlp finishes
    });
  }

  /**
   * Emit an error event to the renderer.
   * @param {string} message
   */
  function emitError(message) {
    try {
      mainWindow.webContents.send('local-audio-error', { message });
    } catch {
      // Window may have been destroyed
    }
  }

  /**
   * Whether a pipeline is currently active.
   * @returns {boolean}
   */
  function isActive() {
    return active;
  }

  return { play, stop, isActive };
}
