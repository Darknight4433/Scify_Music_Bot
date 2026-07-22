// Property 4 + unit tests: Notification content includes song title
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Notifications', () => {
  it.todo('Property 4: Toast notification contains song title and "Playing in Discord VC"');
});

// --- Unit Tests for Task 3.4 ---
// Validates: Requirements 3.1, 3.2, 3.3, 3.4

describe('Notifications - Unit Tests', () => {
  let mockNotificationInstance;
  let mockIsSupported;
  let showNowPlayingNotification;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();

    mockNotificationInstance = {
      on: vi.fn(),
      show: vi.fn(),
    };
    mockIsSupported = vi.fn().mockReturnValue(true);

    vi.doMock('electron', () => ({
      Notification: Object.assign(
        vi.fn(() => mockNotificationInstance),
        { isSupported: mockIsSupported }
      ),
    }));

    const mod = await import('../notifications.js');
    showNowPlayingNotification = mod.showNowPlayingNotification;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('creates and shows a notification when Notification.isSupported() returns true', async () => {
    const { Notification } = await import('electron');

    showNowPlayingNotification({
      title: 'Test Song',
      onActivated: () => {},
    });

    expect(Notification).toHaveBeenCalledWith({
      title: 'Test Song',
      body: 'Playing in Discord VC',
    });
    expect(mockNotificationInstance.show).toHaveBeenCalledTimes(1);
  });

  it('click handler calls options.onActivated()', async () => {
    const onActivated = vi.fn();

    showNowPlayingNotification({
      title: 'Click Test',
      onActivated,
    });

    // Find the click handler registered via notification.on('click', ...)
    const clickCall = mockNotificationInstance.on.mock.calls.find(
      (call) => call[0] === 'click'
    );
    expect(clickCall).toBeDefined();

    // Invoke the click handler
    const clickHandler = clickCall[1];
    clickHandler();

    expect(onActivated).toHaveBeenCalledTimes(1);
  });

  it('does not create a notification or error when Notification.isSupported() returns false', async () => {
    mockIsSupported.mockReturnValue(false);
    const { Notification } = await import('electron');

    expect(() => {
      showNowPlayingNotification({
        title: 'Disabled Test',
        onActivated: () => {},
      });
    }).not.toThrow();

    // Notification constructor should not have been called
    expect(Notification).not.toHaveBeenCalled();
    expect(mockNotificationInstance.show).not.toHaveBeenCalled();
  });

  it('does not register a click handler when notification is skipped (unsupported)', async () => {
    mockIsSupported.mockReturnValue(false);

    showNowPlayingNotification({
      title: 'Skipped Test',
      onActivated: () => {},
    });

    expect(mockNotificationInstance.on).not.toHaveBeenCalled();
  });

  it('debounce: second call within 3 seconds does not create a new notification', async () => {
    const { Notification } = await import('electron');

    showNowPlayingNotification({
      title: 'Song 1',
      onActivated: () => {},
    });

    expect(Notification).toHaveBeenCalledTimes(1);

    // Advance less than 3 seconds
    vi.advanceTimersByTime(2000);

    showNowPlayingNotification({
      title: 'Song 2',
      onActivated: () => {},
    });

    // Should still be 1 call total (second was debounced)
    expect(Notification).toHaveBeenCalledTimes(1);
    expect(mockNotificationInstance.show).toHaveBeenCalledTimes(1);
  });

  it('debounce: call after 3+ seconds creates a new notification', async () => {
    const { Notification } = await import('electron');

    showNowPlayingNotification({
      title: 'Song 1',
      onActivated: () => {},
    });

    expect(Notification).toHaveBeenCalledTimes(1);

    // Advance past debounce threshold
    vi.advanceTimersByTime(3001);

    showNowPlayingNotification({
      title: 'Song 2',
      onActivated: () => {},
    });

    expect(Notification).toHaveBeenCalledTimes(2);
    expect(mockNotificationInstance.show).toHaveBeenCalledTimes(2);
  });
});
