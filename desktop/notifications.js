/**
 * notifications.js — Native Windows toast notifications for now-playing events.
 *
 * Displays a toast notification when a new track starts playing.
 * Includes debounce logic (3s minimum between toasts) and graceful
 * degradation when OS notifications are disabled.
 */

import { Notification } from 'electron';

/** Timestamp of the last successfully shown notification */
let lastShownAt = 0;

/** Minimum interval between notifications in milliseconds */
const DEBOUNCE_MS = 3000;

/**
 * Show a native toast notification for the currently playing track.
 *
 * @param {object} options
 * @param {string} options.title - The song title to display
 * @param {function} options.onActivated - Callback invoked when the user clicks the notification
 */
export function showNowPlayingNotification(options) {
  const { title, onActivated } = options;

  // Req 3.3: Skip silently if notifications are not supported/disabled
  if (!Notification.isSupported()) {
    return;
  }

  // Debounce: skip if less than 3 seconds since last notification
  const now = Date.now();
  if (now - lastShownAt < DEBOUNCE_MS) {
    return;
  }

  const notification = new Notification({
    title,
    body: 'Playing in Discord VC',
  });

  // Req 3.2 / 3.4: Only register click handler when notification is actually shown
  notification.on('click', () => {
    onActivated();
  });

  notification.show();
  lastShownAt = now;
}
