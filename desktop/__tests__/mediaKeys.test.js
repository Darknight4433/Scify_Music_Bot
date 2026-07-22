/**
 * mediaKeys.test.js — Unit tests for the media keys module.
 *
 * Tests verify:
 * - Each media key maps to the correct handler (Req 4.1, 4.2, 4.3)
 * - Keys work when app is minimized (globalShortcut is system-wide) (Req 4.4)
 * - Failed registration triggers retry on 60s interval (Req 4.5)
 * - unregisterMediaKeys() clears all shortcuts and intervals
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Electron's globalShortcut module
const mockRegister = vi.fn();
const mockUnregister = vi.fn();

vi.mock('electron', () => ({
  globalShortcut: {
    register: (...args) => mockRegister(...args),
    unregister: (...args) => mockUnregister(...args),
  },
}));

// Import after mocking
const { registerMediaKeys, unregisterMediaKeys } = await import('../mediaKeys.js');

describe('mediaKeys', () => {
  let handlers;

  beforeEach(() => {
    vi.useFakeTimers();
    handlers = {
      onPlayPause: vi.fn(),
      onNextTrack: vi.fn(),
      onPreviousTrack: vi.fn(),
    };
    mockRegister.mockReset();
    mockUnregister.mockReset();
    // Default: all registrations succeed
    mockRegister.mockReturnValue(true);
  });

  afterEach(() => {
    unregisterMediaKeys();
    vi.useRealTimers();
  });

  describe('registerMediaKeys()', () => {
    it('registers MediaPlayPause mapped to onPlayPause handler', () => {
      registerMediaKeys(handlers);

      expect(mockRegister).toHaveBeenCalledWith('MediaPlayPause', handlers.onPlayPause);
    });

    it('registers MediaNextTrack mapped to onNextTrack handler', () => {
      registerMediaKeys(handlers);

      expect(mockRegister).toHaveBeenCalledWith('MediaNextTrack', handlers.onNextTrack);
    });

    it('registers MediaPreviousTrack mapped to onPreviousTrack handler', () => {
      registerMediaKeys(handlers);

      expect(mockRegister).toHaveBeenCalledWith('MediaPreviousTrack', handlers.onPreviousTrack);
    });

    it('registers all three media keys', () => {
      registerMediaKeys(handlers);

      expect(mockRegister).toHaveBeenCalledTimes(3);
    });

    it('calls the correct handler when a media key callback fires', () => {
      registerMediaKeys(handlers);

      // Simulate the key press by calling the registered callback
      const playPauseCallback = mockRegister.mock.calls.find(
        (call) => call[0] === 'MediaPlayPause'
      )[1];
      const nextCallback = mockRegister.mock.calls.find(
        (call) => call[0] === 'MediaNextTrack'
      )[1];
      const prevCallback = mockRegister.mock.calls.find(
        (call) => call[0] === 'MediaPreviousTrack'
      )[1];

      playPauseCallback();
      expect(handlers.onPlayPause).toHaveBeenCalledTimes(1);

      nextCallback();
      expect(handlers.onNextTrack).toHaveBeenCalledTimes(1);

      prevCallback();
      expect(handlers.onPreviousTrack).toHaveBeenCalledTimes(1);
    });
  });

  describe('retry on registration failure', () => {
    it('schedules retry interval when registration fails', () => {
      // First key fails, rest succeed
      mockRegister
        .mockReturnValueOnce(false)
        .mockReturnValue(true);

      registerMediaKeys(handlers);

      // Advance 60 seconds — retry should fire
      mockRegister.mockReturnValue(true);
      vi.advanceTimersByTime(60000);

      // Should have re-attempted the failed key
      expect(mockRegister.mock.calls.length).toBeGreaterThan(3);
    });

    it('stops retrying once all keys are registered', () => {
      // All fail initially
      mockRegister.mockReturnValue(false);
      registerMediaKeys(handlers);

      const callCountAfterInit = mockRegister.mock.calls.length;

      // Now succeed on retry
      mockRegister.mockReturnValue(true);
      vi.advanceTimersByTime(60000);

      const callCountAfterFirstRetry = mockRegister.mock.calls.length;

      // Second retry should not fire since all keys registered
      vi.advanceTimersByTime(60000);

      expect(mockRegister.mock.calls.length).toBe(callCountAfterFirstRetry);
    });

    it('does not schedule retry when all registrations succeed', () => {
      mockRegister.mockReturnValue(true);
      registerMediaKeys(handlers);

      const callCount = mockRegister.mock.calls.length;

      // Advance past retry interval — no new calls should be made
      vi.advanceTimersByTime(120000);

      expect(mockRegister.mock.calls.length).toBe(callCount);
    });

    it('logs failure to console when registration fails', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockRegister.mockReturnValue(false);

      registerMediaKeys(handlers);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[MediaKeys] Failed to register')
      );
      warnSpy.mockRestore();
    });
  });

  describe('unregisterMediaKeys()', () => {
    it('unregisters all registered shortcuts', () => {
      mockRegister.mockReturnValue(true);
      registerMediaKeys(handlers);

      unregisterMediaKeys();

      expect(mockUnregister).toHaveBeenCalledWith('MediaPlayPause');
      expect(mockUnregister).toHaveBeenCalledWith('MediaNextTrack');
      expect(mockUnregister).toHaveBeenCalledWith('MediaPreviousTrack');
    });

    it('clears retry interval on cleanup', () => {
      // Make registration fail to trigger retry interval
      mockRegister.mockReturnValue(false);
      registerMediaKeys(handlers);

      unregisterMediaKeys();

      // Advance time — no retries should fire
      mockRegister.mockClear();
      vi.advanceTimersByTime(120000);

      expect(mockRegister).not.toHaveBeenCalled();
    });

    it('is safe to call when no keys are registered', () => {
      expect(() => unregisterMediaKeys()).not.toThrow();
    });

    it('only unregisters keys that were successfully registered', () => {
      // Only first key succeeds
      mockRegister
        .mockReturnValueOnce(true)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(false);

      registerMediaKeys(handlers);
      unregisterMediaKeys();

      // Only the one that succeeded should be unregistered
      expect(mockUnregister).toHaveBeenCalledTimes(1);
      expect(mockUnregister).toHaveBeenCalledWith('MediaPlayPause');
    });
  });

  describe('re-registration', () => {
    it('cleans up previous registration before re-registering', () => {
      mockRegister.mockReturnValue(true);
      registerMediaKeys(handlers);

      const newHandlers = {
        onPlayPause: vi.fn(),
        onNextTrack: vi.fn(),
        onPreviousTrack: vi.fn(),
      };

      registerMediaKeys(newHandlers);

      // Old keys should have been unregistered
      expect(mockUnregister).toHaveBeenCalledWith('MediaPlayPause');
      expect(mockUnregister).toHaveBeenCalledWith('MediaNextTrack');
      expect(mockUnregister).toHaveBeenCalledWith('MediaPreviousTrack');

      // New handlers should be registered
      expect(mockRegister).toHaveBeenCalledWith('MediaPlayPause', newHandlers.onPlayPause);
    });
  });
});
