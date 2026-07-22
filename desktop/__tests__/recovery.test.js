// Properties 9, 10, 11 + unit tests: Crash Recovery
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createRecoveryManager } from '../recovery.js';

describe('Recovery', () => {
  it.todo('Property 9: Non-zero exit code triggers restart after 3s delay');
  it.todo('Property 10: Circuit breaker opens on 3+ crashes within 60s window');
  it.todo('Property 11: Crash events logged with ERROR severity including exit code');
  it.todo('Unit: Post-crash rejoin uses stored settings');
});

describe('Property 11: Crash events logged with context', () => {
  /** @type {{ info: any, warn: any, error: any }} */
  let mockLogger;
  /** @type {import('vitest').Mock} */
  let mockSpawnBot;
  /** @type {ReturnType<typeof createRecoveryManager>} */
  let manager;

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockSpawnBot = vi.fn(() => ({
      on: vi.fn(),
      kill: vi.fn(),
    }));
    manager = createRecoveryManager({
      logger: mockLogger,
      spawnBot: mockSpawnBot,
      onStatusChange: vi.fn(),
      crashThreshold: 3,
      crashWindow: 60000,
      restartDelay: 3000,
    });
  });

  /**
   * **Validates: Requirements 7.4**
   *
   * For any non-zero exit code, calling handleExit(code) logs an ERROR entry
   * that includes the exit code and a valid ISO 8601 timestamp.
   */
  it('logger.error is called with exit code and valid ISO 8601 timestamp for any non-zero exit code', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 255 }),
        (exitCode) => {
          // Create a fresh manager per iteration to avoid circuit breaker state accumulation
          const localLogger = {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
          };
          const localManager = createRecoveryManager({
            logger: localLogger,
            spawnBot: vi.fn(() => ({ on: vi.fn(), kill: vi.fn() })),
            onStatusChange: vi.fn(),
            crashThreshold: 3,
            crashWindow: 60000,
            restartDelay: 3000,
          });

          localManager.handleExit(exitCode);

          expect(localLogger.error).toHaveBeenCalledTimes(1);
          const [message, context] = localLogger.error.mock.calls[0];
          expect(message).toBe('Bot crashed');
          expect(context.exitCode).toBe(exitCode);
          expect(context.timestamp).toMatch(
            /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
          );

          // Verify it's a valid date
          const parsed = new Date(context.timestamp);
          expect(parsed.getTime()).not.toBeNaN();
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Exit code 0 is a clean shutdown and should NOT produce any error log.
   */
  it('exit code 0 does not produce any error log', () => {
    manager.handleExit(0);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});


// Property 10: Circuit breaker opens on rapid crashes
// Validates: Requirements 7.3

describe('Property 10: Circuit breaker opens on rapid crashes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeManager(opts = {}) {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const spawnBot = vi.fn(() => ({ on: vi.fn(), kill: vi.fn() }));
    const onStatusChange = vi.fn();
    const manager = createRecoveryManager({
      logger,
      spawnBot,
      onStatusChange,
      crashThreshold: 3,
      crashWindow: 60000,
      restartDelay: 3000,
      ...opts,
    });
    return { manager, logger, spawnBot, onStatusChange };
  }

  it('circuit opens when 3+ crashes occur within 60s window (property)', () => {
    fc.assert(
      fc.property(
        // Generate between 3 and 10 crashes, all within 60s window
        fc.integer({ min: 3, max: 10 }),
        fc.array(fc.integer({ min: 0, max: 59999 }), { minLength: 3, maxLength: 10 }),
        (crashCount, delays) => {
          const { manager, onStatusChange } = makeManager();

          // Use exactly crashCount delays, all within the 60s window
          const usedDelays = delays.slice(0, crashCount);

          // Sort delays so we advance time in order
          usedDelays.sort((a, b) => a - b);

          // Simulate crashes at each time offset
          for (let i = 0; i < usedDelays.length; i++) {
            if (i === 0) {
              vi.advanceTimersByTime(usedDelays[i]);
            } else {
              vi.advanceTimersByTime(usedDelays[i] - usedDelays[i - 1]);
            }
            manager.handleExit(1);
          }

          // Circuit should be open since 3+ crashes happened within 60s
          expect(manager.isCircuitOpen()).toBe(true);
          // onStatusChange should have been called with 'circuit-open'
          expect(onStatusChange).toHaveBeenCalledWith('circuit-open');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('circuit stays closed when fewer than 3 crashes occur within 60s (property)', () => {
    fc.assert(
      fc.property(
        // Generate 1 or 2 crashes (fewer than threshold)
        fc.integer({ min: 1, max: 2 }),
        (crashCount) => {
          const { manager, onStatusChange } = makeManager();

          // All crashes happen within the 60s window
          for (let i = 0; i < crashCount; i++) {
            vi.advanceTimersByTime(1000); // 1s between each
            manager.handleExit(1);
          }

          // Circuit should remain closed
          expect(manager.isCircuitOpen()).toBe(false);
          // onStatusChange should NOT have been called with 'circuit-open'
          expect(onStatusChange).not.toHaveBeenCalledWith('circuit-open');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('circuit stays closed when crashes are spread beyond 60s window (property)', () => {
    fc.assert(
      fc.property(
        // Generate 3 to 8 total crashes
        fc.integer({ min: 3, max: 8 }),
        (totalCrashes) => {
          const { manager, onStatusChange } = makeManager();

          // Space each crash more than 60s apart so sliding window never has 3+
          for (let i = 0; i < totalCrashes; i++) {
            // Advance 61 seconds between each crash so old ones expire
            vi.advanceTimersByTime(61000);
            manager.handleExit(1);
          }

          // Circuit should remain closed because no 60s window contains 3+ crashes
          expect(manager.isCircuitOpen()).toBe(false);
          expect(onStatusChange).not.toHaveBeenCalledWith('circuit-open');
        }
      ),
      { numRuns: 100 }
    );
  });
});
