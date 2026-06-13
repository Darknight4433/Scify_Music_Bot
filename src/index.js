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
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { MusicManager, resolveTracks } from './musicManager.js';
import { buildPanelEmbed, buildPanelComponents, buildQueueView, buildLibraryView, formatTime } from './ui.js';
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
  // No state yet (e.g. clicking a panel after a bot restart) -> nothing locked.
  if (!state || !state.lockHolderId) return { allowed: true };
  // Locked by this same user -> allowed.
  if (state.lockHolderId === member.id) return { allowed: true };
  // Locked by someone else.
  return {
    allowed: false,
    reason: '🔒 A priority user is currently controlling the music. You can play again once they stop or leave the voice channel.',
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
    .setName('library')
    .setDescription('Show your music library (resume or replay)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('controls')
    .setDescription('Open your personal music control panel')
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
  const locked = Boolean(state?.lockHolderId);
  const lockedOut = locked && state.lockHolderId !== viewer.id;
  const lockHolderTag = locked
    ? viewer.guild.members.cache.get(state.lockHolderId)?.user?.tag
    : undefined;

  return {
    embeds: [buildPanelEmbed(state, { locked, lockHolderTag })],
    components: buildPanelComponents({
      paused: state ? state.isPaused() : false,
      disabled: lockedOut || !state?.current,
      loopMode: state?.loopMode ?? 'off',
    }),
  };
}

// ---------- Queue list view for a specific viewer ----------

function renderQueueFor(state, viewer) {
  const locked = Boolean(state?.lockHolderId);
  const lockedOut = locked && state.lockHolderId !== viewer.id;
  return buildQueueView(state, { disabled: lockedOut });
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

  const state = music.get(interaction.guild.id);

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

    // Enforce the priority lock before starting anything new.
    const control = canControl(state, member);
    if (!control.allowed) {
      return interaction.reply({ content: control.reason, flags: MessageFlags.Ephemeral });
    }

    // Acknowledge immediately so we never hit the 3s interaction deadline,
    // since resolving the track can take a moment.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    state.textChannel = interaction.channel;
    // Remember who last started playback, so we can DM them (privately) when
    // the queue finishes instead of posting a public message.
    state.starterUser = member.user;
    if (!state.connection || state.voiceChannelId !== voiceChannel.id) {
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

  if (interaction.commandName === 'controls') {
    return interaction.reply({
      ...renderPanelFor(state, member),
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

  // All other actions modify playback -> check the lock.
  const control = canControl(state, member);
  if (!control.allowed) {
    return interaction.reply({ content: control.reason, flags: MessageFlags.Ephemeral });
  }

  // Library actions (continue / replay) start playback, so they need a voice
  // channel but NOT an already-playing track. Handle them before that guard.
  if (action === 'continue' || action.startsWith('replay:')) {
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

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const guildId = oldState.guild.id;
  const state = music.peek(guildId);
  if (!state || !state.lockHolderId) return;

  // Only care about the lock holder.
  if (oldState.id !== state.lockHolderId) return;

  const left = oldState.channelId === state.voiceChannelId && newState.channelId !== state.voiceChannelId;
  if (left) {
    state.lockHolderId = null;
    if (state.textChannel) {
      state.textChannel.send('🔓 Priority user left — controls are open to everyone again.').catch(() => {});
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
