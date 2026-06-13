import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  Events,
  MessageFlags,
  SlashCommandBuilder,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { MusicManager, resolveTracks } from './musicManager.js';
import { buildPanelEmbed, buildPanelComponents, buildQueueView, buildLibraryView, buildUserLibraryView, formatTime } from './ui.js';
import { store } from './store.js';

const TOKEN = process.env.DISCORD_TOKEN;
const ACCESS_ROLE_ID = process.env.ACCESS_ROLE_ID;
const PRIORITY_ROLE_ID = process.env.PRIORITY_ROLE_ID;

if (!TOKEN || TOKEN === 'your-bot-token-here') {
  console.error('Missing DISCORD_TOKEN. Set it in your .env file.');
  process.exit(1);
}
if (!ACCESS_ROLE_ID) console.warn('ACCESS_ROLE_ID is not set — everyone will be allowed to use the bot.');
if (!PRIORITY_ROLE_ID) console.warn('PRIORITY_ROLE_ID is not set — the priority lock is disabled.');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
  ],
});

const music = new MusicManager();

// ---------- Permission helpers ----------

function hasAccess(member) {
  // Server owner always has access.
  if (member.id === member.guild.ownerId) return true;
  if (!ACCESS_ROLE_ID) return true;
  return member.roles.cache.has(ACCESS_ROLE_ID);
}

function isPriority(member) {
  if (!PRIORITY_ROLE_ID) return false;
  return member.roles.cache.has(PRIORITY_ROLE_ID);
}

/**
 * Decide whether `member` is allowed to control playback right now.
 * Returns { allowed, reason }.
 */
function canControl(state, member) {
  if (!hasAccess(member)) {
    return { allowed: false, reason: 'You do not have the role required to use this bot.' };
  }
  // No state yet -> nothing locked.
  if (!state || !state.starterUser) return { allowed: true };
  // Server owner can always control.
  if (member.id === member.guild.ownerId) return { allowed: true };
  // The person who started playback can control.
  if (state.starterUser.id === member.id) return { allowed: true };
  // Anyone else has to wait.
  return {
    allowed: false,
    reason: `🎵 **${state.starterUser.username}** is currently in control. You can play once their session ends.`,
  };
}

// ---------- Slash command definitions ----------

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Play a song or queue multiple (comma-separated)')
    .addStringOption((o) =>
      o.setName('query').setDescription('Song name, URL, or multiple separated by commas').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('queue')
    .setDescription('See what\'s playing and what\'s coming up next')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('library')
    .setDescription('Show your music library (resume or replay)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('controls')
    .setDescription('Open your personal music control panel')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('lib')
    .setDescription('View your personal playlist and play it')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('libadd')
    .setDescription('Add songs to your personal library (comma-separated)')
    .addStringOption((o) =>
      o.setName('songs').setDescription('Song name, URL, or multiple separated by commas').setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('libremove')
    .setDescription('Remove a song from your personal library by its number')
    .addIntegerOption((o) =>
      o.setName('number').setDescription('Song number in your library to remove').setRequired(true),
    )
    .toJSON(),
];

async function registerCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
}

// ---------- Ready ----------

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  // Register guild commands for every guild the bot is in (instant availability).
  for (const [, guild] of c.guilds.cache) {
    try {
      await registerCommands(guild.id);
      console.log(`Registered commands in ${guild.name}`);
    } catch (err) {
      console.error(`Failed to register commands in ${guild.id}:`, err.message);
    }
  }
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await registerCommands(guild.id);
  } catch (err) {
    console.error('Failed to register commands on join:', err.message);
  }
});

// ---------- Panel rendering for a specific viewer ----------

function renderPanelFor(state, viewer) {
  const isController = !state?.starterUser || state.starterUser.id === viewer.id || viewer.id === viewer.guild.ownerId;
  const controllerTag = state?.starterUser?.username;

  return {
    embeds: [buildPanelEmbed(state, { locked: !isController, lockHolderTag: controllerTag })],
    components: buildPanelComponents({
      paused: state ? state.isPaused() : false,
      disabled: !isController || !state?.current,
      loopMode: state?.loopMode ?? 'off',
    }),
  };
}

// ---------- Queue list view for a specific viewer ----------

function renderQueueFor(state, viewer) {
  const isController = !state?.starterUser || state.starterUser.id === viewer.id || viewer.id === viewer.guild.ownerId;
  return buildQueueView(state, { disabled: !isController });
}

// ---------- Interaction handling ----------

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      await handleSlash(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (err) {
    console.error('Interaction error:', err);
    const payload = { content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) {
      interaction.followUp(payload).catch(() => {});
    } else {
      interaction.reply(payload).catch(() => {});
    }
  }
});

