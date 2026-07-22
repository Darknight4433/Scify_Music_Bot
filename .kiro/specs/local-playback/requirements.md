# Requirements Document

## Introduction

This document specifies the requirements for adding a **Local Playback** mode to the Scify Music desktop application. Currently, all audio playback is routed exclusively through a Discord voice channel via the bot process. The Local Playback feature enables users to play music directly through their PC speakers using the Electron renderer's HTML5 audio capabilities, either as an alternative to or simultaneously with Discord VC playback.

## Glossary

- **Playback_Mode_Selector**: The UI control that allows the user to choose between Discord VC, Local, or Both playback modes
- **Local_Audio_Pipeline**: The subsystem in the Electron main process that spawns yt-dlp and FFmpeg to produce an audio stream suitable for the renderer's HTML5 audio element
- **Renderer_Audio_Player**: The HTML5 `<audio>` element in the renderer process responsible for outputting audio to the PC speakers
- **Volume_Controller**: The UI slider and underlying logic that controls the local audio output level independently of Discord VC volume
- **Queue_Manager**: The existing queue system (in `musicManager.js`) that manages the ordered list of tracks to play
- **Playback_Controller**: The component that coordinates play, pause, skip, and seek actions across all active playback targets
- **Now_Playing_Panel**: The existing UI panel that displays the currently playing track's metadata, progress, and controls
- **Discord_VC_Player**: The existing bot-side audio player that streams Opus audio to a Discord voice channel
- **Audio_Blob_URL**: A URL created from audio data piped from the main process, used as the source for the Renderer_Audio_Player

## Requirements

### Requirement 1: Playback Mode Selection

**User Story:** As a user, I want to choose how my music is played back, so that I can listen through my PC speakers, Discord voice channel, or both simultaneously.

#### Acceptance Criteria

1. THE Playback_Mode_Selector SHALL provide three options: "Discord VC", "Local", and "Both"
2. WHEN the user selects "Discord VC" mode, THE Playback_Controller SHALL route audio exclusively to the Discord_VC_Player
3. WHEN the user selects "Local" mode, THE Playback_Controller SHALL route audio exclusively to the Renderer_Audio_Player
4. WHEN the user selects "Both" mode, THE Playback_Controller SHALL route audio to the Discord_VC_Player and the Renderer_Audio_Player simultaneously
5. THE Playback_Mode_Selector SHALL persist the selected mode across application restarts using Electron Store
6. WHEN the application starts, THE Playback_Mode_Selector SHALL default to "Discord VC" if no previously saved mode exists

### Requirement 2: Local Audio Pipeline

**User Story:** As a user, I want audio to be processed and delivered to my PC speakers, so that I can hear music locally without relying on a Discord voice channel.

#### Acceptance Criteria

1. WHEN the playback mode includes local output, THE Local_Audio_Pipeline SHALL spawn yt-dlp to fetch the audio stream for the requested track URL
2. WHEN yt-dlp produces audio data, THE Local_Audio_Pipeline SHALL pipe the data through FFmpeg to transcode it into a web-compatible format (e.g., MP3 or WAV)
3. WHEN FFmpeg produces transcoded audio, THE Local_Audio_Pipeline SHALL deliver the audio data to the renderer process via IPC as an Audio_Blob_URL
4. WHEN a new track starts in local mode, THE Local_Audio_Pipeline SHALL terminate any previously running yt-dlp and FFmpeg processes for the prior track
5. IF yt-dlp fails to fetch the audio stream, THEN THE Local_Audio_Pipeline SHALL emit an error event to the renderer with a descriptive message
6. IF FFmpeg fails during transcoding, THEN THE Local_Audio_Pipeline SHALL emit an error event to the renderer with a descriptive message

### Requirement 3: Renderer Audio Playback

**User Story:** As a user, I want my PC speakers to output the music seamlessly, so that I get a native listening experience without Discord.

#### Acceptance Criteria

1. WHEN the Local_Audio_Pipeline delivers an Audio_Blob_URL, THE Renderer_Audio_Player SHALL set the blob URL as its source and begin playback
2. WHEN the Renderer_Audio_Player finishes playing the current track, THE Renderer_Audio_Player SHALL emit a "track-ended" event to trigger queue advancement
3. WHILE audio is playing locally, THE Renderer_Audio_Player SHALL report current playback position to the Now_Playing_Panel at a minimum rate of once per second
4. IF the Renderer_Audio_Player encounters a playback error, THEN THE Renderer_Audio_Player SHALL display an error toast and attempt to advance to the next track in the queue

