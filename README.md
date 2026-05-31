# Discord Music Bot

A Node.js Discord bot that plays audio from YouTube / YouTube Music links (or search terms) in a voice channel, with personal interactive control panels, role-gated access, and a priority lock.

## Features

- **`/play <link or search>`** — queue and play from a YouTube / YouTube Music link or a search term.
- **`/controls`** — open your own control panel with buttons: play/pause, skip, ⏪ -15s, ⏩ +15s, ⏹️ stop, ⏱️ seek-to (exact position via a popup), and 🔄 refresh.
- **Per-user panels** — every panel is an *ephemeral* message, so only the person who opened it can see it.
- **Live progress bar** — the panel shows the current position, a seek bar, and total duration (press 🔄 to refresh it).
- **Role-gated access** — only members with `ACCESS_ROLE_ID` can use the bot at all.
- **Priority lock** — when a member with `PRIORITY_ROLE_ID` plays music, everyone else is blocked from controlling playback until that member presses **Stop** or leaves the voice channel. Then controls open up again automatically.

## "Skipping ads"

This bot does not need an ad blocker. It uses [`play-dl`](https://github.com/play-dl/play-dl) to extract the clean audio stream directly from YouTube's media endpoints, so the audio it plays does not contain video ads. There is no in-stream ad to skip.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create your `.env` file (copy from the example) and fill in the values:
   ```bash
   cp .env.example .env
   ```
   - `DISCORD_TOKEN` — your bot token.
   - `ACCESS_ROLE_ID` — role allowed to use the bot.
   - `PRIORITY_ROLE_ID` — role that gets exclusive control while playing.

3. In the [Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot**:
   - Enable the **Server Members Intent** (required to check member roles).
   - Invite the bot with the `bot` and `applications.commands` scopes and the
     **Connect** + **Speak** + **Send Messages** permissions.

4. Run the bot:
   ```bash
   npm start
   ```
   Slash commands register automatically in every server the bot is in.

## How the priority lock works

1. A member with the priority role runs `/play`. They become the **lock holder**.
2. While the lock is held, anyone else who tries to `/play` or use a control button gets a notice and is blocked.
3. The lock releases when the holder presses **Stop**, the queue finishes, or the holder leaves the voice channel.

## Security note

**Never share or commit your bot token.** If your token is ever exposed, reset it
in the Developer Portal (Bot → Reset Token). The `.gitignore` keeps your `.env`
out of version control.

## Notes

- Uses `opusscript` (pure JavaScript) for Opus encoding, so no C++ build tools are required.
- `ffmpeg-static` provides the bundled FFmpeg binary, so you don't need a system FFmpeg install.
- Seeking re-streams the track from the requested position using `play-dl`'s `seek` option.