async function handleSlash(interaction) {
  const member = interaction.member;

  if (!hasAccess(member)) {
    return interaction.reply({
      content: 'You do not have the role required to use this bot.',
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === 'library') {
    const session = store.getSession(interaction.guild.id);
    const history = store.getHistory(interaction.guild.id);
    return interaction.reply({
      ...buildLibraryView(session, history),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === 'lib') {
    const userLib = store.getUserLibrary(interaction.guild.id, member.id);
    return interaction.reply({
      ...buildUserLibraryView(userLib, member.user.username),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === 'libadd') {
    const songs = interaction.options.getString('songs', true);
    if (songs.length > 500) {
      return interaction.reply({
        content: 'Query is too long. Keep it under 500 characters.',
        flags: MessageFlags.Ephemeral,
      });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const { tracks, label } = await resolveTracks(songs, member.user.username);
      store.addToUserLibrary(interaction.guild.id, member.id, tracks);
      await interaction.editReply({
        content: `✅ Added to your library: **${label}**\nYou now have **${store.getUserLibrary(interaction.guild.id, member.id).length}** song(s) in your library.`,
      });
    } catch (err) {
      await interaction.editReply({ content: `⚠️ ${err.message}` });
    }
    return;
  }

  if (interaction.commandName === 'libremove') {
    const num = interaction.options.getInteger('number', true);
    const removed = store.removeFromUserLibrary(interaction.guild.id, member.id, num - 1);
    if (!removed) {
      return interaction.reply({
        content: `Invalid number. Use \`/lib\` to see your library.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    return interaction.reply({
      content: `🗑️ Removed **${removed.title}** from your library.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === 'controls') {
    const state = music.peek(interaction.guild.id);
    return interaction.reply({
      ...renderPanelFor(state, member),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === 'queue') {
    const state = music.peek(interaction.guild.id);
    return interaction.reply({
      ...renderQueueFor(state, member),
      flags: MessageFlags.Ephemeral,
    });
  }

  if (interaction.commandName === 'play') {
    const query = interaction.options.getString('query', true);

    // Validate the query: reject excessively long or suspicious input.
    if (query.length > 500) {
      return interaction.reply({
        content: 'Query is too long. Keep it under 500 characters.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const voiceChannel = member.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: 'You need to be in a voice channel first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const state = music.get(interaction.guild.id);

    // Anyone can add to the queue — but only the first person (or when nothing
    // is playing) becomes the controller.
    const isAlreadyPlaying = state.playing;

    // Acknowledge immediately so we never hit the 3s interaction deadline,
    // since resolving the track can take a moment.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    if (!isAlreadyPlaying) {
      state.textChannel = interaction.channel;
      state.starterUser = member.user;
    }
    if (!state.connection || state.voiceChannelId !== voiceChannel.id) {
      state.textChannel = interaction.channel;
      state.connect(voiceChannel);
    }

    const { tracks, label } = await resolveTracks(query, member.user.username);
    state.enqueue(tracks);

    // If a priority user starts playback, they take the lock.
    if (isPriority(member) && !state.lockHolderId) {
      state.lockHolderId = member.id;
    }

    await state.start();

    await interaction.editReply({
      content: `✅ Added: **${label}**`,
      ...renderPanelFor(state, member),
    });
    return;
  }
}

async function handleButton(interaction) {
  if (!interaction.customId.startsWith('mc:')) return;

  const member = interaction.member;
  const state = music.peek(interaction.guild.id);

  const action = interaction.customId.slice(3);

  // Read-only views are allowed for anyone with access (even if locked out).
  if (action === 'refresh' || action === 'panel') {
    if (!hasAccess(member)) {
      return interaction.reply({ content: 'No access.', flags: MessageFlags.Ephemeral });
    }
    return interaction.update(renderPanelFor(state, member));
  }
  if (action === 'list') {
    if (!hasAccess(member)) {
      return interaction.reply({ content: 'No access.', flags: MessageFlags.Ephemeral });
    }
    return interaction.update(renderQueueFor(state, member));
  }

  // --- Approve/Deny permission requests ---
  if (action.startsWith('approve:') || action.startsWith('deny:')) {
    const parts = action.split(':');
    const decision = parts[0]; // 'approve' or 'deny'
    const requestedAction = parts[1]; // 'skip' or 'stop'
    const requesterId = parts[2];

    // Only the controller can approve/deny.
    if (!state?.starterUser || state.starterUser.id !== member.id) {
      return interaction.reply({ content: 'Only the current controller can decide.', flags: MessageFlags.Ephemeral });
    }

    if (decision === 'approve') {
      if (requestedAction === 'skip') state.skip();
      else if (requestedAction === 'stop') state.stop();
      await interaction.update({
        content: `✅ **${member.user.username}** approved the **${requestedAction}** request from <@${requesterId}>.`,
        components: [],
      });
    } else {
      await interaction.update({
        content: `❌ **${member.user.username}** denied the **${requestedAction}** request from <@${requesterId}>.`,
        components: [],
      });
    }
    return;
  }

  // All other actions modify playback -> check the lock.
  const control = canControl(state, member);
  if (!control.allowed) {
    // Instead of just blocking, offer a "request skip" for skip/stop actions.
    if (action === 'skip' || action === 'stop') {
      const controllerUser = state.starterUser;
      if (controllerUser) {
        return interaction.reply({
          content: `🎵 **${controllerUser.username}** is in control. Asking them for permission…\n<@${controllerUser.id}>, **${member.user.username}** wants to **${action}** the current track. React below to approve.`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(`mc:approve:${action}:${member.id}`)
                .setEmoji('✅')
                .setLabel('Allow')
                .setStyle(ButtonStyle.Success),
              new ButtonBuilder()
                .setCustomId(`mc:deny:${action}:${member.id}`)
                .setEmoji('❌')
                .setLabel('Deny')
                .setStyle(ButtonStyle.Danger),
            ),
          ],
        });
      }
    }
    return interaction.reply({ content: control.reason, flags: MessageFlags.Ephemeral });
  }

  // Library actions (continue / replay) start playback, so they need a voice
  // channel but NOT an already-playing track. Handle them before that guard.
  if (action === 'continue' || action.startsWith('replay:') || action === 'playlib') {
    const voiceChannel = member.voice?.channel;
    if (!voiceChannel) {
      return interaction.reply({
        content: 'Join a voice channel first.',
        flags: MessageFlags.Ephemeral,
      });
    }

    const liveState = music.get(interaction.guild.id);
    liveState.textChannel = interaction.channel;
    liveState.starterUser = member.user;
    if (!liveState.connection || liveState.voiceChannelId !== voiceChannel.id) {
      liveState.connect(voiceChannel);
    }
    if (isPriority(member) && !liveState.lockHolderId) {
      liveState.lockHolderId = member.id;
    }

    await interaction.deferUpdate();
    try {
      if (action === 'continue') {
        const session = store.getSession(interaction.guild.id);
        await liveState.resumeSession(session);
      } else if (action === 'playlib') {
        // Play the user's entire personal library as a playlist.
        const userLib = store.getUserLibrary(interaction.guild.id, member.id);
        if (!userLib.length) throw new Error('Your library is empty. Add songs with `/libadd`.');
        await liveState.waitUntilReady();
        liveState.queue = userLib.map((t) => ({ ...t, requestedBy: member.user.username }));
        await liveState.playNext();
      } else {
        const index = parseInt(action.slice(7), 10);
        const history = store.getHistory(interaction.guild.id);
        const track = history[index];
        if (!track) throw new Error('That track is no longer in your library.');
        await liveState.playTrackNow(track);
      }
    } catch (err) {
      return interaction.followUp({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return interaction.editReply(renderPanelFor(liveState, member));
  }

  if (!state || !state.current) {
    return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
  }

  // Jump-to-track buttons carry the index: "jump:<n>".
  if (action.startsWith('jump:')) {
    const index = parseInt(action.slice(5), 10);
    await interaction.deferUpdate();
    try {
      await state.jumpTo(index);
    } catch (err) {
      return interaction.followUp({ content: `⚠️ ${err.message}`, flags: MessageFlags.Ephemeral });
    }
    return interaction.editReply(renderPanelFor(state, member));
  }

  switch (action) {
    case 'playpause': {
      if (state.isPaused()) state.resume();
      else state.pause();
      return interaction.update(renderPanelFor(state, member));
    }
    case 'loop': {
      state.cycleLoop();
      return interaction.update(renderPanelFor(state, member));
    }
    case 'skip': {
      // Acknowledge first, then advance and re-render once the next track loads.
      await interaction.deferUpdate();
      state.skip();
      setTimeout(() => interaction.editReply(renderPanelFor(state, member)).catch(() => {}), 1200);
      return;
    }
    case 'stop': {
      const wasHolder = state.lockHolderId === member.id;
      state.stop();
      if (wasHolder) state.lockHolderId = null;
      return interaction.update(renderPanelFor(state, member));
    }
    case 'back': {
      // Seeking re-streams the track (spawns yt-dlp/ffmpeg) and can take a few
      // seconds, so acknowledge the interaction first to avoid the 3s deadline.
      await interaction.deferUpdate();
      await state.seek(Math.max(0, state.getPosition() - 15));
      return interaction.editReply(renderPanelFor(state, member));
    }
    case 'forward': {
      await interaction.deferUpdate();
      await state.seek(state.getPosition() + 15);
      return interaction.editReply(renderPanelFor(state, member));
    }
    case 'seek': {
      const modal = new ModalBuilder().setCustomId('mc:seekModal').setTitle('Seek to position');
      const input = new TextInputBuilder()
        .setCustomId('position')
        .setLabel('Position (seconds or mm:ss)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 90 or 1:30')
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    default:
      return;
  }
}

function parsePosition(text) {
  const trimmed = text.trim();
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map((p) => parseInt(p, 10));
    if (parts.some((n) => Number.isNaN(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  const n = parseInt(trimmed, 10);
  return Number.isNaN(n) ? null : n;
}

async function handleModal(interaction) {
  if (interaction.customId !== 'mc:seekModal') return;

  const member = interaction.member;
  const state = music.peek(interaction.guild.id);

  const control = canControl(state, member);
  if (!control.allowed) {
    return interaction.reply({ content: control.reason, flags: MessageFlags.Ephemeral });
  }
  if (!state || !state.current) {
    return interaction.reply({ content: 'Nothing is playing.', flags: MessageFlags.Ephemeral });
  }

  const seconds = parsePosition(interaction.fields.getTextInputValue('position'));
  if (seconds === null || seconds < 0) {
    return interaction.reply({
      content: 'Invalid position. Use seconds (90) or mm:ss (1:30).',
      flags: MessageFlags.Ephemeral,
    });
  }

  // Acknowledge before the (slow) re-stream so we don't miss the 3s deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const target = await state.seek(seconds);
  await interaction.editReply({
    content: `⏱️ Seeked to \`${formatTime(target)}\`.`,
  });
}

// ---------- Release the lock when the priority user leaves the VC ----------
// ---------- Auto-leave when the VC is empty for 2 minutes ----------

const leaveTimers = new Map(); // guildId -> timeout

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState.guild.id;
  const state = music.peek(guildId);

  // --- Priority lock release ---
  if (state?.lockHolderId && oldState.id === state.lockHolderId) {
    const left = oldState.channelId === state.voiceChannelId && newState.channelId !== state.voiceChannelId;
    if (left) {
      state.lockHolderId = null;
      if (state.textChannel) {
        state.textChannel.send('🔓 Priority user left — controls are open to everyone again.').catch(() => {});
      }
    }
  }

  // --- Auto-leave if VC is empty (only the bot remains) ---
  if (!state || !state.voiceChannelId) return;

  const voiceChannel = oldState.guild.channels.cache.get(state.voiceChannelId);
  if (!voiceChannel) return;

  // Count human members (exclude bots)
  const humans = voiceChannel.members.filter((m) => !m.user.bot).size;

  if (humans === 0) {
    // Start a 2-minute timer to leave
    if (!leaveTimers.has(guildId)) {
      const timer = setTimeout(() => {
        leaveTimers.delete(guildId);
        const currentState = music.peek(guildId);
        if (!currentState) return;

        // Re-check: still empty?
        const vc = oldState.guild.channels.cache.get(currentState.voiceChannelId);
        const stillEmpty = !vc || vc.members.filter((m) => !m.user.bot).size === 0;

        if (stillEmpty) {
          currentState.persistSession();
          currentState.destroy();
          music.states.delete(guildId);
          console.log(`[${guildId}] Left VC — empty for 2 minutes.`);
        }
      }, 2 * 60 * 1000); // 2 minutes
      leaveTimers.set(guildId, timer);
    }
  } else {
    // Someone joined back — cancel the leave timer
    if (leaveTimers.has(guildId)) {
      clearTimeout(leaveTimers.get(guildId));
      leaveTimers.delete(guildId);
    }
  }
});

// ---------- Graceful shutdown ----------

async function shutdown(signal) {
  console.log(`\n${signal} received — shutting down gracefully…`);
  // Persist sessions & kill streams for every guild.
  for (const [, state] of music.states ?? []) {
    try { state.persistSession(); } catch {}
    try { state.destroy(); } catch {}
  }
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

client.login(TOKEN).catch((err) => {
  console.error('Failed to log in — is your DISCORD_TOKEN correct?', err.message);
  process.exit(1);
});
