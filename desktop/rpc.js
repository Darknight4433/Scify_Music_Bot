/**
 * rpc.js — Discord Rich Presence integration.
 *
 * Shows "Listening to X on Scify Music" in the user's Discord profile
 * while a song is playing through the bot.
 *
 * Discord must be running on the same PC for this to work.
 */

import DiscordRPC from 'discord-rpc';

// You can use this public test client ID or register your own app at
// https://discord.com/developers/applications — it's free.
const CLIENT_ID = '1517195164064550993'; // Scify Music bot's application client ID

const rpc = new DiscordRPC.Client({ transport: 'ipc' });
let connected = false;
let connectPromise = null;

export async function connectRPC() {
  if (connected) return;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
    try {
      DiscordRPC.register(CLIENT_ID);
      await rpc.login({ clientId: CLIENT_ID });
      connected = true;
      console.log('[RPC] Connected to Discord');
    } catch (err) {
      connected = false;
      console.warn('[RPC] Failed to connect:', err.message);
      throw err;
    } finally {
      connectPromise = null;
    }
  })();

  return connectPromise;
}

export async function disconnectRPC() {
  if (!connected) return;
  try {
    await rpc.destroy();
    connected = false;
    console.log('[RPC] Disconnected from Discord');
  } catch {
    // Ignore
  }
}

/**
 * Update the user's Discord Rich Presence.
 * @param {{ title: string, positionSec: number, durationSec: number, paused: boolean, channelName?: string, queueLength?: number }} opts
 */
export async function updatePresence({ title, positionSec, durationSec, paused, channelName, queueLength }) {
  if (!connected) return;

  const now = Date.now();
  const startTimestamp = paused ? undefined : new Date(now - positionSec * 1000);

  // Build state field: prefer channel name with optional queue info,
  // fall back to paused/playing text for backward compatibility
  let state;
  if (channelName) {
    if (queueLength != null && queueLength > 0) {
      state = `${channelName} • ${queueLength} in queue`;
    } else {
      state = channelName;
    }
  } else {
    state = paused ? '⏸ Paused' : '🎵 Playing in Discord VC';
  }

  try {
    await rpc.setActivity({
      type: 2, // Listening — coexists with "Playing" activities (Req 5.7)
      details: truncate(title, 128),
      state,
      largeImageKey: 'scify_logo',
      largeImageText: 'Scify Music',
      startTimestamp,
      instance: false,
    });
  } catch (err) {
    console.warn('[RPC] setActivity failed:', err.message);
  }
}

export async function clearPresence() {
  if (!connected) return;
  try {
    await rpc.clearActivity();
  } catch {
    // Ignore
  }
}

function truncate(str, max) {
  if (!str) return 'Unknown';
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}
