// Properties 5, 6, 7: Rich Presence property-based tests
// Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import * as fc from 'fast-check';

// Shared mocks for discord-rpc
const mockSetActivity = vi.fn().mockResolvedValue(undefined);
const mockLogin = vi.fn().mockResolvedValue(undefined);
const mockDestroy = vi.fn().mockResolvedValue(undefined);
const mockClearActivity = vi.fn().mockResolvedValue(undefined);

vi.mock('discord-rpc', () => ({
  default: {
    register: vi.fn(),
    Client: class MockClient {
      constructor() {
        this.setActivity = mockSetActivity;
        this.login = mockLogin;
        this.destroy = mockDestroy;
        this.clearActivity = mockClearActivity;
      }
    },
  },
}));

const { connectRPC, updatePresence } = await import('../rpc.js');

// --- Property 5: Rich Presence details field contains title ---
describe('Property 5: Rich Presence details field contains title', () => {
  /** Validates: Requirements 5.2 */

  beforeEach(async () => {
    mockSetActivity.mockClear();
    await connectRPC();
  });

  it('details field equals title when length <= 128, truncates with "…" when > 128, and defaults to "Unknown" for empty/null', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 200 }),
        async (title) => {
          mockSetActivity.mockClear();

          await updatePresence({
            title,
            positionSec: 0,
            durationSec: 180,
            paused: false,
          });

          expect(mockSetActivity).toHaveBeenCalledTimes(1);
          const activity = mockSetActivity.mock.calls[0][0];

          if (!title) {
            expect(activity.details).toBe('Unknown');
          } else if (title.length <= 128) {
            expect(activity.details).toBe(title);
          } else {
            const expected = title.slice(0, 127) + '…';
            expect(activity.details).toBe(expected);
            expect(activity.details.length).toBe(128);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('details field is "Unknown" when title is null or undefined', async () => {
    for (const title of [null, undefined]) {
      mockSetActivity.mockClear();

      await updatePresence({
        title,
        positionSec: 0,
        durationSec: 180,
        paused: false,
      });

      expect(mockSetActivity).toHaveBeenCalledTimes(1);
      const activity = mockSetActivity.mock.calls[0][0];
      expect(activity.details).toBe('Unknown');
    }
  });
});

// --- Property 6: Rich Presence elapsed time calculation ---
describe('Property 6: Rich Presence elapsed time calculation', () => {
  /** Validates: Requirements 5.3 */

  beforeEach(async () => {
    mockSetActivity.mockClear();
    await connectRPC();
  });

  it('startTimestamp = Date.now() - positionSec * 1000 (±100ms) when not paused', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100000 }),
        async (positionSec) => {
          const fixedNow = Date.now();
          mockSetActivity.mockClear();

          await updatePresence({
            title: 'Test Song',
            positionSec,
            durationSec: positionSec + 60,
            paused: false,
          });

          expect(mockSetActivity).toHaveBeenCalledTimes(1);
          const call = mockSetActivity.mock.calls[0][0];
          const startTimestamp = call.startTimestamp;

          expect(startTimestamp).toBeInstanceOf(Date);
          const expectedMs = fixedNow - positionSec * 1000;
          const actualMs = startTimestamp.getTime();
          expect(Math.abs(actualMs - expectedMs)).toBeLessThanOrEqual(100);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('startTimestamp is undefined when paused', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 100000 }),
        async (positionSec) => {
          mockSetActivity.mockClear();

          await updatePresence({
            title: 'Test Song',
            positionSec,
            durationSec: positionSec + 60,
            paused: true,
          });

          expect(mockSetActivity).toHaveBeenCalledTimes(1);
          const call = mockSetActivity.mock.calls[0][0];
          expect(call.startTimestamp).toBeUndefined();
        }
      ),
      { numRuns: 100 }
    );
  });
});

// --- Property 7: Rich Presence state field formatting ---
describe('Property 7: Rich Presence state field formatting', () => {
  /** Validates: Requirements 5.4, 5.5, 5.6 */

  beforeEach(async () => {
    mockSetActivity.mockClear();
    await connectRPC();
  });

  it('state equals "${channelName} • ${queueLength} in queue" for any non-empty channelName and positive queueLength', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        fc.integer({ min: 1, max: 1000 }),
        async (channelName, queueLength) => {
          mockSetActivity.mockClear();
          await updatePresence({
            title: 'Test Song',
            positionSec: 0,
            durationSec: 200,
            paused: false,
            channelName,
            queueLength,
          });

          expect(mockSetActivity).toHaveBeenCalledTimes(1);
          const activity = mockSetActivity.mock.calls[0][0];
          expect(activity.state).toBe(`${channelName} • ${queueLength} in queue`);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('state equals just the channelName when queueLength is 0', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        async (channelName) => {
          mockSetActivity.mockClear();
          await updatePresence({
            title: 'Test Song',
            positionSec: 0,
            durationSec: 200,
            paused: false,
            channelName,
            queueLength: 0,
          });

          expect(mockSetActivity).toHaveBeenCalledTimes(1);
          const activity = mockSetActivity.mock.calls[0][0];
          expect(activity.state).toBe(channelName);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('state always contains the channelName when channelName is provided', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 50 }).filter(s => s.trim().length > 0),
        fc.oneof(
          fc.constant(0),
          fc.constant(undefined),
          fc.constant(null),
          fc.integer({ min: 1, max: 1000 })
        ),
        async (channelName, queueLength) => {
          mockSetActivity.mockClear();
          await updatePresence({
            title: 'Test Song',
            positionSec: 0,
            durationSec: 200,
            paused: false,
            channelName,
            queueLength,
          });

          expect(mockSetActivity).toHaveBeenCalledTimes(1);
          const activity = mockSetActivity.mock.calls[0][0];
          expect(activity.state).toContain(channelName);
        }
      ),
      { numRuns: 100 }
    );
  });
});
