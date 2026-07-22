# Requirements Document

## Introduction

This document specifies the requirements for enhancing the Scify Music Electron desktop application with Windows system integration (system tray, notifications, media keys), improved Discord Rich Presence, and smart reliability features (auto-reconnect, crash recovery, structured logging). These enhancements aim to make the app feel native on Windows, provide richer Discord activity information, and improve resilience to network and process failures.

## Glossary

- **Desktop_App**: The Scify Music Electron application (main process in `desktop/main.js`) that controls the Discord music bot
- **System_Tray**: The Windows notification area (taskbar tray) where applications can place persistent icons with context menus
- **Tray_Menu**: The right-click context menu displayed when the user interacts with the System_Tray icon
- **Toast_Notification**: A native Windows notification banner that appears briefly in the bottom-right corner of the screen
- **Media_Keys**: Hardware or software keyboard keys for Play/Pause, Next Track, and Previous Track media control
- **Rich_Presence**: The Discord Rich Presence activity display shown on the user's Discord profile
- **Bot_Process**: The child Node.js process (`bot.js`) spawned by the Desktop_App that connects to Discord and plays music
- **Voice_Channel**: The Discord voice channel the Bot_Process is connected to for audio playback
- **Queue**: The ordered list of tracks waiting to be played by the Bot_Process
- **Logger**: The structured logging module that prepends timestamps and severity levels to console output

## Requirements

### Requirement 1: System Tray Minimize-to-Tray

**User Story:** As a user, I want the app to minimize to the system tray when I click the close button, so that I can keep music playing without the window taking up taskbar space.

#### Acceptance Criteria

1. WHEN the user clicks the window close button, THE Desktop_App SHALL hide the window, display an icon in the System_Tray, and ensure the Bot_Process is running, instead of quitting the application
2. WHILE the Desktop_App is minimized to the System_Tray, THE Bot_Process SHALL continue running and playing music without interruption
3. WHEN the user double-clicks the System_Tray icon, THE Desktop_App SHALL restore and show the main window

### Requirement 2: System Tray Context Menu

**User Story:** As a user, I want a right-click menu on the tray icon, so that I can control playback and access the app without restoring the window.

#### Acceptance Criteria

1. WHEN the user right-clicks the System_Tray icon, THE Desktop_App SHALL display a Tray_Menu with the following items: current song title (disabled/label), Play, Pause, Skip, a separator, Open (show window), and Exit (quit application)
2. WHEN the user selects "Play" from the Tray_Menu, THE Desktop_App SHALL send a resume command to the Bot_Process
3. WHEN the user selects "Pause" from the Tray_Menu, THE Desktop_App SHALL send a pause command to the Bot_Process
4. WHEN the user selects "Skip" from the Tray_Menu, THE Desktop_App SHALL send a skip command to the Bot_Process to advance to the next track in the Queue
5. WHEN the user selects "Open" from the Tray_Menu, THE Desktop_App SHALL restore and show the main window
6. WHEN the user selects "Exit" from the Tray_Menu, THE Desktop_App SHALL disconnect the Bot_Process from the Voice_Channel, wait for disconnection to complete, and then terminate the application
7. WHILE a track is playing, THE Tray_Menu SHALL display the current song title as the first menu item
8. WHEN the application terminates through any shutdown scenario, THE Desktop_App SHALL ensure the Bot_Process is disconnected from the Voice_Channel before process exit

### Requirement 3: Now Playing Toast Notifications

**User Story:** As a user, I want to see a notification when a new song starts playing, so that I know what track is currently playing without opening the app.

#### Acceptance Criteria

1. WHEN a new track begins playing, THE Desktop_App SHALL display a Toast_Notification containing the song title and the text "Playing in Discord VC"
2. WHEN the user clicks the Toast_Notification AND the notification was successfully displayed, THE Desktop_App SHALL restore and show the main window
3. IF the operating system has OS-wide notifications disabled, THEN THE Desktop_App SHALL skip showing the Toast_Notification without producing an error
4. IF the Toast_Notification was skipped due to disabled OS notifications, THEN THE Desktop_App SHALL NOT restore the main window in response to notification click events

### Requirement 4: Hardware Media Key Support

**User Story:** As a user, I want to control playback with my keyboard's media keys, so that I can pause, resume, and skip tracks without switching to the app.

#### Acceptance Criteria

