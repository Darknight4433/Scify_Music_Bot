# Implementation Plan: Desktop App Enhancements

## Overview

This plan implements seven major subsystems for the Scify Music Electron desktop app: structured logging, system tray integration, toast notifications, hardware media key support, enhanced Discord Rich Presence, auto-reconnect on network recovery, and bot crash recovery with circuit breaker. Each feature is a separate module that integrates into the existing `desktop/main.js` architecture via the IPC bridge.

## Tasks

- [ ] 1. Create structured logger module and testing infrastructure
  - [ ] 1.1 Create `desktop/logger.js` with `createLogger()` factory
    - Implement `Logger` interface with `info()`, `warn()`, `error()` methods
    - Each log entry prepends ISO 8601 timestamp `[YYYY-MM-DDTHH:mm:ss.sssZ]` and severity `[INFO]`/`[WARN]`/`[ERROR]`
    - Implement `onLogEntry(callback)` for forwarding log entries to the renderer
    - Truncate messages exceeding 4096 characters with `[truncated]` suffix
    - Sanitize newlines to preserve single-line log format
    - _Requirements: 8.1, 8.2_

  - [ ] 1.2 Set up test infrastructure with Vitest and fast-check
    - Add `vitest` and `fast-check` as dev dependencies in `desktop/package.json`
    - Create `desktop/__tests__/` directory structure
    - Add `test` script to `desktop/package.json`
    - _Requirements: N/A (infrastructure)_

  - [ ]* 1.3 Write property tests for logger formatting (Property 1)
    - **Property 1: Log output formatting**
    - Generate random message strings and severity levels; verify output matches `[ISO8601] [LEVEL] message` pattern
    - **Validates: Requirements 8.1, 8.2**

  - [ ]* 1.4 Write property tests for logger severity routing (Property 2)
    - **Property 2: Log routing by severity**
    - Generate random output strings; verify stdout → INFO, stderr → WARN, crash/reconnect events → ERROR with context
    - **Validates: Requirements 8.3, 8.4, 8.5**

- [ ] 2. Implement system tray integration
  - [ ] 2.1 Create `desktop/tray.js` with `createTray()` factory
    - Build context menu with items: current song title (disabled label), Play, Pause, Skip, separator, Open, Exit
    - Implement `updateNowPlaying(title)` to update the first menu item label
    - Handle double-click on tray icon to restore window
    - Wire menu actions to callbacks: onPlay, onPause, onSkip, onOpen, onExit
    - Fall back to default icon if custom icon fails to load
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8_

  - [ ] 2.2 Integrate tray module into `desktop/main.js`
    - Intercept window `close` event to hide window instead of quitting
    - Create tray on app ready with icon from `assets/icon.png`
    - Wire tray Play/Pause/Skip actions to bot API calls (`/resume`, `/pause`, `/skip`)
    - Wire Open action to `mainWindow.show()`
    - Wire Exit action to disconnect bot from VC, then `app.quit()`
    - Update `window-all-closed` handler for tray-aware shutdown
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.8_

  - [ ]* 2.3 Write property test for tray menu song title (Property 3)
    - **Property 3: Tray menu displays current song title**
    - Generate random non-empty title strings; verify first menu item label matches title
    - **Validates: Requirements 2.7**

  - [ ]* 2.4 Write unit tests for tray module
    - Test menu construction has correct items
    - Test menu action handlers call correct callbacks
    - Test Exit disconnects before quit
    - Test double-click restores window
    - _Requirements: 1.1, 1.3, 2.1–2.8_

