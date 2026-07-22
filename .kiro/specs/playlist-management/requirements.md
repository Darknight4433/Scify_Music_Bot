# Requirements Document

## Introduction

This feature adds a full playlist management experience to the Scify Music desktop app, inspired by Spotify's playlist view. Users can import complete playlists from Spotify and YouTube into the app's local library, browse all tracks within a playlist with rich metadata, sort and view tracks using multiple options, and initiate playback of entire playlists or individual songs directly from the playlist view. The feature integrates with the existing Electron IPC architecture, the Spotify scraper (`desktop/spotify.js`), and the music bot's REST bridge (`src/api.js`).

## Glossary

- **Playlist_Manager**: The module responsible for storing, retrieving, sorting, and rendering playlist data in the desktop app.
- **Spotify_Importer**: The existing scraper module (`desktop/spotify.js`) that fetches public Spotify playlist tracks using embed scraping or anonymous token API.
- **YouTube_Importer**: A new module that fetches YouTube playlist tracks via the bot's `resolveTracks` function using yt-dlp.
- **Track**: A single song entry containing title, artist, album, duration, and thumbnail metadata.
- **Playlist_Store**: The persistent storage layer (electron-store) that holds imported playlists and their track lists.
- **Renderer**: The vanilla JS frontend (`desktop/renderer/app.js`) that displays UI in the Electron BrowserWindow.
- **Sort_Controller**: The component that applies sorting logic to a playlist's track list based on user-selected criteria.
- **View_Controller**: The component that switches between Compact and List display modes for playlist tracks.
- **Playback_Bridge**: The REST API bridge (`src/api.js`) that relays play and queue commands to the music bot.

## Requirements

### Requirement 1: Import Spotify Playlists

**User Story:** As a user, I want to import a full Spotify playlist into the app's library, so that I can browse and play all tracks without needing Spotify open.

#### Acceptance Criteria

1. WHEN a valid Spotify playlist URL is provided, THE Spotify_Importer SHALL fetch all tracks and return each Track with title, artist, album name, duration in milliseconds, and thumbnail URL.
2. WHEN the Spotify_Importer successfully fetches a playlist, THE Playlist_Store SHALL persist the playlist with a unique identifier, playlist name, cover URL, track count, track list, source URL, and sync timestamp.
3. IF the Spotify playlist URL is invalid or the playlist is private, THEN THE Spotify_Importer SHALL return a descriptive error message indicating the failure reason.
4. WHEN a previously imported Spotify playlist is re-imported, THE Playlist_Store SHALL update the existing entry rather than creating a duplicate.
5. WHEN a Spotify playlist contains more than 100 tracks, THE Spotify_Importer SHALL paginate through all pages and return the complete track list.

### Requirement 2: Import YouTube Playlists

**User Story:** As a user, I want to import a full YouTube playlist into the app's library, so that I can access YouTube playlist content alongside my Spotify playlists.

#### Acceptance Criteria

1. WHEN a valid YouTube playlist URL is provided, THE YouTube_Importer SHALL resolve all tracks and return each Track with title, artist (channel name), duration in seconds, and thumbnail URL.
2. WHEN the YouTube_Importer successfully fetches a playlist, THE Playlist_Store SHALL persist the playlist with a unique identifier, playlist name, track count, track list, source URL, and sync timestamp.
3. IF the YouTube playlist URL is invalid or the playlist is unavailable, THEN THE YouTube_Importer SHALL return a descriptive error message indicating the failure reason.
4. WHEN a previously imported YouTube playlist is re-imported, THE Playlist_Store SHALL update the existing entry rather than creating a duplicate.

### Requirement 3: View All Tracks in a Playlist

**User Story:** As a user, I want to see all songs in a playlist as a scrollable list, so that I can browse and pick tracks to play.

#### Acceptance Criteria

1. WHEN a user selects a playlist from the playlist library, THE Renderer SHALL display all tracks in a vertically scrollable list.
2. THE Renderer SHALL display each Track with its title, artist, album name (when available), duration formatted as mm:ss, and thumbnail image.
3. WHEN a playlist contains more tracks than fit in the viewport, THE Renderer SHALL allow scrolling through the entire track list without pagination.
4. WHEN a playlist has a cover image, THE Renderer SHALL display the playlist cover, name, track count, and source indicator (Spotify or YouTube) in a header section above the track list.

### Requirement 4: Sort Playlist Tracks

**User Story:** As a user, I want to sort the tracks in a playlist by different criteria, so that I can organize the view to match my browsing preference.

