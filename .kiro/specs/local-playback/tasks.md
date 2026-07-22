# Implementation Plan: Local Playback

## Overview

This plan implements the local audio playback feature for the Scify Music desktop app. The approach builds the pipeline bottom-up: first the main-process audio pipeline (`localAudio.js`), then the renderer audio player wrapper, followed by the playback controller that coordinates both targets, and finally the UI components (mode selector, volume slider, now-playing integration). Each step is wired into the existing architecture incrementally.

## Tasks

- [ ] 1. Create Local Audio Pipeline module in main process
  - [x] 1.1 Create `desktop/localAudio.js` with `createLocalAudioPipeline` factory
    - Implement `play(url, seekSeconds)` that spawns yt-dlp piped to FFmpeg (MP3 128kbps output)
    - Implement `stop()` that kills active yt-dlp and FFmpeg child processes
    - Implement `isActive()` boolean getter
    - Send `local-audio-chunk` IPC events as FFmpeg produces data
    - Send `local-audio-ready` with `{ durationSec }` when pipeline finishes
    - Send `local-audio-error` with `{ message }` on yt-dlp or FFmpeg failure
    - Ensure `play()` calls `stop()` first to kill any prior pipeline processes (Requirement 2.4)
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ] 1.2 Write unit tests for `localAudio.js`
    - Test that `play()` spawns yt-dlp with correct arguments
    - Test that `play()` pipes yt-dlp stdout to FFmpeg stdin
    - Test that `stop()` kills both child processes
    - Test that calling `play()` while active kills prior processes first
    - Test that yt-dlp failure emits `local-audio-error` event
    - Test that FFmpeg failure emits `local-audio-error` event
    - _Requirements: 2.1, 2.2, 2.4, 2.5, 2.6_

  - [ ] 1.3 Write property test for pipeline cleanup
    - **Property 7: Pipeline cleanup on new track**
    - **Validates: Requirements 2.4**

- [ ] 2. Extend preload bridge and main process IPC wiring
  - [ ] 2.1 Add IPC handlers in `desktop/main.js` for local audio
    - Register `local-play` handler that calls `localAudioPipeline.play(url, seekSeconds)`
    - Register `local-stop` handler that calls `localAudioPipeline.stop()`
    - Add `localVolume` (default 80) and `playbackMode` (default 'discord') to Electron Store defaults
    - Ensure pipeline processes are killed on app quit (`before-quit` handler)
    - _Requirements: 1.5, 1.6, 2.1, 4.4_

  - [ ] 2.2 Extend `desktop/preload.js` with local audio IPC bridge
    - Add `localPlay(url, seekSeconds)` → invoke `local-play`
    - Add `localStop()` → invoke `local-stop`
    - Add `onLocalAudioChunk(callback)` → listen for `local-audio-chunk`
    - Add `onLocalAudioReady(callback)` → listen for `local-audio-ready`
    - Add `onLocalAudioError(callback)` → listen for `local-audio-error`
    - _Requirements: 2.3, 3.1_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Create Renderer Audio Player module
  - [ ] 4.1 Create `desktop/renderer/rendererAudio.js` with `RendererAudioPlayer` class
    - Wrap an HTML5 `<audio>` element
    - Implement `loadAndPlay(blobUrl)` — set src and call play()
    - Implement `pause()`, `resume()`, `seek(seconds)`, `stop()`
    - Implement `setVolume(level)` — accepts 0.0–1.0
    - Implement `getPosition()` and `getDuration()` getters
    - Implement `onEnded(callback)`, `onTimeUpdate(callback)`, `onError(callback)` event hooks
    - Revoke previous blob URL on every new `loadAndPlay()` call to prevent memory leaks
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 4.2 Write unit tests for `RendererAudioPlayer`
    - Test that `loadAndPlay` sets audio.src and calls play()
    - Test that `setVolume` clamps and applies correctly
    - Test that `onEnded` callback fires on audio ended event
    - Test that `onTimeUpdate` callback fires on timeupdate event
    - Test that previous blob URL is revoked on new load
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [ ] 4.3 Write property test for volume clamping
    - **Property 3: Volume clamping and application**
    - **Validates: Requirements 4.2, 4.3**

  - [ ] 4.4 Write property test for seek position accuracy
    - **Property 4: Local seek position accuracy**
    - **Validates: Requirements 5.4**