### Requirement 4: Local Volume Control

**User Story:** As a user, I want to control the local playback volume independently from Discord, so that I can set comfortable levels for each output.

#### Acceptance Criteria

1. THE Volume_Controller SHALL display a slider in the Now_Playing_Panel for local playback volume
2. WHEN the user adjusts the local volume slider, THE Volume_Controller SHALL update the Renderer_Audio_Player volume in real time without interrupting playback
3. THE Volume_Controller SHALL accept values from 0 (muted) to 100 (maximum)
4. THE Volume_Controller SHALL persist the volume level across application restarts using Electron Store
5. WHILE the playback mode is set to "Discord VC" only, THE Volume_Controller SHALL hide the local volume slider
6. WHILE the playback mode is set to "Local" or "Both", THE Volume_Controller SHALL display the local volume slider

### Requirement 5: Unified Playback Controls

**User Story:** As a user, I want play, pause, skip, and seek to work the same way regardless of playback mode, so that I have a consistent experience.

#### Acceptance Criteria

1. WHEN the user triggers play in "Local" mode, THE Playback_Controller SHALL resume the Renderer_Audio_Player
2. WHEN the user triggers pause in "Local" mode, THE Playback_Controller SHALL pause the Renderer_Audio_Player
3. WHEN the user triggers skip in "Local" mode, THE Playback_Controller SHALL stop the current local track and start the next track from the Queue_Manager
4. WHEN the user triggers seek in "Local" mode, THE Playback_Controller SHALL set the Renderer_Audio_Player's playback position to the requested timestamp
5. WHEN the user triggers play in "Both" mode, THE Playback_Controller SHALL resume both the Discord_VC_Player and the Renderer_Audio_Player
6. WHEN the user triggers pause in "Both" mode, THE Playback_Controller SHALL pause both the Discord_VC_Player and the Renderer_Audio_Player
7. WHEN the user triggers skip in "Both" mode, THE Playback_Controller SHALL skip on both the Discord_VC_Player and the Renderer_Audio_Player
8. WHEN the user triggers seek in "Both" mode, THE Playback_Controller SHALL seek on both the Discord_VC_Player and the Renderer_Audio_Player

### Requirement 6: Shared Queue Integration

**User Story:** As a user, I want the same queue to work regardless of playback mode, so that switching modes does not lose my queued tracks.

#### Acceptance Criteria

1. THE Queue_Manager SHALL maintain a single queue of tracks that is shared across all playback modes
2. WHEN the user switches playback mode, THE Queue_Manager SHALL preserve the current queue contents and position
3. WHEN a track is added to the queue, THE Queue_Manager SHALL enqueue the track regardless of the active playback mode
4. WHEN a track is removed from the queue, THE Queue_Manager SHALL remove the track regardless of the active playback mode

### Requirement 7: Auto-Advance on Track End

**User Story:** As a user, I want the next track to play automatically when the current one finishes, so that playback is continuous.

#### Acceptance Criteria

1. WHEN the Renderer_Audio_Player emits a "track-ended" event, THE Playback_Controller SHALL request the next track from the Queue_Manager
2. WHEN the Queue_Manager provides the next track, THE Local_Audio_Pipeline SHALL begin processing the next track for local playback
3. IF the Queue_Manager has no remaining tracks when the current track ends, THEN THE Playback_Controller SHALL transition to an idle state and update the Now_Playing_Panel to show no active track
4. WHEN auto-advance triggers in "Both" mode, THE Playback_Controller SHALL advance both the Discord_VC_Player and the Renderer_Audio_Player to the next track

### Requirement 8: Now Playing Panel Integration

**User Story:** As a user, I want to see the same track information and progress regardless of playback mode, so that the UI remains consistent.

#### Acceptance Criteria

1. WHILE a track is playing in "Local" or "Both" mode, THE Now_Playing_Panel SHALL display the track title, artist, and thumbnail
2. WHILE a track is playing in "Local" mode, THE Now_Playing_Panel SHALL display a progress bar driven by the Renderer_Audio_Player's current position and total duration
3. WHILE a track is playing in "Both" mode, THE Now_Playing_Panel SHALL display a progress bar driven by the Renderer_Audio_Player's current position (local source of truth for UI)
4. WHEN playback mode changes from "Discord VC" to "Local" or "Both" while a track is playing, THE Now_Playing_Panel SHALL continue displaying the current track metadata without interruption