#### Acceptance Criteria

1. THE Sort_Controller SHALL provide the following sort options: Custom Order, Title, Artist, Album, Recently Added, and Duration.
2. WHEN the user selects "Custom Order", THE Sort_Controller SHALL display tracks in their original import order from the source playlist.
3. WHEN the user selects "Title", THE Sort_Controller SHALL sort tracks alphabetically by title in ascending order.
4. WHEN the user selects "Artist", THE Sort_Controller SHALL sort tracks alphabetically by artist name in ascending order.
5. WHEN the user selects "Album", THE Sort_Controller SHALL sort tracks alphabetically by album name in ascending order, grouping tracks without an album at the end.
6. WHEN the user selects "Recently Added", THE Sort_Controller SHALL sort tracks by their sync timestamp in descending order (newest first).
7. WHEN the user selects "Duration", THE Sort_Controller SHALL sort tracks by duration in ascending order (shortest first).
8. WHEN a sort option is selected, THE Renderer SHALL display the active sort option in the sort dropdown as the currently selected value.

### Requirement 5: View Modes (Compact and List)

**User Story:** As a user, I want to toggle between Compact and List view modes, so that I can see more tracks at once or see more detail per track.

#### Acceptance Criteria

1. THE View_Controller SHALL provide two view modes: Compact and List.
2. WHEN the user selects "List" view mode, THE Renderer SHALL display each Track with thumbnail, title, artist, album, and duration in a standard row height.
3. WHEN the user selects "Compact" view mode, THE Renderer SHALL display each Track with title, artist, and duration in a reduced row height without thumbnail images.
4. WHEN the user switches view mode, THE Renderer SHALL re-render the track list immediately without re-fetching data from the Playlist_Store.
5. THE Playlist_Store SHALL persist the user's last selected view mode across app restarts.

### Requirement 6: Play All Tracks from Playlist

**User Story:** As a user, I want to play all songs in a playlist starting from the first track, so that I can listen to the entire playlist hands-free.

#### Acceptance Criteria

1. WHEN the user activates "Play All", THE Playback_Bridge SHALL send all tracks in the playlist to the bot's queue in the currently active sort order.
2. WHEN the user activates "Play All", THE Playback_Bridge SHALL begin playback of the first track immediately.
3. IF no voice channel is connected, THEN THE Playback_Bridge SHALL auto-connect to the configured voice channel before starting playback.
4. IF the configured guild or channel is unavailable, THEN THE Renderer SHALL display an error message instructing the user to configure a server in Settings.

### Requirement 7: Play Individual Track from Playlist

**User Story:** As a user, I want to click any track in the playlist to start playing it immediately, so that I can jump to a specific song.

#### Acceptance Criteria

1. WHEN the user clicks a track in the playlist view, THE Playback_Bridge SHALL send a play command for that specific track to the music bot.
2. WHEN an individual track starts playing, THE Renderer SHALL visually indicate the currently playing track in the playlist list with a highlight or playing indicator.
3. WHEN the individual track finishes, THE Playback_Bridge SHALL continue playback with the next track in the playlist according to the active sort order.

### Requirement 8: Add to Queue from Playlist View

**User Story:** As a user, I want to add a track from the playlist to the current playback queue without interrupting what is currently playing, so that I can build up my listening session.

#### Acceptance Criteria

1. WHEN the user triggers "Add to Queue" on a track, THE Playback_Bridge SHALL append that track to the end of the bot's current playback queue.
2. WHEN a track is successfully added to the queue, THE Renderer SHALL display a confirmation toast notification.
3. WHEN multiple tracks are selected and "Add to Queue" is triggered, THE Playback_Bridge SHALL append all selected tracks to the queue in their displayed order.
4. IF no active playback session exists, THEN THE Playback_Bridge SHALL start a new session and begin playing the queued track immediately.

### Requirement 9: Playlist Data Serialization

**User Story:** As a developer, I want playlist data to be reliably serialized and deserialized from storage, so that no track metadata is lost between app sessions.

#### Acceptance Criteria

1. THE Playlist_Store SHALL serialize playlist data to JSON format for persistence in electron-store.
2. THE Playlist_Store SHALL deserialize stored JSON back into playlist objects with all Track metadata intact.
3. FOR ALL valid playlist objects, serializing then deserializing SHALL produce an equivalent object (round-trip property).
4. WHEN a stored playlist contains fields with missing or null values, THE Playlist_Store SHALL provide default values (empty string for text fields, 0 for numeric fields, null for optional URLs) during deserialization.
