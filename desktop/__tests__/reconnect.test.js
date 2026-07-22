// Property 8: Exponential backoff delay calculation
// Validates: Requirements 6.3
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeBackoffDelay } from '../reconnect.js';

describe('Property 8: Exponential backoff delay calculation', () => {
  it('delay equals min(5000 * 2^retryCount, 60000) for any non-negative retry count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (retryCount) => {
        const result = computeBackoffDelay(retryCount);
        const expected = Math.min(5000 * Math.pow(2, retryCount), 60000);
        expect(result).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });

  it('result is always >= baseDelay (5000) for default parameters', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (retryCount) => {
        const result = computeBackoffDelay(retryCount);
        expect(result).toBeGreaterThanOrEqual(5000);
      }),
      { numRuns: 100 }
    );
  });

  it('result is always <= maxDelay (60000) for default parameters', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), (retryCount) => {
        const result = computeBackoffDelay(retryCount);
        expect(result).toBeLessThanOrEqual(60000);
      }),
      { numRuns: 100 }
    );
  });

  it('specific values: retryCount=0 → 5000, 1 → 10000, 2 → 20000, 3 → 40000, 4+ → 60000', () => {
    expect(computeBackoffDelay(0)).toBe(5000);
    expect(computeBackoffDelay(1)).toBe(10000);
    expect(computeBackoffDelay(2)).toBe(20000);
    expect(computeBackoffDelay(3)).toBe(40000);
    expect(computeBackoffDelay(4)).toBe(60000);
    expect(computeBackoffDelay(5)).toBe(60000);
    expect(computeBackoffDelay(10)).toBe(60000);
  });

  it('works with custom baseDelay and maxDelay parameters', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 100, max: 10000 }),
        fc.integer({ min: 10000, max: 120000 }),
        (retryCount, baseDelay, maxDelay) => {
          const result = computeBackoffDelay(retryCount, baseDelay, maxDelay);
          const expected = Math.min(baseDelay * Math.pow(2, retryCount), maxDelay);
          expect(result).toBe(expected);
          expect(result).toBeGreaterThanOrEqual(Math.min(baseDelay, maxDelay));
          expect(result).toBeLessThanOrEqual(maxDelay);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ============================================================
// Unit Tests for reconnect module (Task 7.4)
// Validates: Requirements 6.1, 6.2, 6.3, 6.4
// ============================================================
import { vi, describe as desc, it as test, expect as assert, beforeEach, afterEach } from 'vitest';
import { createReconnectManager } from '../reconnect.js';

desc('ReconnectManager — Unit Tests', () => {
  let manager;
  let mockLogger;
  let mockOnStatusChange;
  let mockOnReconnect;

  beforeEach(() => {
    vi.useFakeTimers();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    mockOnStatusChange = vi.fn();
    mockOnReconnect = vi.fn().mockResolvedValue(undefined);

    manager = createReconnectManager({
      logger: mockLogger,
      onStatusChange: mockOnStatusChange,
      onReconnect: mockOnReconnect,
      maxRetries: 5,
      baseDelay: 5000,
      maxDelay: 60000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('1. Initially status is "online" after start()', () => {
    manager.start();
    assert(manager.getStatus()).toBe('online');
  });

  test('2. triggerOffline() sets status to "offline" and calls onStatusChange("offline")', () => {
    manager.start();
    manager.triggerOffline();

    assert(manager.getStatus()).toBe('offline');
    assert(mockOnStatusChange).toHaveBeenCalledWith('offline');
  });

  test('3. triggerOnline() after offline sets status to "reconnecting" and calls onStatusChange("reconnecting")', () => {
    manager.start();
    manager.triggerOffline();
    mockOnStatusChange.mockClear();

    manager.triggerOnline();

    assert(manager.getStatus()).toBe('reconnecting');
    assert(mockOnStatusChange).toHaveBeenCalledWith('reconnecting');
  });

  test('4. Successful onReconnect() sets status to "online" and calls onStatusChange("online")', async () => {
    manager.start();
    manager.triggerOffline();
    manager.triggerOnline();

    // Let the async attemptReconnect resolve
    await vi.runAllTimersAsync();

    assert(manager.getStatus()).toBe('online');
    assert(mockOnStatusChange).toHaveBeenCalledWith('online');
    assert(mockOnReconnect).toHaveBeenCalledTimes(1);
  });

  test('5. Failed onReconnect() triggers retry with backoff delay', async () => {
    mockOnReconnect.mockRejectedValueOnce(new Error('connection refused'));

    manager.start();
    manager.triggerOffline();
    manager.triggerOnline();

    // First attempt fails
    await vi.advanceTimersByTimeAsync(0);

    // After failure, status should still be reconnecting
    assert(manager.getStatus()).toBe('reconnecting');
    assert(mockOnReconnect).toHaveBeenCalledTimes(1);

    // The retry should be scheduled with backoff: min(5000 * 2^1, 60000) = 10000ms
    // (retryCount becomes 1 after the first failure)
    mockOnReconnect.mockResolvedValueOnce(undefined);
    await vi.advanceTimersByTimeAsync(10000);

    // Second attempt should succeed
    assert(mockOnReconnect).toHaveBeenCalledTimes(2);
    assert(manager.getStatus()).toBe('online');
  });

  test('6. After maxRetries consecutive failures, stops retrying and sets status to "offline"', async () => {
    // All reconnect attempts will fail
    mockOnReconnect.mockRejectedValue(new Error('network unavailable'));

    manager.start();
    manager.triggerOffline();
    manager.triggerOnline();

    // Run through all retries: initial attempt + 4 more (maxRetries = 5)
    // Attempt 1: immediate (retryCount goes to 1)
    await vi.advanceTimersByTimeAsync(0);
    assert(mockOnReconnect).toHaveBeenCalledTimes(1);

    // Attempt 2: after 10000ms (5000 * 2^1)
    await vi.advanceTimersByTimeAsync(10000);
    assert(mockOnReconnect).toHaveBeenCalledTimes(2);

    // Attempt 3: after 20000ms (5000 * 2^2)
    await vi.advanceTimersByTimeAsync(20000);
    assert(mockOnReconnect).toHaveBeenCalledTimes(3);

    // Attempt 4: after 40000ms (5000 * 2^3)
    await vi.advanceTimersByTimeAsync(40000);
    assert(mockOnReconnect).toHaveBeenCalledTimes(4);

    // Attempt 5: after 60000ms (capped: min(5000 * 2^4, 60000) = 60000)
    await vi.advanceTimersByTimeAsync(60000);
    assert(mockOnReconnect).toHaveBeenCalledTimes(5);

    // After 5 failures, should stop and set status to 'offline'
    assert(manager.getStatus()).toBe('offline');
    assert(mockLogger.error).toHaveBeenCalledWith(
      'Reconnection failed after maximum retries',
      expect.objectContaining({ retryCount: 5, maxRetries: 5 })
    );

    // No more retries should be scheduled - advance a long time
    await vi.advanceTimersByTimeAsync(120000);
    assert(mockOnReconnect).toHaveBeenCalledTimes(5);
  });

  test('7. stop() clears pending timeouts and resets state', async () => {
    mockOnReconnect.mockRejectedValueOnce(new Error('fail'));

    manager.start();
    manager.triggerOffline();
    manager.triggerOnline();

    // First attempt fails, retry is scheduled
    await vi.advanceTimersByTimeAsync(0);
    assert(mockOnReconnect).toHaveBeenCalledTimes(1);

    // Stop the manager before the retry fires
    manager.stop();

    // Advance time past the retry delay — no more attempts should happen
    await vi.advanceTimersByTimeAsync(60000);
    assert(mockOnReconnect).toHaveBeenCalledTimes(1);

    // State should be reset
    assert(manager.getStatus()).toBe('online');
  });

  test('8. triggerOffline/triggerOnline are no-ops before start() is called', () => {
    // Don't call start()
    manager.triggerOffline();
    manager.triggerOnline();

    assert(manager.getStatus()).toBe('online');
    assert(mockOnStatusChange).not.toHaveBeenCalled();
    assert(mockOnReconnect).not.toHaveBeenCalled();
  });
});