- [ ] 5. Create Playback Controller module
  - [ ] 5.1 Create `desktop/renderer/playbackController.js` with `PlaybackController` class
    - Constructor accepts `{ rendererAudioPlayer, scifyApi, getMode }`
    - Implement `setMode(mode)` — accepts 'discord', 'local', 'both'
    - Implement `play(trackUrl, trackMeta)` — dispatches to correct targets based on mode
    - Implement `pause()` — pauses correct targets based on mode
    - Implement `resume()` — resumes correct targets based on mode
    - Implement `skip()` — skips on correct targets based on mode
    - Implement `seek(seconds)` — seeks on correct targets based on mode
    - Implement `handleLocalTrackEnded()` — triggers auto-advance to next queued track
    - In "Both" mode, dispatch all actions to both Discord API and local player concurrently
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 7.1, 7.2, 7.3, 7.4_

  - [ ] 5.2 Write property test for playback mode routing correctness
    - **Property 1: Playback mode routing correctness**
    - **Validates: Requirements 1.2, 1.3, 1.4**

  - [ ] 5.3 Write property test for dual-target seek dispatch
    - **Property 5: Dual-target seek dispatch**
    - **Validates: Requirements 5.8**

  - [ ] 5.4 Write unit tests for PlaybackController
    - Test `play()` in 'discord' mode only calls bot API, not local pipeline
    - Test `play()` in 'local' mode only calls local pipeline, not bot API
    - Test `play()` in 'both' mode calls both targets
    - Test `pause()` and `resume()` dispatch to correct targets per mode
    - Test `handleLocalTrackEnded()` triggers next track processing
    - Test `handleLocalTrackEnded()` transitions to idle when queue is empty
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6, 7.1, 7.3_

- [ ] 6. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 7. Implement UI: Playback Mode Selector and Volume Controller
  - [ ] 7.1 Add Playback Mode Selector UI to the Now Playing Panel in `desktop/renderer/index.html`
    - Add a three-option toggle/radio group: "Discord VC", "Local", "Both"
    - Style with existing CSS variables for consistency
    - _Requirements: 1.1_

  - [ ] 7.2 Add local volume slider UI to the Now Playing Panel in `desktop/renderer/index.html`
    - Add a slider input (range 0–100) for local volume
    - Show/hide based on playback mode (visible for 'local' and 'both', hidden for 'discord')
    - _Requirements: 4.1, 4.5, 4.6_

  - [ ] 7.3 Wire mode selector and volume slider logic in `desktop/renderer/app.js`
    - On boot, read `playbackMode` and `localVolume` from settings and apply to UI
    - On mode change, persist to Electron Store and update PlaybackController
    - On volume change, persist to Electron Store and update RendererAudioPlayer volume in real time
    - Toggle local volume slider visibility based on selected mode
    - _Requirements: 1.5, 1.6, 4.2, 4.4, 4.5, 4.6_

  - [ ] 7.4 Write property test for settings persistence round-trip
    - **Property 2: Settings persistence round-trip**
    - **Validates: Requirements 1.5, 4.4**

- [ ] 8. Integrate local playback into existing Now Playing Panel and controls
  - [ ] 8.1 Wire audio chunk assembly and playback in renderer
    - Listen for `onLocalAudioChunk` events, accumulate chunks in buffer
    - On `onLocalAudioReady`, create Blob from accumulated chunks, generate blob URL
    - Pass blob URL to `RendererAudioPlayer.loadAndPlay()`
    - On `onLocalAudioError`, show error toast and trigger auto-advance
    - _Requirements: 3.1, 3.4_

  - [ ] 8.2 Update Now Playing Panel to use local playback position in 'local' and 'both' modes
    - When mode is 'local' or 'both', drive progress bar from RendererAudioPlayer time updates
    - When mode is 'discord', keep existing bot API polling for progress
    - Display track title, artist, and thumbnail from track metadata regardless of mode
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ] 8.3 Update existing playback controls (play, pause, skip, seek) to route through PlaybackController
    - Modify `sendControl()` and `apiControl()` in app.js to delegate to PlaybackController
    - Ensure media keys (via main process) also route through the mode-aware controller
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8_

  - [ ] 8.4 Write property test for now-playing metadata completeness
    - **Property 8: Now-playing metadata completeness**
    - **Validates: Requirements 8.1**

- [ ] 9. Implement queue mode-independence and auto-advance
  - [ ] 9.1 Ensure queue operations are mode-independent
    - Verify add/remove track flows work regardless of playback mode
    - On mode switch, preserve current queue contents and position (no restart)
    - _Requirements: 6.1, 6.2, 6.3, 6.4_

  - [ ] 9.2 Wire auto-advance on local track ended
    - When RendererAudioPlayer fires `onEnded`, call PlaybackController.handleLocalTrackEnded()
    - PlaybackController requests next track from queue (bot API or local state)
    - If queue empty, transition to idle state and clear Now Playing Panel
    - In "Both" mode, coordinate advance on both targets
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [ ] 9.3 Write property test for queue mode-independence
    - **Property 6: Queue mode-independence**
    - **Validates: Requirements 6.2, 6.3, 6.4**

- [ ] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project uses Vitest as the test runner and fast-check for property-based tests (both already in devDependencies)
- All code is JavaScript (ES modules in main process, browser globals in renderer)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "2.1", "2.2"] },
    { "id": 2, "tasks": ["4.1"] },
    { "id": 3, "tasks": ["4.2", "4.3", "4.4", "5.1"] },
    { "id": 4, "tasks": ["5.2", "5.3", "5.4", "7.1", "7.2"] },
    { "id": 5, "tasks": ["7.3", "7.4", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "8.4"] },
    { "id": 7, "tasks": ["9.1", "9.2"] },
    { "id": 8, "tasks": ["9.3"] }
  ]
}
```
