# Implementation Plan: Playlist Management

## Overview

This plan implements a full playlist management system for the Scify Music desktop app. The work proceeds from backend data layer (store + importers) through the bot API endpoint, then IPC/preload wiring, and finally the renderer UI (views, sort, playback controls). Property-based tests validate correctness properties defined in the design using `fast-check` + Vitest.

## Tasks

- [x] 1. Set up Playlist Store and data layer in main process
  - [x] 1.1 Add playlist IPC handlers and electron-store schema to `desktop/main.js`
    - Add `playlists`, `playlistViewMode`, and `playlistLastSort` keys to the electron-store defaults
    - Implement IPC handlers: `playlist-import-spotify`, `playlist-import-youtube`, `playlist-get-all`, `playlist-get-tracks`, `playlist-remove`, `playlist-get-view-mode`, `playlist-set-view-mode`
    - Implement a `deserializePlaylist(raw)` function that fills in default values for missing/null track fields (empty string for text, 0 for numeric, null for thumbnail)
    - Implement upsert logic: when a playlist with the same ID already exists, replace it rather than duplicating
    - _Requirements: 1.2, 1.4, 2.2, 2.4, 5.5, 9.1, 9.2, 9.3, 9.4_

  - [ ]* 1.2 Write property tests for Playlist Store persistence and serialization
    - **Property 1: Playlist Persistence Completeness** — generate random playlists, store and retrieve, verify all required fields present
    - **Property 2: Playlist Upsert Idempotence** — import same playlist ID twice with different data, verify single entry with latest data
    - **Property 12: Serialization Round-Trip** — generate valid playlist objects, JSON.stringify then JSON.parse, verify deep equality
    - **Property 13: Deserialization Default Values** — generate playlists with randomly nulled/deleted fields, deserialize, verify defaults applied
    - **Validates: Requirements 1.2, 1.4, 2.2, 2.4, 9.1, 9.2, 9.3, 9.4**

- [x] 2. Implement YouTube Importer module
  - [x] 2.1 Create `desktop/youtube.js` module with `fetchYouTubePlaylist(url, apiRequest)` function
    - Accept a YouTube playlist URL and an `apiRequest` function (the same one used in main.js)
    - Call `POST /resolve-playlist` on the bot API with `{ url }`
    - Map the response into the unified `StoredPlaylist` schema: id, name, description, coverUrl, source ('youtube'), sourceUrl, trackCount, tracks array, syncedAt
    - Each track maps: title, artist (from channel), album (''), durationMs (from durationSec * 1000), thumbnail, query (URL or "artist - title"), addedAt
    - Throw descriptive errors for invalid URLs or unavailable playlists
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 2.2 Add `POST /resolve-playlist` endpoint to `src/api.js`
    - Accept `{ url }` in the request body
    - Call the existing `resolveTracks` function from `musicManager.js` with the URL
    - Return `{ playlistId, title, thumbnail, tracks: [{ title, artist, channel, durationSec, url, thumbnail }] }`
    - Return 400 for missing URL, 500 for resolution failures with descriptive error
    - _Requirements: 2.1, 2.3_

- [x] 3. Checkpoint - Ensure store and importers work
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Wire preload API and integrate importers with IPC
  - [x] 4.1 Extend `desktop/preload.js` with new playlist IPC methods
    - Add: `playlistImportSpotify`, `playlistImportYoutube`, `playlistGetAll`, `playlistGetTracks`, `playlistRemove`, `playlistGetViewMode`, `playlistSetViewMode`
    - Each method invokes the corresponding IPC channel registered in task 1.1
    - _Requirements: 1.1, 1.2, 2.1, 2.2, 3.1, 5.5_

  - [x] 4.2 Update Spotify import IPC handler to use unified StoredPlaylist schema
    - Modify the `playlist-import-spotify` handler to call existing `fetchPlaylistTracks()` from `desktop/spotify.js`
    - Normalize the result into the `StoredPlaylist` schema with `source: 'spotify'`, mapping `track.album` to `''` if missing, `track.addedAt` to `syncedAt` timestamp
    - Store in the `playlists` array (not `spotifyPlaylists`) using the upsert logic
    - _Requirements: 1.1, 1.2, 1.4, 1.5_

  - [x] 4.3 Wire YouTube import IPC handler to `desktop/youtube.js`
    - In the `playlist-import-youtube` handler, call `fetchYouTubePlaylist(url, apiRequest)`
    - Store the result in the `playlists` array using upsert logic
    - Return `{ ok: true, playlist }` or `{ ok: false, error }` matching existing patterns
    - _Requirements: 2.1, 2.2, 2.3, 2.4_

