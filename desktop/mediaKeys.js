/**
 * mediaKeys.js — Global media key registration for Scify Music.
 *
 * Uses Electron's globalShortcut module to register system-wide media key
 * handlers for Play/Pause, Next Track, and Previous Track. Media keys work
 * even when the app is minimized to the system tray since globalShortcut
 * captures keys at the OS level.
 *
 * If registration fails (e.g., another app holds the shortcut), the module
 * logs the failure and schedules re-attempts every 60 seconds.
 */

import { globalShortcut } from 'electron';

const RETRY_INTERVAL_MS = 60000;

/** @type {ReturnType<typeof setInterval> | null} */
let retryInterval = null;

/** @type {{ onPlayPause: () => void, onNextTrack: () => void, onPreviousTrack: () => void } | null} */
let currentHandlers = null;

/** @type {Set<string>} */
const registeredKeys = new Set();

/**
 * Media key accelerators mapped to their handler names.
 */
const KEY_MAP = [
  { accelerator: 'MediaPlayPause', handler: 'onPlayPause' },
  { accelerator: 'MediaNextTrack', handler: 'onNextTrack' },
  { accelerator: 'MediaPreviousTrack', handler: 'onPreviousTrack' },
];

/**
 * Attempt to register a single media key shortcut.
 * @param {string} accelerator - Electron accelerator string
 * @param {() => void} callback - Handler to call when the key is pressed
 * @returns {boolean} - Whether registration succeeded
 */
function tryRegister(accelerator, callback) {
  const success = globalShortcut.register(accelerator, callback);
  if (success) {
    registeredKeys.add(accelerator);
  }
  return success;
}

/**
 * Attempt to register all media keys that aren't already registered.
 * Returns true if all keys are registered, false if any failed.
 * @returns {boolean}
 */
function attemptRegistration() {
  if (!currentHandlers) return false;

  let allRegistered = true;

  for (const { accelerator, handler } of KEY_MAP) {
    if (registeredKeys.has(accelerator)) {
      continue; // Already registered
    }

    const success = tryRegister(accelerator, currentHandlers[handler]);
    if (!success) {
      console.warn(`[MediaKeys] Failed to register ${accelerator}`);
      allRegistered = false;
    }
  }

  return allRegistered;
}

/**
 * Register global media key shortcuts.
 *
 * Maps:
 * - MediaPlayPause → handlers.onPlayPause()
 * - MediaNextTrack → handlers.onNextTrack()
 * - MediaPreviousTrack → handlers.onPreviousTrack()
 *
 * If any key fails to register, logs the failure and schedules re-attempts
 * every 60 seconds until all keys are registered or unregisterMediaKeys()
 * is called.
 *
 * @param {{ onPlayPause: () => void, onNextTrack: () => void, onPreviousTrack: () => void }} handlers
 */
export function registerMediaKeys(handlers) {
  // Clean up any existing registrations first
  unregisterMediaKeys();

  currentHandlers = handlers;

  const allRegistered = attemptRegistration();

  if (!allRegistered) {
    // Schedule periodic re-attempts for any keys that failed
    retryInterval = setInterval(() => {
      const allNowRegistered = attemptRegistration();
      if (allNowRegistered) {
        // All keys registered — stop retrying
        clearInterval(retryInterval);
        retryInterval = null;
      }
    }, RETRY_INTERVAL_MS);
  }
}

/**
 * Unregister all media key shortcuts and clear any retry intervals.
 * Safe to call even if no keys are currently registered.
 */
export function unregisterMediaKeys() {
  // Clear retry interval
  if (retryInterval !== null) {
    clearInterval(retryInterval);
    retryInterval = null;
  }

  // Unregister all registered shortcuts
  for (const accelerator of registeredKeys) {
    globalShortcut.unregister(accelerator);
  }
  registeredKeys.clear();

  currentHandlers = null;
}
