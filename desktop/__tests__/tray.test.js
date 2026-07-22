// Property 3 + unit tests: Tray menu displays current song title
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// --- Electron mocks ---
let lastTemplate = null;

vi.mock('electron', () => {
  return {
    Tray: class MockTray {
      constructor() {}
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    Menu: {
      buildFromTemplate(template) {
        lastTemplate = template;
        return { items: template };
      },
    },
    nativeImage: {
      createFromPath() {
        return { isEmpty: () => false };
      },
      createEmpty() {
        return { isEmpty: () => true };
      },
    },
  };
});

// Reset captured template before each test
beforeEach(() => {
  lastTemplate = null;
});

// Helper to create a tray manager with default options
async function createTestTray() {
  const { createTray } = await import('../tray.js');
  return createTray({
    iconPath: 'fake/icon.png',
    window: {
      isMinimized: () => false,
      show: () => {},
      focus: () => {},
      restore: () => {},
    },
    onPlay: () => {},
    onPause: () => {},
    onSkip: () => {},
    onOpen: () => {},
    onExit: () => {},
  });
}

describe('Tray — Property 3: Tray menu displays current song title', () => {
  /**
   * **Validates: Requirements 2.7**
   *
   * Property 3: For any non-empty song title string, calling
   * updateNowPlaying(title) results in the first menu item's label
   * being equal to the provided title string.
   */
  it('Property 3: updateNowPlaying(title) sets first menu item label to title for any non-empty string', async () => {
    const trayManager = await createTestTray();

    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (title) => {
          trayManager.updateNowPlaying(title);
          expect(lastTemplate).not.toBeNull();
          expect(lastTemplate[0].label).toBe(title);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 2.7**
   *
   * The first menu item is always disabled (display-only label)
   * for any non-empty title.
   */
  it('Property 3: first menu item is disabled for any non-empty title', async () => {
    const trayManager = await createTestTray();

    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        (title) => {
          trayManager.updateNowPlaying(title);
          expect(lastTemplate[0].enabled).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * **Validates: Requirements 2.7**
   *
   * When title is null, the first menu item label shows "No track playing".
   */
  it('Property 3: updateNowPlaying(null) sets label to "No track playing"', async () => {
    const trayManager = await createTestTray();

    trayManager.updateNowPlaying(null);
    expect(lastTemplate[0].label).toBe('No track playing');
    expect(lastTemplate[0].enabled).toBe(false);
  });
});


// --- Unit Tests for Task 2.4 ---

// Separate mock setup for unit tests
describe('Tray Unit Tests', () => {
  let trayInstance;
  let menuTemplate;
  let mockWindow;
  let callbacks;
  let trayManager;

  beforeEach(async () => {
    // Reset state
    trayInstance = null;
    menuTemplate = null;

    // We re-import to get a fresh createTray with our mocks already set
    const { createTray } = await import('../tray.js');

    mockWindow = {
      show: vi.fn(),
      focus: vi.fn(),
      restore: vi.fn(),
      isMinimized: vi.fn(() => false),
    };

    callbacks = {
      onPlay: vi.fn(),
      onPause: vi.fn(),
      onSkip: vi.fn(),
      onOpen: vi.fn(),
      onExit: vi.fn(),
    };

    // The vi.mock('electron') from above applies here too.
    // We need to intercept the Tray constructor and Menu.buildFromTemplate.
    // Since the mock is already defined globally, we use `lastTemplate` for menu
    // and we need to capture the tray `on` calls.
    // Let's override the mocks for this describe block:
    const electron = await import('electron');

    // Patch the MockTray prototype to capture calls
    const trayMethods = {
      setToolTip: vi.fn(),
      setContextMenu: vi.fn(),
      on: vi.fn(),
      destroy: vi.fn(),
    };

    // Override the Tray constructor for this test block
    vi.spyOn(electron, 'Tray').mockImplementation(() => {
      trayInstance = trayMethods;
      return trayMethods;
    });

    vi.spyOn(electron.Menu, 'buildFromTemplate').mockImplementation((template) => {
      menuTemplate = template;
      return template;
    });

    trayManager = createTray({
      iconPath: '/fake/icon.png',
      window: mockWindow,
      ...callbacks,
    });
  });

  describe('Menu construction', () => {
    it('has correct items in correct order: disabled song label, Play, Pause, Skip, separator, Open, Exit', () => {
      expect(menuTemplate).not.toBeNull();
      expect(menuTemplate).toHaveLength(7);

      // Item 0: disabled song label
      expect(menuTemplate[0].label).toBe('No track playing');
      expect(menuTemplate[0].enabled).toBe(false);

      // Item 1: Play
      expect(menuTemplate[1].label).toBe('Play');
      expect(typeof menuTemplate[1].click).toBe('function');

      // Item 2: Pause
      expect(menuTemplate[2].label).toBe('Pause');
      expect(typeof menuTemplate[2].click).toBe('function');

      // Item 3: Skip
      expect(menuTemplate[3].label).toBe('Skip');
      expect(typeof menuTemplate[3].click).toBe('function');

      // Item 4: separator
      expect(menuTemplate[4].type).toBe('separator');

      // Item 5: Open
      expect(menuTemplate[5].label).toBe('Open');
      expect(typeof menuTemplate[5].click).toBe('function');

      // Item 6: Exit
      expect(menuTemplate[6].label).toBe('Exit');
      expect(typeof menuTemplate[6].click).toBe('function');
    });
  });

  describe('Menu action handlers', () => {
    it('clicking Play calls onPlay callback', () => {
      menuTemplate[1].click();
      expect(callbacks.onPlay).toHaveBeenCalledTimes(1);
    });

    it('clicking Pause calls onPause callback', () => {
      menuTemplate[2].click();
      expect(callbacks.onPause).toHaveBeenCalledTimes(1);
    });

    it('clicking Skip calls onSkip callback', () => {
      menuTemplate[3].click();
      expect(callbacks.onSkip).toHaveBeenCalledTimes(1);
    });

    it('clicking Open calls onOpen callback', () => {
      menuTemplate[5].click();
      expect(callbacks.onOpen).toHaveBeenCalledTimes(1);
    });

    it('clicking Exit calls onExit callback', () => {
      menuTemplate[6].click();
      expect(callbacks.onExit).toHaveBeenCalledTimes(1);
    });
  });

  describe('Double-click restores window', () => {
    it('double-clicking tray icon calls window.show() and window.focus()', () => {
      const doubleClickCall = trayInstance.on.mock.calls.find(
        (call) => call[0] === 'double-click'
      );
      expect(doubleClickCall).toBeDefined();

      const handler = doubleClickCall[1];
      mockWindow.isMinimized.mockReturnValue(false);
      handler();

      expect(mockWindow.show).toHaveBeenCalledTimes(1);
      expect(mockWindow.focus).toHaveBeenCalledTimes(1);
    });

    it('double-clicking when window is minimized calls window.restore() first', () => {
      const doubleClickCall = trayInstance.on.mock.calls.find(
        (call) => call[0] === 'double-click'
      );
      const handler = doubleClickCall[1];

      mockWindow.isMinimized.mockReturnValue(true);
      handler();

      expect(mockWindow.restore).toHaveBeenCalledTimes(1);
      expect(mockWindow.show).toHaveBeenCalledTimes(1);
      expect(mockWindow.focus).toHaveBeenCalledTimes(1);
    });
  });

  describe('destroy()', () => {
    it('calls tray.destroy()', () => {
      trayManager.destroy();
      expect(trayInstance.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateNowPlaying', () => {
    it('updateNowPlaying(null) sets label to "No track playing"', () => {
      trayManager.updateNowPlaying(null);
      expect(menuTemplate[0].label).toBe('No track playing');
      expect(menuTemplate[0].enabled).toBe(false);
    });
  });
});