1. WHEN the user presses the Play/Pause media key, THE Desktop_App SHALL toggle playback between paused and playing states on the Bot_Process
2. WHEN the user presses the Next Track media key, THE Desktop_App SHALL send a skip command to the Bot_Process to advance to the next track in the Queue
3. WHEN the user presses the Previous Track media key, THE Desktop_App SHALL restart the current track from the beginning
4. WHILE the Desktop_App is minimized to the System_Tray, THE Media_Keys SHALL continue to function and control playback
5. IF the media key registration fails while the Desktop_App is minimized, THEN THE Desktop_App SHALL log the failure and re-attempt registration when the app is next restored or on a periodic interval

### Requirement 5: Enhanced Rich Presence Display

**User Story:** As a user, I want my Discord status to show detailed listening activity, so that my friends can see what I'm listening to with progress and queue information.

#### Acceptance Criteria

1. WHILE a track is playing, THE Rich_Presence SHALL display the activity type as "Listening to" with the application name "Scify Music"
2. WHILE a track is playing, THE Rich_Presence SHALL display the song title in the details field
3. WHILE a track is playing, THE Rich_Presence SHALL display elapsed time using Discord timestamps to show a live progress counter
4. WHILE a track is playing, THE Rich_Presence SHALL display the Voice_Channel name in the state field
5. WHILE a track is playing AND the Queue contains additional tracks with a valid positive count, THE Rich_Presence SHALL include the number of remaining tracks in the Queue as part of the state text
6. WHILE a track is playing AND the Queue contains no additional tracks beyond the current one, THE Rich_Presence SHALL hide queue information entirely from the state text
7. WHILE the Desktop_App activity type is set to "Listening to", THE Rich_Presence SHALL coexist with other applications using "Playing" activity type without replacing them

### Requirement 6: Auto-Reconnect on Network Recovery

**User Story:** As a user, I want the bot to automatically reconnect when my internet comes back, so that I don't have to manually restart playback after a network interruption.

#### Acceptance Criteria

1. WHEN the Desktop_App detects that the network connection has been lost, THE Desktop_App SHALL set the bot status to "reconnecting" and inform the user via the renderer
2. WHEN the network connection is restored after a disconnection, THE Desktop_App SHALL automatically restart the Bot_Process and re-join the previously configured Voice_Channel; IF the Bot_Process restart fails, THEN THE Desktop_App SHALL NOT attempt to rejoin the Voice_Channel
3. WHILE the Desktop_App is attempting to reconnect, THE Desktop_App SHALL retry the connection with exponential backoff starting at 5 seconds and capping at 60 seconds
4. IF the Bot_Process fails to reconnect after 5 consecutive retry attempts, THEN THE Desktop_App SHALL stop retrying and display an error status to the user

### Requirement 7: Bot Crash Recovery

**User Story:** As a user, I want the bot to automatically restart if it crashes, so that my music playback resumes without manual intervention.

#### Acceptance Criteria

1. WHEN the Bot_Process exits with a non-zero exit code, THE Desktop_App SHALL automatically restart the Bot_Process after a 3-second delay
2. WHEN the Bot_Process is restarted after a crash, THE Desktop_App SHALL re-join the previously configured Voice_Channel using the stored guild and channel settings
3. IF the Bot_Process crashes 3 times within a 60-second window, THEN THE Desktop_App SHALL immediately stop attempting restarts and display an error message indicating repeated failures without attempting a further restart
4. WHEN crash recovery is triggered, THE Desktop_App SHALL log the crash event with the exit code and timestamp using the Logger

### Requirement 8: Structured Timestamped Logging

**User Story:** As a user, I want console logs to have timestamps and severity levels, so that I can diagnose issues more easily when reviewing the log output.

#### Acceptance Criteria

1. THE Logger SHALL prepend each log message with an ISO 8601 timestamp in the format `[YYYY-MM-DDTHH:mm:ss.sssZ]`
2. THE Logger SHALL prepend each log message with a severity level tag of one of: `[INFO]`, `[WARN]`, `[ERROR]`
3. WHEN the Bot_Process emits actual stdout output, THE Desktop_App SHALL forward the output to both the renderer console panel and the Logger with `[INFO]` severity
4. WHEN the Bot_Process emits stderr output, THE Desktop_App SHALL forward the output to both the renderer console panel and the Logger with `[WARN]` severity
5. WHEN a crash recovery or reconnect event occurs, THE Logger SHALL record the event with `[ERROR]` severity including relevant context such as exit codes or retry counts; this logging SHALL occur independently of whether the Bot_Process produces stdout output
