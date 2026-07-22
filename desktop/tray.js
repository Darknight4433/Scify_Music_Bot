/**
 * tray.js — System tray integration for Scify Music desktop app.
 *
 * Provides a createTray() factory that creates a system tray icon with
 * a context menu for playback control, window management, and now-playing
 * display. Supports double-click to restore window and dynamic menu
 * updates for the current song title.
 */

import { Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Load a tray icon from the given path, falling back to an empty default
 * icon if the custom icon fails to load.
 *
 * @param {string} iconPath - Absolute path to the icon file
 * @returns {Electron.NativeImage}
 */
function loadIcon(iconPath) {
  try {
    const image = nativeImage.createFromPath(iconPath);
    if (image.isEmpty()) {
      console.warn('[Tray] Custom icon is empty, using default icon');
      return nativeImage.createEmpty();
    }
    return image;
  } catch (err) {
    console.warn('[Tray] Failed to load icon, using default:', err.message);
    return nativeImage.createEmpty();
  }
}

/**
 * Build the context menu template with the current song title and action handlers.
 *
 * @param {string} songLabel - The current song title or fallback text
 * @param {object} callbacks - Menu action callbacks
 * @param {() => void} callbacks.onPlay
 * @param {() => void} callbacks.onPause
 * @param {() => void} callbacks.onSkip
 * @param {() => void} callbacks.onOpen
 * @param {() => void} callbacks.onExit
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
function buildMenuTemplate(songLabel, callbacks) {
  return [
    { label: songLabel, enabled: false },
    { label: 'Play', click: () => callbacks.onPlay() },
    { label: 'Pause', click: () => callbacks.onPause() },
    { label: 'Skip', click: () => callbacks.onSkip() },
    { type: 'separator' },
    { label: 'Open', click: () => callbacks.onOpen() },
    { label: 'Exit', click: () => callbacks.onExit() },
  ];
}

/**
 * Create a system tray icon with context menu and window management.
 *
 * @param {object} options
 * @param {string} options.iconPath - Path to the tray icon image
 * @param {Electron.BrowserWindow} options.window - The main BrowserWindow instance
 * @param {() => void} options.onPlay - Called when Play menu item is clicked
 * @param {() => void} options.onPause - Called when Pause menu item is clicked
 * @param {() => void} options.onSkip - Called when Skip menu item is clicked
 * @param {() => void} options.onOpen - Called when Open menu item is clicked
 * @param {() => void} options.onExit - Called when Exit menu item is clicked
 * @returns {{ updateNowPlaying: (title: string | null) => void, destroy: () => void }}
 */
export function createTray(options) {
  const { iconPath, window: mainWindow, onPlay, onPause, onSkip, onOpen, onExit } = options;

  const icon = loadIcon(iconPath);
  const tray = new Tray(icon);

  let currentSongLabel = 'No track playing';

  const callbacks = { onPlay, onPause, onSkip, onOpen, onExit };

  /**
   * Rebuild and apply the context menu with the current song label.
   */
  function rebuildMenu() {
    const template = buildMenuTemplate(currentSongLabel, callbacks);
    const contextMenu = Menu.buildFromTemplate(template);
    tray.setContextMenu(contextMenu);
  }

  // Set initial tooltip and context menu
  tray.setToolTip('Scify Music');
  rebuildMenu();

  // Double-click on tray icon restores and shows the main window
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });

  return {
    /**
     * Update the now-playing song title displayed in the tray context menu.
     * When title is null, shows "No track playing".
     *
     * @param {string | null} title - The current song title, or null if nothing is playing
     */
    updateNowPlaying(title) {
      currentSongLabel = title || 'No track playing';
      rebuildMenu();
    },

    /**
     * Destroy the tray icon and clean up resources.
     */
    destroy() {
      tray.destroy();
    },
  };
}