- [ ] 3. Implement toast notifications
  - [ ] 3.1 Create `desktop/notifications.js` with `showNowPlayingNotification()`
    - Use Electron's `Notification` API to display native Windows toast
    - Include song title and "Playing in Discord VC" text in body
    - Attach click handler to restore and show main window
    - Check `Notification.isSupported()` before showing; skip silently if disabled
    - Do not register click handler if notification was skipped
    - Debounce rapid notifications (minimum 3 seconds between toasts)
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 3.2 Integrate notifications into `desktop/main.js` polling loop
    - Trigger notification on track change detection (new `current.title` differs from previous)
    - Pass `mainWindow.show()` as the `onActivated` callback
    - _Requirements: 3.1, 3.2_

  - [ ]* 3.3 Write property test for notification content (Property 4)
    - **Property 4: Notification content includes song title**
    - Generate random song title strings; verify notification body contains title and "Playing in Discord VC"
    - **Validates: Requirements 3.1**

  - [ ]* 3.4 Write unit tests for notifications module
    - Test click handler restores window
    - Test disabled notifications don't error
    - Test no click handler when notification skipped
    - Test debounce behavior
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 4. Implement hardware media key support
  - [ ] 4.1 Create `desktop/mediaKeys.js` with `registerMediaKeys()` and `unregisterMediaKeys()`
    - Use Electron's `globalShortcut` module to register `MediaPlayPause`, `MediaNextTrack`, `MediaPreviousTrack`
    - Map each key to the corresponding handler callback
    - Log failure and schedule re-attempt on 60s interval if registration fails
    - Unregister all shortcuts on cleanup
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ] 4.2 Integrate media keys into `desktop/main.js`
    - Register media keys on app ready
    - Wire Play/Pause to toggle playback via bot API
    - Wire Next Track to skip command via bot API
    - Wire Previous Track to restart current track via bot API
    - Unregister on app `will-quit` event
    - Re-attempt registration when window is restored from tray
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [ ]* 4.3 Write unit tests for media keys module
    - Test each key maps to correct command
    - Test keys work when app is minimized to tray
    - Test re-registration on failure
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Enhance Discord Rich Presence
  - [ ] 6.1 Refactor `desktop/rpc.js` to support enhanced presence fields
    - Update `updatePresence()` to accept `channelName` and `queueLength` parameters
    - Set activity type to `2` (Listening) for "Listening to Scify Music"
    - Format state field to include voice channel name
    - Conditionally append queue count to state when `queueLength > 0`
    - Hide queue info from state when `queueLength === 0`
    - Keep `startTimestamp` calculation as `Date.now() - positionSec * 1000` for elapsed time display
    - Maintain truncation logic for titles exceeding 128 characters
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ] 6.2 Update polling in `desktop/main.js` to pass new presence data
    - Extract voice channel name from status response and pass to `updatePresence()`
    - Extract queue length from status response and pass to `updatePresence()`
    - _Requirements: 5.4, 5.5, 5.6_

  - [ ]* 6.3 Write property test for Rich Presence details field (Property 5)
    - **Property 5: Rich Presence details field contains title**
    - Generate random title strings (varying lengths); verify details field content and truncation at 128 chars
    - **Validates: Requirements 5.2**

  - [ ]* 6.4 Write property test for Rich Presence elapsed time (Property 6)
    - **Property 6: Rich Presence elapsed time calculation**
    - Generate random non-negative positionSec values; verify startTimestamp = Date.now() - positionSec * 1000 (±100ms tolerance)
    - **Validates: Requirements 5.3**

  - [ ]* 6.5 Write property test for Rich Presence state formatting (Property 7)
    - **Property 7: Rich Presence state field formatting**
    - Generate random channel names + queue lengths; verify state includes channel name and conditionally includes queue count
    - **Validates: Requirements 5.4, 5.5, 5.6**