- [x] 5. Implement Sort Controller in the renderer
  - [x] 5.1 Create sort logic module in `desktop/renderer/app.js`
    - Implement `sortTracks(tracks, criterion)` as a pure function that returns a new sorted array
    - Support all six criteria: `custom` (by originalIndex), `title` (locale-aware ascending), `artist` (locale-aware ascending), `album` (locale-aware ascending, empty albums at end), `recentlyAdded` (addedAt descending), `duration` (durationMs ascending)
    - Assign `originalIndex` to each track when loaded from store so custom sort can restore import order
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_

  - [ ]* 5.2 Write property tests for Sort Controller
    - **Property 5: Sort Correctness — Alphabetical Fields** — generate random track lists, sort by title/artist, verify each title/artist ≤ next
    - **Property 6: Sort Correctness — Album with Grouping** — generate tracks with/without album, verify non-empty albums before empty, and alphabetical within non-empty
    - **Property 7: Sort Correctness — Recently Added (Descending)** — generate tracks with timestamps, verify each addedAt ≥ next
    - **Property 8: Sort Correctness — Duration (Ascending)** — generate tracks with durations, verify each durationMs ≤ next
    - **Property 9: Sort Preserves Original Order** — generate indexed tracks, verify custom sort restores ascending originalIndex
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.5, 4.6, 4.7**

- [x] 6. Implement View Controller and track rendering
  - [x] 6.1 Create `renderTrackRow(track, index, mode, isPlaying)` function in `desktop/renderer/app.js`
    - **List mode**: Render thumbnail (48×48 img), title, artist, album (when non-empty), duration formatted as mm:ss. Row height ~56px.
    - **Compact mode**: Render title, artist, duration only. No thumbnail. Row height ~36px.
    - Add a playing indicator (highlight class) when `isPlaying` is true
    - Include a "play" button overlay and an "add to queue" button per row
    - _Requirements: 3.2, 5.2, 5.3, 7.2_

  - [ ]* 6.2 Write property tests for View Controller rendering
    - **Property 3: Track Rendering by View Mode** — generate random tracks, render in List mode → verify title/artist/album/duration/thumbnail present; render in Compact mode → verify title/artist/duration present but no thumbnail img element
    - **Property 4: Playlist Header Rendering** — generate playlists with non-null cover, verify header contains coverUrl, name, trackCount, source indicator
    - **Validates: Requirements 3.2, 3.4, 5.2, 5.3**

- [x] 7. Checkpoint - Ensure sort and rendering tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Build the full Playlist UI view in the renderer
  - [x] 8.1 Add playlist navigation, library view, and playlist detail view to `desktop/renderer/app.js`
    - Add a "Playlists" nav item that shows a library of imported playlists (name, cover, track count, source badge)
    - Clicking a playlist opens the detail view with: header (cover, name, count, source), sort dropdown, view mode toggle, "Play All" button, and scrollable track list
    - Implement the sort dropdown that calls `sortTracks()` and re-renders the track list
    - Implement the view mode toggle (Compact/List) that re-renders without re-fetching data
    - Persist sort and view mode preferences via `window.scify.playlistSetViewMode()`
    - _Requirements: 3.1, 3.3, 3.4, 4.1, 4.8, 5.1, 5.4, 5.5_

  - [x] 8.2 Add import playlist dialog to the renderer
    - Add UI for entering a Spotify or YouTube playlist URL
    - Detect source from URL pattern (open.spotify.com → Spotify, youtube.com/playlist → YouTube)
    - Call `window.scify.playlistImportSpotify(url)` or `window.scify.playlistImportYoutube(url)`
    - Show loading state during import, success toast on completion, error toast on failure
    - After successful import, refresh the playlist library view
    - _Requirements: 1.1, 1.3, 2.1, 2.3_

  - [x] 8.3 Add HTML structure and CSS styles for playlist views to `desktop/renderer/index.html` and `desktop/renderer/style.css`
    - Add playlist library view container, playlist detail view container, import dialog markup
    - Style List and Compact track rows, playlist header, sort dropdown, view mode toggle buttons
    - Style playing indicator, action buttons (Play All, queue), and toast notifications
    - Ensure the track list is scrollable (overflow-y: auto) per Requirement 3.3
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 5.2, 5.3_

