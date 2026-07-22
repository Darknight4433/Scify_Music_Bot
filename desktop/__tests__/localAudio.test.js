/**
 * Unit tests for desktop/localAudio.js — Local Audio Pipeline
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { createLocalAudioPipeline } from '../localAudio.js';

/**
 * Helper: create a mock child process with EventEmitter-based streams.
 */
function createMockProcess() {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = vi.fn();
  proc.stdin.end = vi.fn();
  proc.kill = vi.fn();
  // Support piping: stdout.pipe(stdin)
  proc.stdout.pipe = vi.fn((target) => {
    // Store reference so we can simulate data flow
    proc.stdout._pipedTo = target;
    return target;
  });
  return proc;
}

describe('createLocalAudioPipeline', () => {
  let mainWindow;
  let settings;
  let pipeline;
  let mockYtdlp;
  let mockFfmpeg;

  beforeEach(() => {
    mainWindow = {
      webContents: {
        send: vi.fn(),
      },
    };
    settings = {
      get: vi.fn(),
      set: vi.fn(),
    };

    mockYtdlp = createMockProcess();
    mockFfmpeg = createMockProcess();

    // spawn returns yt-dlp first, then ffmpeg
    spawn.mockReset();
    spawn.mockImplementation((cmd) => {
      if (cmd === 'yt-dlp') return mockYtdlp;
      if (cmd === 'ffmpeg') return mockFfmpeg;
      return createMockProcess();
    });

    pipeline = createLocalAudioPipeline(mainWindow, settings);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('play()', () => {
    it('should spawn yt-dlp with correct arguments', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      expect(spawn).toHaveBeenCalledWith(
        'yt-dlp',
        expect.arrayContaining(['--no-playlist', '-f', 'bestaudio', '-o', '-', 'https://www.youtube.com/watch?v=test123']),
        expect.objectContaining({ windowsHide: true }),
      );
    });

    it('should spawn FFmpeg with MP3 128kbps output args', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      expect(spawn).toHaveBeenCalledWith(
        'ffmpeg',
        expect.arrayContaining(['-i', 'pipe:0', '-vn', '-codec:a', 'libmp3lame', '-b:a', '128k', '-f', 'mp3', 'pipe:1']),
        expect.objectContaining({ windowsHide: true }),
      );
    });

    it('should include -ss flag when seekSeconds > 0', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123', 30);

      const ffmpegCall = spawn.mock.calls.find((c) => c[0] === 'ffmpeg');
      expect(ffmpegCall[1]).toContain('-ss');
      expect(ffmpegCall[1]).toContain('30');
    });

    it('should not include -ss flag when seekSeconds is 0', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123', 0);

      const ffmpegCall = spawn.mock.calls.find((c) => c[0] === 'ffmpeg');
      expect(ffmpegCall[1]).not.toContain('-ss');
    });

    it('should pipe yt-dlp stdout to FFmpeg stdin', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      expect(mockYtdlp.stdout.pipe).toHaveBeenCalledWith(mockFfmpeg.stdin);
    });

    it('should set active to true', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      expect(pipeline.isActive()).toBe(true);
    });

    it('should call stop() before starting a new pipeline (Requirement 2.4)', () => {
      // Start first pipeline
      pipeline.play('https://www.youtube.com/watch?v=url1');
      const firstYtdlp = mockYtdlp;
      const firstFfmpeg = mockFfmpeg;

      // Reset mocks for second pipeline
      mockYtdlp = createMockProcess();
      mockFfmpeg = createMockProcess();
      spawn.mockImplementation((cmd) => {
        if (cmd === 'yt-dlp') return mockYtdlp;
        if (cmd === 'ffmpeg') return mockFfmpeg;
        return createMockProcess();
      });

      // Start second pipeline
      pipeline.play('https://www.youtube.com/watch?v=url2');

      // First pipeline processes should have been killed
      expect(firstYtdlp.kill).toHaveBeenCalledWith('SIGTERM');
      expect(firstFfmpeg.kill).toHaveBeenCalledWith('SIGTERM');
    });
  });

  describe('stop()', () => {
    it('should kill yt-dlp and FFmpeg processes', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');
      pipeline.stop();

      expect(mockYtdlp.kill).toHaveBeenCalledWith('SIGTERM');
      expect(mockFfmpeg.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('should set active to false', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');
      expect(pipeline.isActive()).toBe(true);

      pipeline.stop();
      expect(pipeline.isActive()).toBe(false);
    });

    it('should be safe to call when no pipeline is running', () => {
      expect(() => pipeline.stop()).not.toThrow();
    });
  });

  describe('isActive()', () => {
    it('should return false initially', () => {
      expect(pipeline.isActive()).toBe(false);
    });

    it('should return true while pipeline is running', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');
      expect(pipeline.isActive()).toBe(true);
    });

    it('should return false after stop()', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');
      pipeline.stop();
      expect(pipeline.isActive()).toBe(false);
    });
  });

  describe('IPC events', () => {
    it('should send local-audio-chunk when FFmpeg produces data', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      const chunk = Buffer.from('fake mp3 data');
      mockFfmpeg.stdout.emit('data', chunk);

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'local-audio-chunk',
        { chunk },
      );
    });

    it('should send local-audio-ready with durationSec when FFmpeg finishes successfully', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      // Simulate FFmpeg stderr reporting duration
      mockFfmpeg.stderr.emit('data', Buffer.from('Duration: 00:03:45.00, start:'));

      // Simulate FFmpeg closing successfully
      mockFfmpeg.emit('close', 0);

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'local-audio-ready',
        { durationSec: 225 },
      );
    });

    it('should send local-audio-error when yt-dlp fails', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      // Simulate yt-dlp stderr output
      mockYtdlp.stderr.emit('data', Buffer.from('ERROR: Video unavailable'));

      // Simulate yt-dlp exit with error code
      mockYtdlp.emit('close', 1);

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'local-audio-error',
        { message: expect.stringContaining('yt-dlp') },
      );
    });

    it('should send local-audio-error when FFmpeg fails', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      // Simulate yt-dlp finishing successfully first
      mockYtdlp.emit('close', 0);

      // Simulate FFmpeg stderr output
      mockFfmpeg.stderr.emit('data', Buffer.from('Conversion failed'));

      // Simulate FFmpeg exit with error code
      mockFfmpeg.emit('close', 1);

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'local-audio-error',
        { message: expect.stringContaining('FFmpeg') },
      );
    });

    it('should send local-audio-error when yt-dlp fails to spawn', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      mockYtdlp.emit('error', new Error('spawn yt-dlp ENOENT'));

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'local-audio-error',
        { message: expect.stringContaining('yt-dlp failed to start') },
      );
    });

    it('should send local-audio-error when FFmpeg fails to spawn', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      mockFfmpeg.emit('error', new Error('spawn ffmpeg ENOENT'));

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'local-audio-error',
        { message: expect.stringContaining('FFmpeg failed to start') },
      );
    });

    it('should not send chunks after stop()', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');
      pipeline.stop();

      mainWindow.webContents.send.mockClear();
      mockFfmpeg.stdout.emit('data', Buffer.from('late data'));

      expect(mainWindow.webContents.send).not.toHaveBeenCalledWith(
        'local-audio-chunk',
        expect.anything(),
      );
    });
  });

  describe('duration parsing', () => {
    it('should parse duration from FFmpeg stderr output', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      // FFmpeg outputs duration info on stderr
      mockFfmpeg.stderr.emit('data', Buffer.from('  Duration: 01:02:33.50, start: 0.000000'));

      // FFmpeg exits successfully
      mockFfmpeg.emit('close', 0);

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'local-audio-ready',
        { durationSec: 3753 },
      );
    });

    it('should report 0 duration when FFmpeg does not output duration info', () => {
      pipeline.play('https://www.youtube.com/watch?v=test123');

      // FFmpeg exits successfully without reporting duration
      mockFfmpeg.emit('close', 0);

      expect(mainWindow.webContents.send).toHaveBeenCalledWith(
        'local-audio-ready',
        { durationSec: 0 },
      );
    });
  });
});
