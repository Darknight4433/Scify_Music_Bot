import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function progressBar(position, duration, size = 18) {
  if (!duration) return '─'.repeat(size);
  const ratio = Math.min(1, position / duration);
  const filled = Math.round(ratio * size);
  return '▬'.repeat(filled) + '🔘' + '▬'.repeat(Math.max(0, size - filled - 1));
}

/**
 * Build the "now playing" embed for the control panel.
 */
export function buildPanelEmbed(state, { locked, lockHolderTag } = {}) {
  const embed = new EmbedBuilder().setColor(0x5865f2);

  if (!state || !state.current) {
    return embed.setTitle('Nothing is playing').setDescription('Use `/play` to add a track.');
  }

  const position = state.getPosition();
  const duration = state.getDuration();
  const paused = state.isPaused();

  embed
    .setTitle(state.current.title)
    .setURL(state.current.url)
    .setDescription(
      `${paused ? '⏸️ Paused' : '▶️ Playing'}\n` +
        `\`${formatTime(position)}\` ${progressBar(position, duration)} \`${formatTime(duration)}\``,
    )
    .addFields({ name: 'Requested by', value: String(state.current.requestedBy ?? 'unknown'), inline: true });

  if (state.queue.length) {
    embed.addFields({ name: 'In queue', value: `${state.queue.length} track(s)`, inline: true });
  }

  const loopLabel =
    state.loopMode === 'track'
      ? '🔂 Looping track'
      : state.loopMode === 'queue'
        ? '🔁 Looping queue'
        : '➡️ No loop';
  embed.addFields({ name: 'Loop', value: loopLabel, inline: true });

  if (locked) {
    embed.setFooter({
      text: `🎵 Controlled by ${lockHolderTag ?? 'someone'} — wait for their session to end.`,
    });
  }

  return embed;
}

/**
 * Build the button rows for the control panel.
 * `disabled` greys out the control buttons (used when the panel viewer is locked out).
 */
export function buildPanelComponents({ paused = false, disabled = false, loopMode = 'off' } = {}) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mc:back')
      .setEmoji('⏪')
      .setLabel('-15s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('mc:playpause')
      .setEmoji(paused ? '▶️' : '⏸️')
      .setLabel(paused ? 'Play' : 'Pause')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('mc:forward')
      .setEmoji('⏩')
      .setLabel('+15s')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('mc:skip')
      .setEmoji('⏭️')
      .setLabel('Skip')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );

  const loopEmoji = loopMode === 'track' ? '🔂' : '🔁';
  const loopStyle = loopMode === 'off' ? ButtonStyle.Secondary : ButtonStyle.Success;
  const loopBtnLabel = loopMode === 'track' ? 'Track' : loopMode === 'queue' ? 'Queue' : 'Loop';

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mc:stop')
      .setEmoji('⏹️')
      .setLabel('Stop')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('mc:seek')
      .setEmoji('⏱️')
      .setLabel('Seek')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('mc:loop')
      .setEmoji(loopEmoji)
      .setLabel(loopBtnLabel)
      .setStyle(loopStyle)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId('mc:list')
      .setEmoji('📜')
      .setLabel('Songs')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('mc:refresh')
      .setEmoji('🔄')
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary),
  );

  return [row1, row2];
}

/**
 * Build the "all songs" view: an embed listing the queue plus a button per
 * track (max 20) so the viewer can jump straight to one. Includes a button
 * to go back to the control panel.
 */
export function buildQueueView(state, { disabled = false } = {}) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🎵 Songs in queue');

  if (!state || (!state.current && state.queue.length === 0)) {
    embed.setDescription('The queue is empty. Use `/play` to add something.');
    return { embeds: [embed], components: [backRow()] };
  }

  const lines = [];
  if (state.current) {
    lines.push(`**Now playing:** ${truncate(state.current.title)}`);
  }

  const max = Math.min(state.queue.length, 20);
  for (let i = 0; i < max; i++) {
    lines.push(`**${i + 1}.** ${truncate(state.queue[i].title)}`);
  }
  if (state.queue.length > max) {
    lines.push(`…and ${state.queue.length - max} more`);
  }
  embed.setDescription(lines.join('\n') || 'Nothing queued.');

  // Up to 20 jump buttons across 4 rows of 5.
  const rows = [];
  for (let i = 0; i < max; i++) {
    if (i % 5 === 0) rows.push(new ActionRowBuilder());
    rows[rows.length - 1].addComponents(
      new ButtonBuilder()
        .setCustomId(`mc:jump:${i}`)
        .setLabel(String(i + 1))
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
    );
  }
  rows.push(backRow());
  return { embeds: [embed], components: rows };
}

function backRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('mc:panel')
      .setEmoji('◀️')
      .setLabel('Back to controls')
      .setStyle(ButtonStyle.Secondary),
  );
}

function truncate(text, len = 60) {
  const t = String(text ?? '');
  return t.length > len ? `${t.slice(0, len - 1)}…` : t;
}

/**
 * Build the library view shown when `/play` is used with no query.
 * Shows a "Continue" button if there's a saved session, plus a numbered list
 * of recently played tracks with a replay button each (max 20).
 */
export function buildLibraryView(session, history) {
  const embed = new EmbedBuilder().setColor(0x5865f2).setTitle('🎶 Your music library');

  const lines = [];

  if (session?.track) {
    const pos = formatTime(session.positionSec ?? 0);
    const dur = formatTime(session.track.durationInSec ?? 0);
    const more = session.queue?.length ? ` (+${session.queue.length} queued)` : '';
    lines.push(`**▶️ Continue where you stopped:**\n${truncate(session.track.title)} — \`${pos} / ${dur}\`${more}\n`);
  }

  if (history?.length) {
    lines.push('**Recently played:**');
    const max = Math.min(history.length, 20);
    for (let i = 0; i < max; i++) {
      lines.push(`**${i + 1}.** ${truncate(history[i].title)}`);
    }
  } else if (!session?.track) {
    lines.push('Nothing here yet. Play something with `/play <link or search>` first.');
  }

  embed.setDescription(lines.join('\n'));

  const rows = [];

  // Continue button on its own row.
  if (session?.track) {
    rows.push(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('mc:continue')
          .setEmoji('▶️')
          .setLabel('Continue')
          .setStyle(ButtonStyle.Success),
      ),
    );
  }

  // Replay buttons for history (numbered), up to 20 across rows of 5.
  const max = Math.min(history?.length ?? 0, 20);
  let current = null;
  for (let i = 0; i < max; i++) {
    if (i % 5 === 0) {
      current = new ActionRowBuilder();
      rows.push(current);
    }
    current.addComponents(
      new ButtonBuilder()
        .setCustomId(`mc:replay:${i}`)
        .setLabel(String(i + 1))
        .setStyle(ButtonStyle.Primary),
    );
  }

  return { embeds: [embed], components: rows };
}
