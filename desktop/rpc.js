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
const CLIENT_ID = '1284248225097064530'; // Replace with your own Discord app's client ID

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
 * @param {{ title: string, positionSec: number, durationSec: number, paused: boolean }} opts
 */
export async function updatePresence({ title, positionSec, durationSec, paused }) {
  if (!connected) return;

  const now = Date.now();
  const startTimestamp = paused ? undefined : new Date(now - positionSec * 1000);
  const endTimestamp =
    !paused && durationSec > 0
      ? new Date(now + (durationSec - positionSec) * 1000)
      : undefined;

  try {
    await rpc.setActivity({
      details: truncate(title, 128),
      state: paused ? '⏸ Paused' : '▶ Playing in Discord VC',
      largeImageKey: 'scify_logo',
      largeImageText: 'Scify Music',
      smallImageKey: paused ? 'paused' : 'playing',
      smallImageText: paused ? 'Paused' : 'Playing',
      startTimestamp,
      endTimestamp,
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