- [ ] 7. Implement auto-reconnect on network recovery
  - [ ] 7.1 Create `desktop/reconnect.js` with `createReconnectManager()` factory
    - Listen to Electron `net` online/offline events for network state detection
    - Implement exponential backoff: `min(5000 * 2^retryCount, 60000)` delay formula
    - Track retry count, stop after `maxRetries` (default 5) consecutive failures
    - Emit status changes: `'online'` | `'offline'` | `'reconnecting'`
    - Call `onReconnect()` callback on network recovery to restart bot and rejoin VC
    - Implement `start()`, `stop()`, `getStatus()` interface
    - Use logger for all status transitions
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ] 7.2 Integrate reconnect manager into `desktop/main.js`
    - Create reconnect manager on app ready with logger instance
    - Wire `onReconnect` to restart bot + rejoin VC using stored guild/channel settings
    - Wire `onStatusChange` to forward network status to renderer via IPC
    - Add `onNetworkStatus` channel to `desktop/preload.js`
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ]* 7.3 Write property test for exponential backoff calculation (Property 8)
    - **Property 8: Exponential backoff delay calculation**
    - Generate random non-negative retry counts; verify delay = min(5000 * 2^retryCount, 60000)
    - **Validates: Requirements 6.3**

  - [ ]* 7.4 Write unit tests for reconnect module
    - Test offline event triggers reconnecting status
    - Test online event triggers restart + rejoin
    - Test max retries stops loop and shows error
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [ ] 8. Implement bot crash recovery with circuit breaker
  - [ ] 8.1 Create `desktop/recovery.js` with `createRecoveryManager()` factory
    - Track crash timestamps in sliding window array
    - Implement circuit breaker: open if 3+ crashes within 60-second window
    - Schedule restart after 3-second delay on non-zero exit code
    - Skip recovery for exit code 0 (clean shutdown)
    - Call `spawnBot()` callback to restart bot process
    - Emit status changes for renderer updates
    - Use logger for all crash events with exit code context
    - Implement `start()`, `stop()`, `isCircuitOpen()`, `getProcess()` interface
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ] 8.2 Integrate recovery manager into `desktop/main.js`
    - Replace direct `spawnBot()` calls with recovery manager's `start()`
    - Wire recovery status changes to renderer via IPC (`onCrashRecovery` channel)
    - Add `onCrashRecovery` channel to `desktop/preload.js`
    - Configure recovery with stored guild/channel for post-crash VC rejoin
    - Wire bot process `close` event to recovery manager
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ]* 8.3 Write property test for non-zero exit code triggers restart (Property 9)
    - **Property 9: Non-zero exit code triggers restart**
    - Generate random non-zero integers as exit codes; verify restart is scheduled after 3s delay
    - **Validates: Requirements 7.1**

  - [ ]* 8.4 Write property test for circuit breaker (Property 10)
    - **Property 10: Circuit breaker opens on rapid crashes**
    - Generate random crash timestamp sequences; verify circuit opens when 3+ timestamps fall within 60s window
    - **Validates: Requirements 7.3**

  - [ ]* 8.5 Write property test for crash event logging (Property 11)
    - **Property 11: Crash events logged with context**
    - Generate random exit codes and timestamps; verify ERROR log entry includes exit code and valid ISO 8601 timestamp
    - **Validates: Requirements 7.4**

- [ ] 9. Wire logger into bot process stdout/stderr routing
  - [ ] 9.1 Update bot process output handling in `desktop/main.js` to use logger
    - Replace `console.log`/`console.warn` in `spawnBot()` with logger calls
    - Route `stdout` data through `logger.info()`
    - Route `stderr` data through `logger.warn()`
    - Forward log entries to renderer via `bot-log` IPC channel
    - _Requirements: 8.3, 8.4, 8.5_

- [ ] 10. Final checkpoint - Ensure all tests pass and modules are integrated
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- All new modules use ES module syntax (`export`/`import`) to match the existing codebase
- The logger module is created first since all other modules depend on it
- The recovery module takes over bot lifecycle management from main.js

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "2.1", "4.1"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.1", "4.2", "4.3"] },
    { "id": 3, "tasks": ["3.2", "3.3", "3.4", "6.1"] },
    { "id": 4, "tasks": ["6.2", "6.3", "6.4", "6.5", "7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3", "7.4", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "8.4", "8.5"] },
    { "id": 7, "tasks": ["9.1"] }
  ]
}
```
