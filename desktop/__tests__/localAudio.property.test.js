/**
 * Property-based tests for desktop/localAudio.js — Local Audio Pipeline
 *
 * Property 7: Pipeline cleanup on new track
 * Validates: Requirements 2.4
 *
 * For any two consecutive track play requests in local mode, the Local Audio
 * Pipeline SHALL terminate all yt-dlp and FFmpeg child processes from the prior
 * track before spawning new processes for the next track. At no point should
 * more than one set of pipeline processes be active.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fc from 'fast-check';

// Mock child_process.spawn
vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { createLocalAudioPipeline } from '../localAudio.js';

/**
 * Helper: create a mock child process with EventEmitter-based streams.
 * Each process tracks whether it has been killed.
 */
function createMockProcess(id) {
  const proc = new EventEmitter();
  proc.id = id;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new EventEmitter();
  proc.stdin.write = vi.fn();
  proc.stdin.end = vi.fn();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  proc.stdout.pipe = vi.fn((target) => target);
  return proc;
}

describe('Property 7: Pipeline cleanup on new track', () => {
  let mainWindow;
  let settings;

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
    spawn.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  /**
   * **Validates: Requirements 2.4**
   *
   * Property: For any sequence of play() calls with arbitrary URLs, prior
   * pipeline processes are always killed before new processes are spawned,
   * and at no point are more than one set of pipeline processes (1 yt-dlp + 1 FFmpeg) active.
   */
  it('should kill prior processes before spawning new ones for any sequence of play() calls', () => {
    fc.assert(
      fc.property(
        // Generate a non-empty array of track URLs (at least 2 to test transitions)
        fc.array(
          fc.webUrl({ withFragments: false, withQueryParameters: true }),
          { minLength: 2, maxLength: 10 }
        ),
        (urls) => {
          // Reset mocks for each test case
          spawn.mockReset();

          // Track all spawned processes and their state
          let processCounter = 0;
          const allProcesses = [];
          let currentActiveProcesses = [];

          // Track ordering: for each play() call, record events in order
          const eventLog = [];

          spawn.mockImplementation((cmd) => {
            const proc = createMockProcess(processCounter++);
            proc.cmd = cmd;
            allProcesses.push(proc);

            // Override kill to record the event
            const originalKill = proc.kill;
            proc.kill = vi.fn((...args) => {
              eventLog.push({ type: 'kill', processId: proc.id, cmd: proc.cmd });
              originalKill(...args);
              currentActiveProcesses = currentActiveProcesses.filter((p) => p.id !== proc.id);
            });

            // Record spawn event
            eventLog.push({ type: 'spawn', processId: proc.id, cmd: proc.cmd });
            currentActiveProcesses.push(proc);

            return proc;
          });

          const pipeline = createLocalAudioPipeline(mainWindow, settings);

          // Track max concurrent active processes at any point
          let maxConcurrentProcesses = 0;

          // Play each URL in sequence
          for (let i = 0; i < urls.length; i++) {
            // Before each play call (after the first), record how many are active
            pipeline.play(urls[i]);

            // After each play(), at most 2 processes should be active (1 yt-dlp + 1 FFmpeg)
            const activeCount = currentActiveProcesses.length;
            maxConcurrentProcesses = Math.max(maxConcurrentProcesses, activeCount);

            // INVARIANT: Never more than 2 active processes (1 yt-dlp + 1 FFmpeg for current track)
            expect(activeCount).toBeLessThanOrEqual(2);
          }

          // Verify ordering: for each play() after the first, kills must come before spawns
          // Group events by play() call boundaries (each play spawns exactly 2 processes)
          // After the first play, each subsequent play should show: kill(s) then spawn(s)
          if (urls.length >= 2) {
            // Each play() call produces: kill events (for prior), then spawn events (for new)
            // First play: 2 spawns (no kills since nothing is active)
            // Subsequent plays: 2 kills (prior yt-dlp + FFmpeg) then 2 spawns (new yt-dlp + FFmpeg)

            // Verify that for transitions (play N -> play N+1), all kills happen before spawns
            // We can verify this by checking event log segments
            let eventIdx = 0;

            // First play: expect 2 spawns
            for (let s = 0; s < 2; s++) {
              expect(eventLog[eventIdx].type).toBe('spawn');
              eventIdx++;
            }

            // Subsequent plays: expect kills before spawns
            for (let i = 1; i < urls.length; i++) {
              // Should see kill events for prior processes first
              const killEvents = [];
              const spawnEvents = [];
              let seenSpawnAfterKill = false;

              // Collect all events for this play() call (2 kills + 2 spawns = 4 events)
              const segmentStart = eventIdx;
              const segmentEnd = Math.min(eventIdx + 4, eventLog.length);

              for (let j = segmentStart; j < segmentEnd; j++) {
                if (eventLog[j].type === 'kill') {
                  killEvents.push(eventLog[j]);
                  // After seeing a spawn, we should not see more kills
                  if (seenSpawnAfterKill) {
                    // This means a kill came after a spawn in this segment — violation
                    expect(seenSpawnAfterKill).toBe(false);
                  }
                } else if (eventLog[j].type === 'spawn') {
                  seenSpawnAfterKill = true;
                  spawnEvents.push(eventLog[j]);
                }
                eventIdx++;
              }

              // Each transition should kill exactly 2 prior processes and spawn exactly 2 new ones
              expect(killEvents.length).toBe(2);
              expect(spawnEvents.length).toBe(2);
            }
          }

          // INVARIANT: max concurrent never exceeds 2 (one pipeline set)
          expect(maxConcurrentProcesses).toBeLessThanOrEqual(2);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 2.4**
   *
   * Property: For any single play() call following a stop(), no kill events
   * should occur (nothing to clean up), and exactly one set of processes is spawned.
   */
  it('should not have more than one set of processes active after stop() then play()', () => {
    fc.assert(
      fc.property(
        fc.webUrl({ withFragments: false, withQueryParameters: true }),
        fc.webUrl({ withFragments: false, withQueryParameters: true }),
        (url1, url2) => {
          spawn.mockReset();

          let processCounter = 0;
          const activeProcesses = new Set();

          spawn.mockImplementation((cmd) => {
            const proc = createMockProcess(processCounter++);
            proc.cmd = cmd;
            activeProcesses.add(proc.id);

            proc.kill = vi.fn(() => {
              proc.killed = true;
              activeProcesses.delete(proc.id);
            });
            proc.stdout.pipe = vi.fn((target) => target);

            return proc;
          });

          const pipeline = createLocalAudioPipeline(mainWindow, settings);

          // Play first track
          pipeline.play(url1);
          expect(activeProcesses.size).toBe(2);

          // Stop explicitly
          pipeline.stop();
          expect(activeProcesses.size).toBe(0);

          // Play second track — should spawn fresh processes without needing kills
          pipeline.play(url2);
          expect(activeProcesses.size).toBe(2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