- [x] 9. Implement Playback Bridge for playlist actions
  - [x] 9.1 Implement `playAll(sortedTracks)`, `playTrack(track)`, and `addToQueue(tracks)` in `desktop/renderer/app.js`
    - `playAll`: Send tracks to bot API in current sort order via `window.scify.api.post('/play', ...)`
    - `playTrack`: Send a single track's query to the bot API for immediate playback
    - `addToQueue`: Append tracks to queue in displayed order
    - Check that `guildId` and `channelId` are configured; show error toast if not
    - Show success toast after queue operations
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1, 8.1, 8.2, 8.3, 8.4_

  - [ ]* 9.2 Write property tests for Playback Bridge ordering
    - **Property 10: Play All Enqueues in Sort Order** — generate playlists, apply a sort, mock API calls, verify call order matches sorted track order
    - **Property 11: Add to Queue Preserves Display Order** — generate track selections, mock API, verify append order matches display order
    - **Validates: Requirements 6.1, 8.1, 8.3**

- [x] 10. Final integration and wiring
  - [x] 10.1 Wire playlist detail view playback controls to Playback Bridge
    - Connect "Play All" button click → `playAll(currentSortedTracks)`
    - Connect track row play button click → `playTrack(track)`
    - Connect track row queue button click → `addToQueue([track])`
    - Connect the currently playing track indicator: compare now-playing status with track queries in the list
    - Handle the "no active session" case: start playback when queue button is clicked with nothing playing
    - _Requirements: 6.1, 6.2, 7.1, 7.2, 7.3, 8.1, 8.2, 8.4_

  - [x] 10.2 Add playlist removal functionality
    - Add a "Remove Playlist" button/option in the playlist detail header
    - Call `window.scify.playlistRemove(id)` and refresh the library view
    - Show confirmation before deletion
    - _Requirements: 1.4, 2.4_

  - [ ]* 10.3 Write unit tests for import flow and error handling
    - Test Spotify import with mocked `fetchPlaylistTracks`: valid URL → stored correctly, invalid URL → error returned
    - Test YouTube import with mocked bot API: valid URL → stored correctly, unavailable playlist → error returned
    - Test upsert: importing same playlist ID twice results in single updated entry
    - _Requirements: 1.3, 1.4, 2.3, 2.4_

- [ ] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The project already has `fast-check` v3.23.2 and Vitest configured — no additional test framework setup needed
- Sort logic is pure in-memory in the renderer (no IPC round-trip) per design decision
- Both Spotify and YouTube playlists share the unified `StoredPlaylist` schema in a single `playlists` array in electron-store

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.2"] },
    { "id": 1, "tasks": ["1.2", "2.1", "4.1"] },
    { "id": 2, "tasks": ["4.2", "4.3", "5.1"] },
    { "id": 3, "tasks": ["5.2", "6.1"] },
    { "id": 4, "tasks": ["6.2", "8.3", "9.1"] },
    { "id": 5, "tasks": ["8.1", "8.2", "9.2"] },
    { "id": 6, "tasks": ["10.1", "10.2"] },
    { "id": 7, "tasks": ["10.3"] }
  ]
}
```
