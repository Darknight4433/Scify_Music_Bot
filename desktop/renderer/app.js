/**
 * app.js — Scify Music renderer logic.
 *
 * Handles all UI interactions: navigation, search, playback controls,
 * queue management, library, settings, and real-time status updates.
 */

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  settings: {},
  status: null,
  searchTimeout: null,
  seeking: false,
};

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot() {
  injectToastContainer();
  bindTitlebar();

  // Check if first-run setup is needed
  const { needsSetup } = await window.scify.checkSetup();
  if (needsSetup) {
    showSetup();
    return; // Don't boot the main app yet
  }

  await bootMainApp();
}

function showSetup() {
  document.getElementById('setup-overlay').style.display = 'flex';

  // Get the invite URL from the bot token
  window.scify.getInviteUrl().then((res) => {
    if (res.ok) {
      document.getElementById('btn-setup-invite').onclick = () => {
        window.scify.openUrl(res.inviteUrl);
      };
    } else {
      document.getElementById('setup-error').textContent = res.error;
    }
  });

  // Done button — hide setup, start bot, boot main app
  document.getElementById('btn-setup-done').onclick = async () => {
    document.getElementById('setup-overlay').style.display = 'none';
    // Restart the bot so it picks up the new guild
    await window.scify.stopBot();
    await new Promise((r) => setTimeout(r, 1000));
    await window.scify.startBot();
    // Wait for bot to come online
    await new Promise((r) => setTimeout(r, 5000));
    await bootMainApp();
  };
}

async function bootMainApp() {
  state.settings = await window.scify.getSettings();
  applySettings(state.settings);
  bindNav();
  bindNowPlaying();
  bindSearch();
  bindQueue();
  bindSettings();
  bindMiniBar();
  bindPlaylists();
  bindBotProcess();
  bindYtAuth();

  // Listen for bot status pushes from main process
  window.scify.onStatusUpdate((status) => {
    state.status = status;
    renderStatus(status);
  });

  // Listen for bot process status
  window.scify.onBotStatus((status) => {
    renderBotStatus(status);
  });

  // Listen for bot process logs
  window.scify.onBotLog((log) => {
    appendBotLog(log);
  });

  // Get initial bot status
  const botStatus = await window.scify.getBotStatus();
  renderBotStatus(botStatus.online ? 'online' : (botStatus.running ? 'starting' : 'stopped'));
}

// ── Navigation ────────────────────────────────────────────────────────────────
function bindNav() {
  document.querySelectorAll('.nav-item').forEach((item) => {
    item.addEventListener('click', () => {
      const view = item.dataset.view;
      switchView(view);
    });
  });
}

function switchView(name) {
  document.querySelectorAll('.nav-item').forEach((i) =>
    i.classList.toggle('active', i.dataset.view === name),
  );
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('active', v.id === `view-${name}`),
  );

  if (name === 'queue') loadQueue();
  if (name === 'library') loadLibrary();
  if (name === 'playlists') loadPlaylistLibrary();
  if (name === 'settings') loadSettingsForm();
}

// ── Titlebar ─────────────────────────────────────────────────────────────────
function bindTitlebar() {
  document.getElementById('btn-minimize').onclick = () => window.scify.minimize();
  document.getElementById('btn-maximize').onclick = () => window.scify.maximize();
  document.getElementById('btn-close').onclick    = () => window.scify.close();
}

// ── Real-time status rendering ────────────────────────────────────────────────
function renderStatus(status) {
  const playing = status?.playing && status?.current;

  // Connection indicator
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (status === null) {
    dot.className  = 'status-dot offline';
    text.textContent = 'Bot offline';
  } else if (status?.noGuild) {
    dot.className  = 'status-dot warning';
    text.textContent = 'No server — see Settings';
  } else {
    dot.className  = 'status-dot online';
    text.textContent = playing ? 'Playing' : 'Connected';
  }

  // Queue count badge
  const qCount = status?.queue?.length ?? 0;
  const badge = document.getElementById('queue-count');
  if (qCount > 0) {
    badge.textContent = qCount;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }

  // Now Playing art
  const artImg   = document.getElementById('art-img');
  const artPh    = document.getElementById('art-placeholder');
  const thumbUrl = status?.current?.thumbnail;
  if (thumbUrl) {
    artImg.src  = thumbUrl;
    artImg.style.display = '';
    artPh.style.display  = 'none';
  } else {
    artImg.style.display = 'none';
    artPh.style.display  = '';
  }

  // Track title / sub
  document.getElementById('track-title').textContent = playing
    ? status.current.title
    : 'Nothing playing';
  document.getElementById('track-sub').textContent = playing
    ? `Requested by ${status.current.requestedBy ?? 'someone'}`
    : 'Search or browse your library to start';

  // Play/pause button state
  const iconPlay  = document.querySelector('.icon-play');
  const iconPause = document.querySelector('.icon-pause');
  if (status?.paused || !playing) {
    iconPlay.style.display  = '';
    iconPause.style.display = 'none';
  } else {
    iconPlay.style.display  = 'none';
    iconPause.style.display = '';
  }

  // Loop button
  const loopBtn = document.getElementById('btn-loop');
  loopBtn.classList.toggle('active', status?.loopMode && status.loopMode !== 'off');
  loopBtn.title = `Loop: ${status?.loopMode ?? 'off'}`;

  // Progress bar
  if (!state.seeking) {
    updateProgress(status?.positionSec ?? 0, status?.durationSec ?? 0);
  }

  // Queue preview
  renderQueuePreview(status?.queue ?? []);

  // Mini-bar
  renderMiniBar(status);

  // Update playlist detail view playing indicator if visible
  updatePlaylistPlayingIndicator(status);
}

function updateProgress(pos, dur) {
  const pct = dur > 0 ? Math.min((pos / dur) * 100, 100) : 0;
  document.getElementById('progress-fill').style.width = `${pct}%`;
  document.getElementById('mini-progress-fill').style.width = `${pct}%`;
  document.getElementById('time-current').textContent = formatTime(pos);
  document.getElementById('time-total').textContent   = formatTime(dur);
}

function renderQueuePreview(queue) {
  const list = document.getElementById('queue-preview-list');
  if (!queue.length) {
    list.innerHTML = '<div class="empty-state-small">Queue is empty</div>';
    return;
  }
  list.innerHTML = queue
    .slice(0, 10)
    .map(
      (t, i) => `
    <div class="queue-preview-item" onclick="jumpTo(${i})">
      <span class="qi-num">${i + 1}</span>
      ${t.thumbnail
        ? `<img class="qi-thumb" src="${esc(t.thumbnail)}" alt="" loading="lazy" />`
        : `<div class="qi-thumb" style="display:flex;align-items:center;justify-content:center;font-size:14px">🎵</div>`}
      <span class="qi-title">${esc(t.title)}</span>
    </div>
  `,
    )
    .join('');
}

function renderMiniBar(status) {
  const playing = status?.playing && status?.current;
  document.getElementById('mini-title').textContent = playing ? status.current.title : 'Not connected';
  document.getElementById('mini-sub').textContent   = playing ? formatTime(status.positionSec) + ' / ' + formatTime(status.durationSec) : '—';

  const miniArtImg = document.getElementById('mini-art-img');
  if (status?.current?.thumbnail) {
    miniArtImg.src = status.current.thumbnail;
    miniArtImg.style.display = '';
  } else {
    miniArtImg.style.display = 'none';
  }

  const miniPlay = document.getElementById('mini-playpause');
  miniPlay.textContent = (status?.paused || !playing) ? '▶' : '⏸';

  // Update like button state for current track
  updateNowPlayingLikeState(status);
}

let _lastLikeCheckQuery = null;
async function updateNowPlayingLikeState(status) {
  const btn = document.getElementById('mini-like-btn');
  if (!btn) return;
  const playing = status?.playing && status?.current;
  if (!playing) {
    btn.classList.remove('liked');
    btn.textContent = '🤍';
    _lastLikeCheckQuery = null;
    return;
  }
  const query = status.current.url || status.current.title;
  if (query === _lastLikeCheckQuery) return; // avoid repeated API calls
  _lastLikeCheckQuery = query;
  try {
    const { liked } = await window.scify.likedSongsCheck(query);
    if (liked) { btn.classList.add('liked'); btn.textContent = '❤️'; }
    else { btn.classList.remove('liked'); btn.textContent = '🤍'; }
  } catch { /* ignore */ }
}

// ── Now Playing controls ──────────────────────────────────────────────────────
function bindNowPlaying() {
  // Progress bar click to seek
  document.getElementById('progress-bar').addEventListener('click', async (e) => {
    const dur = state.status?.durationSec;
    if (!dur) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct  = (e.clientX - rect.left) / rect.width;
    const secs = Math.floor(pct * dur);
    await apiControl('seek', secs);
  });

  document.getElementById('btn-playpause').onclick = () => sendControl('playpause');
  document.getElementById('btn-skip').onclick      = () => sendControl('skip');
  document.getElementById('btn-back').onclick      = () => sendControl('back');
  document.getElementById('btn-forward').onclick   = () => sendControl('forward');
  document.getElementById('btn-stop').onclick      = () => sendControl('stop');
  document.getElementById('btn-loop').onclick      = () => sendControl('loop');
  document.getElementById('btn-go-queue').onclick  = () => switchView('queue');
}

async function sendControl(action) {
  if (!state.settings.guildId) {
    toast('No server configured. Go to Settings first.', 'error');
    return;
  }
  try {
    await window.scify.api.post('/control', {
      guildId: state.settings.guildId,
      action,
    });
  } catch (err) {
    if (err.message?.includes('Guild not found')) {
      toast('Bot is not in that server. Check Settings.', 'error');
    } else {
      toast(err.message, 'error');
    }
  }
}

async function apiControl(type, value) {
  try {
    if (type === 'seek') {
      await window.scify.api.post('/seek', {
        guildId: state.settings.guildId,
        seconds: value,
      });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ── Jump-to-track (from queue preview) ────────────────────────────────────────
window.jumpTo = async (index) => {
  try {
    await window.scify.api.post('/queue/jump', {
      guildId: state.settings.guildId,
      index,
    });
    toast('Jumped to track ✓', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ── Mini-bar ──────────────────────────────────────────────────────────────────
function bindMiniBar() {
  document.getElementById('mini-playpause').onclick = () => {
    const action = (state.status?.paused || !state.status?.playing) ? 'resume' : 'pause';
    sendControl(action);
  };
  document.getElementById('mini-skip').onclick = () => sendControl('skip');
  document.getElementById('mini-back').onclick = () => sendControl('back');
}

// ── Search ────────────────────────────────────────────────────────────────────
function bindSearch() {
  const input  = document.getElementById('search-input');
  const clear  = document.getElementById('search-clear');
  const results = document.getElementById('search-results');

  input.addEventListener('input', () => {
    const q = input.value.trim();
    clear.style.display = q ? '' : 'none';

    clearTimeout(state.searchTimeout);
    if (!q) {
      results.innerHTML = '';
      return;
    }

    // Show spinner
    results.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Searching…</div>';
    state.searchTimeout = setTimeout(() => doSearch(q), 600);
  });

  clear.addEventListener('click', () => {
    input.value = '';
    clear.style.display = 'none';
    results.innerHTML = '';
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      clearTimeout(state.searchTimeout);
      const q = input.value.trim();
      if (q) doSearch(q);
    }
  });
}

async function doSearch(query) {
  const results = document.getElementById('search-results');
  results.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Searching…</div>';

  try {
    // We ask the bot to resolve the search. The bot returns the first result.
    // For a real multi-result search we'd need a separate yt-dlp search endpoint.
    // For now, we build a fake "card" that plays on click.
    // If it's a URL, show it directly.
    const isUrl = /^https?:\/\//.test(query);

    if (isUrl) {
      results.innerHTML = renderSearchCard({
        title: 'Play this link',
        thumbnail: null,
        url: query,
        durationSec: 0,
      });
    } else {
      // Show a virtual "play this search" card + note
      results.innerHTML = renderSearchCard({
        title: `Search: "${query}"`,
        thumbnail: null,
        url: query,
        durationSec: 0,
        isSearch: true,
      });
    }
  } catch (err) {
    results.innerHTML = `<div class="empty-state"><div class="es-icon">😢</div><div class="es-text">Search failed</div><div class="es-sub">${esc(err.message)}</div></div>`;
  }
}

function renderSearchCard(track) {
  const id = `sc-${Math.random().toString(36).slice(2)}`;
  // Store track data in a map for the onclick handler
  window.__searchCards = window.__searchCards || {};
  window.__searchCards[id] = track;

  return `
    <div class="result-card" id="${id}">
      ${track.thumbnail
        ? `<img class="card-thumb" src="${esc(track.thumbnail)}" alt="" loading="lazy" />`
        : `<div class="card-thumb-placeholder">🎵</div>`}
      <div class="card-play-overlay"><span>▶</span></div>
      <div class="card-body">
        <div class="card-title">${esc(track.title)}</div>
        ${track.durationSec ? `<div class="card-duration">${formatTime(track.durationSec)}</div>` : ''}
      </div>
      <div class="card-actions">
        <button class="card-action-btn primary" onclick="playNow('${id}')">▶ Play Now</button>
        <button class="card-action-btn secondary" onclick="addToQueue('${id}')">+ Queue</button>
      </div>
      <div class="card-extra-actions">
        <button class="like-btn" onclick="window.__toggleLike(event, '${id}')" title="Like">🤍</button>
        <div class="add-to-playlist-wrap">
          <button class="add-to-playlist-btn" onclick="window.__showAddToPlaylist(event, '${id}')" title="Add to Playlist">📁</button>
        </div>
      </div>
    </div>
  `;
}

window.playNow = async (id) => {
  const track = window.__searchCards?.[id];
  if (!track) return;
  const { guildId, channelId } = state.settings;
  if (!guildId || !channelId) {
    toast('Server not configured. Go to Settings.', 'error');
    return;
  }
  toast('Playing…');
  try {
    const res = await window.scify.api.post('/play', { guildId, channelId, query: track.url, requestedBy: 'Scify App' });
    toast(`▶ ${res.label}`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
};

window.addToQueue = async (id) => {
  const track = window.__searchCards?.[id];
  if (!track) return;
  const { guildId, channelId } = state.settings;
  if (!guildId || !channelId) {
    toast('Server not configured. Go to Settings.', 'error');
    return;
  }
  // Show immediate feedback — don't wait for resolution
  toast('Adding to queue…');
  window.scify.api.post('/play', { guildId, channelId, query: track.url, requestedBy: 'Scify App' })
    .then((res) => toast(`Queued: ${res.label} ✓`, 'success'))
    .catch((err) => toast(err.message, 'error'));
};

async function playQuery(query) {
  const { guildId, channelId } = state.settings;
  if (!guildId || !channelId) {
    toast('Server not configured yet. Go to Settings and click "Load Servers" to pick your Discord server.', 'error');
    switchView('settings');
    return;
  }
  try {
    const res = await window.scify.api.post('/play', { guildId, channelId, query, requestedBy: 'Scify App' });
    toast(`✓ ${res.label}`, 'success');
  } catch (err) {
    if (err.message?.includes('Guild not found')) {
      toast('Bot is not in that server. Invite it first using the link in Settings.', 'error');
    } else {
      toast(err.message, 'error');
    }
  }
}

// ── Library from history ────────────────────────────────────────────────────────────────
async function loadLibrary() {
  const list = document.getElementById('library-list');
  list.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading…</div>';

  const { guildId } = state.settings;
  if (!guildId) {
    list.innerHTML = '<div class="empty-state"><div class="es-icon">⚙️</div><div class="es-text">Set your Guild ID in Settings first</div></div>';
    return;
  }

  try {
    const data = await window.scify.api.get(`/history?guildId=${encodeURIComponent(guildId)}`);
    if (!data.history?.length) {
      list.innerHTML = '<div class="empty-state"><div class="es-icon">📚</div><div class="es-text">No history yet</div><div class="es-sub">Play some songs through the bot!</div></div>';
      return;
    }

    list.innerHTML = data.history.map((t) => {
      const id = `lc-${Math.random().toString(36).slice(2)}`;
      window.__searchCards = window.__searchCards || {};
      window.__searchCards[id] = t;
      return `
        <div class="result-card" id="${id}">
          ${t.thumbnail
            ? `<img class="card-thumb" src="${esc(t.thumbnail)}" alt="" loading="lazy" />`
            : `<div class="card-thumb-placeholder">🎵</div>`}
          <div class="card-play-overlay"><span>▶</span></div>
          <div class="card-body">
            <div class="card-title">${esc(t.title)}</div>
            ${t.durationSec ? `<div class="card-duration">${formatTime(t.durationSec)}</div>` : ''}
          </div>
          <div class="card-actions">
            <button class="card-action-btn primary" onclick="playNow('${id}')">▶ Play</button>
            <button class="card-action-btn secondary" onclick="addToQueue('${id}')">+ Queue</button>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    list.innerHTML = `<div class="empty-state"><div class="es-icon">😢</div><div class="es-text">Could not load library</div><div class="es-sub">${esc(err.message)}</div></div>`;
  }
}

// ── Queue view ────────────────────────────────────────────────────────────────
async function loadQueue() {
  const list = document.getElementById('queue-list');
  const { guildId } = state.settings;

  if (!state.status) {
    list.innerHTML = '<div class="empty-state"><div class="es-icon">📋</div><div class="es-text">Bot not connected</div></div>';
    return;
  }

  const queue = state.status.queue ?? [];
  const current = state.status.current;

  if (!queue.length && !current) {
    list.innerHTML = '<div class="empty-state"><div class="es-icon">📋</div><div class="es-text">Queue is empty</div><div class="es-sub">Search for songs to add them here</div></div>';
    return;
  }

  let html = '';

  // Show currently playing track (not removable from queue)
  if (current && state.status.playing) {
    html += `
      <div class="track-row now-playing-row">
        <div class="tr-num">▶</div>
        ${current.thumbnail
          ? `<img class="tr-thumb" src="${esc(current.thumbnail)}" alt="" loading="lazy" />`
          : `<div class="tr-thumb-placeholder">🎵</div>`}
        <div class="tr-info">
          <div class="tr-title">${esc(current.title)}</div>
          <div class="tr-by" style="color: var(--accent);">Now Playing</div>
        </div>
        <div class="tr-duration">${current.durationSec ? formatTime(current.durationSec) : '—'}</div>
      </div>
    `;
  }

  // Show queued tracks (these can be removed)
  if (queue.length) {
    html += queue.map((t, i) => `
      <div class="track-row" ondblclick="jumpTo(${i})">
        <div class="tr-num">${i + 1}</div>
        <div class="tr-play-icon" onclick="jumpTo(${i})">▶</div>
        ${t.thumbnail
          ? `<img class="tr-thumb" src="${esc(t.thumbnail)}" alt="" loading="lazy" />`
          : `<div class="tr-thumb-placeholder">🎵</div>`}
        <div class="tr-info">
          <div class="tr-title">${esc(t.title)}</div>
          ${t.requestedBy ? `<div class="tr-by">by ${esc(t.requestedBy)}</div>` : ''}
        </div>
        <div class="tr-duration">${t.durationSec ? formatTime(t.durationSec) : '—'}</div>
        <button class="tr-remove" onclick="removeFromQueue(${i})" title="Remove">✕</button>
      </div>
    `).join('');
  } else if (current) {
    html += '<div class="empty-state-small" style="margin-top:16px;">No more tracks in queue</div>';
  }

  list.innerHTML = html;
}

window.removeFromQueue = async (index) => {
  try {
    await window.scify.api.post('/queue/remove', {
      guildId: state.settings.guildId,
      index,
    });
    toast('Removed from queue', 'success');
    // Refresh queue view
    setTimeout(loadQueue, 500);
  } catch (err) {
    toast(err.message, 'error');
  }
};

function bindQueue() {
  document.getElementById('btn-clear-queue').onclick = async () => {
    const queue = state.status?.queue ?? [];
    if (!queue.length) { toast('Queue is already empty.'); return; }
    // Remove from index 0 each time (array shifts after each removal)
    for (let i = 0; i < queue.length; i++) {
      await window.scify.api.post('/queue/remove', {
        guildId: state.settings.guildId,
        index: 0,
      }).catch(() => {});
    }
    toast('Queue cleared', 'success');
    setTimeout(loadQueue, 600);
  };
}

// ── Settings ──────────────────────────────────────────────────────────────────
function loadSettingsForm() {
  const s = state.settings;
  document.getElementById('set-api-url').value     = s.apiUrl     || '';
  document.getElementById('set-api-secret').value  = s.apiSecret  || '';
  document.getElementById('set-guild-id').value    = s.guildId    || '';
  document.getElementById('set-channel-id').value  = s.channelId  || '';
  document.getElementById('set-rich-presence').checked = !!s.richPresence;

  document.getElementById('set-auto-start-bot').checked = !!s.autoStartBot;
  document.getElementById('set-auto-join-vc').checked = !!s.autoJoinVc;
  document.getElementById('set-bot-folder').value   = s.botFolder  || '';
  document.getElementById('set-spotify-interval').value = s.spotifySyncIntervalHours || 24;

  checkYtAuthStatus();
}

function bindSettings() {
  // Invite bot button
  document.getElementById('btn-invite-bot').onclick = async () => {
    const res = await window.scify.getInviteUrl();
    if (res.ok) {
      window.scify.openUrl(res.inviteUrl);
      toast('Opening Discord invite in your browser…', 'success');
    } else {
      toast(res.error || 'Could not generate invite link. Set your bot token first.', 'error');
    }
  };

  document.getElementById('btn-save-settings').onclick = async () => {
    const updates = {
      apiUrl:       document.getElementById('set-api-url').value.trim(),
      apiSecret:    document.getElementById('set-api-secret').value.trim(),
      guildId:      document.getElementById('set-guild-id').value.trim(),
      channelId:    document.getElementById('set-channel-id').value.trim(),
      richPresence: document.getElementById('set-rich-presence').checked,
      autoStartBot: document.getElementById('set-auto-start-bot').checked,
      autoJoinVc:   document.getElementById('set-auto-join-vc').checked,
      botFolder:    document.getElementById('set-bot-folder').value.trim(),
      spotifySyncIntervalHours: parseInt(document.getElementById('set-spotify-interval').value, 10),
    };

    for (const [k, v] of Object.entries(updates)) {
      await window.scify.setSetting(k, v);
    }

    state.settings = { ...state.settings, ...updates };

    const msg = document.getElementById('save-msg');
    msg.textContent = '✓ Saved!';
    setTimeout(() => (msg.textContent = ''), 2500);
    toast('Settings saved ✓', 'success');
  };

  // Load guild list
  document.getElementById('btn-load-guilds').onclick = async () => {
    const container = document.getElementById('guild-list');
    container.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Loading…</span>';
    try {
      const data = await window.scify.getGuilds();
      container.innerHTML = data.guilds.map((g) => `
        <div class="guild-chip${g.id === state.settings.guildId ? ' selected' : ''}"
             onclick="selectGuild('${g.id}', '${esc(g.name)}')">
          ${esc(g.name)}
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<span style="font-size:11px;color:#f87171">${esc(err.message)}</span>`;
    }
  };

  // Load channel list
  document.getElementById('btn-load-channels').onclick = async () => {
    const guildId = document.getElementById('set-guild-id').value.trim() || state.settings.guildId;
    if (!guildId) { toast('Set a Guild ID first', 'error'); return; }
    const container = document.getElementById('channel-list');
    container.innerHTML = '<span style="font-size:11px;color:var(--text-muted)">Loading…</span>';
    try {
      const data = await window.scify.getChannels(guildId);
      container.innerHTML = data.channels.map((c) => `
        <div class="guild-chip${c.id === state.settings.channelId ? ' selected' : ''}"
             onclick="selectChannel('${c.id}', '${esc(c.name)}')">
          🔊 ${esc(c.name)}
        </div>
      `).join('');
    } catch (err) {
      container.innerHTML = `<span style="font-size:11px;color:#f87171">${esc(err.message)}</span>`;
    }
  };
}

window.selectGuild = (id, name) => {
  document.getElementById('set-guild-id').value = id;
  document.querySelectorAll('#guild-list .guild-chip').forEach((c) =>
    c.classList.toggle('selected', c.textContent.trim() === name),
  );
};

window.selectChannel = (id, name) => {
  document.getElementById('set-channel-id').value = id;
  document.querySelectorAll('#channel-list .guild-chip').forEach((c) =>
    c.classList.toggle('selected', c.textContent.trim().includes(name)),
  );
};

function applySettings(s) {
  // Nothing to apply on the DOM directly at boot; settings are reflected when the form opens.
}

// ── Local Bot Process ────────────────────────────────────────────────────────
function bindBotProcess() {
  document.getElementById('btn-start-bot-process').onclick = async () => {
    toast('Starting bot process...');
    await window.scify.startBot();
  };
  document.getElementById('btn-stop-bot-process').onclick = async () => {
    toast('Stopping bot process...');
    await window.scify.stopBot();
  };
  document.getElementById('btn-clear-logs').onclick = () => {
    document.getElementById('bot-log-viewer').value = '';
  };
}

function renderBotStatus(status) {
  const badge = document.getElementById('bot-status-badge');
  const dot = document.getElementById('bot-status-dot');
  const text = document.getElementById('bot-status-text');

  if (dot) {
    dot.className = `bot-status-dot ${status}`;
  }
  
  if (text) {
    let label = 'Stopped';
    if (status === 'online') label = 'Online';
    else if (status === 'starting') label = 'Starting…';
    else if (status === 'error') label = 'Error';
    text.textContent = label;
  }
  
  // Update UI buttons based on status
  const startBtn = document.getElementById('btn-start-bot-process');
  const stopBtn = document.getElementById('btn-stop-bot-process');
  if (startBtn && stopBtn) {
    if (status === 'online' || status === 'starting') {
      startBtn.disabled = true;
      stopBtn.disabled = false;
    } else {
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }
}

function appendBotLog(log) {
  const viewer = document.getElementById('bot-log-viewer');
  if (viewer) {
    viewer.value += log + '\n';
    viewer.scrollTop = viewer.scrollHeight;
  }
}

// ── YouTube Authentication ───────────────────────────────────────────────────
let ytAuthPollInterval = null;

function bindYtAuth() {
  const loginBtn = document.getElementById('btn-yt-login');
  const logoutBtn = document.getElementById('btn-yt-logout');
  const modal = document.getElementById('yt-auth-modal');
  const closeBtn = document.getElementById('btn-close-yt-modal');
  const cancelBtn = document.getElementById('btn-cancel-yt-auth');

  if (loginBtn) {
    loginBtn.onclick = async () => {
      try {
        toast('Initiating YouTube Login...');
        loginBtn.disabled = true;
        const res = await window.scify.ytAuthStart();
        loginBtn.disabled = false;

        if (res.alreadyAuth) {
          toast('YouTube is already authenticated!', 'success');
          checkYtAuthStatus();
          return;
        }

        if (!res.userCode) {
          throw new Error('No authorization code returned');
        }

        // Show modal
        document.getElementById('yt-device-code').textContent = res.userCode;
        const urlLink = document.getElementById('yt-device-url');
        urlLink.href = res.verificationUrl || 'https://www.google.com/device';
        urlLink.textContent = res.verificationUrl || 'https://www.google.com/device';
        urlLink.onclick = (e) => {
          e.preventDefault();
          window.scify.openUrl(urlLink.href);
        };

        modal.style.display = 'flex';

        // Start polling
        startPollingYtAuthStatus();

      } catch (err) {
        loginBtn.disabled = false;
        toast(`YouTube Auth failed: ${err.message}`, 'error');
      }
    };
  }

  const cancelAuth = async () => {
    stopPollingYtAuthStatus();
    modal.style.display = 'none';
    await window.scify.ytAuthCancel().catch(() => {});
    toast('YouTube authorization cancelled.');
  };

  if (closeBtn) closeBtn.onclick = cancelAuth;
  if (cancelBtn) cancelBtn.onclick = cancelAuth;

  if (logoutBtn) {
    logoutBtn.onclick = async () => {
      toast('YouTube login is cached by yt-dlp on this system.', 'info');
    };
  }
}

function startPollingYtAuthStatus() {
  if (ytAuthPollInterval) clearInterval(ytAuthPollInterval);
  ytAuthPollInterval = setInterval(async () => {
    try {
      const res = await window.scify.ytAuthStatus();
      if (res.authenticated) {
        stopPollingYtAuthStatus();
        document.getElementById('yt-auth-modal').style.display = 'none';
        toast('YouTube successfully authenticated!', 'success');
        checkYtAuthStatus();
      }
    } catch (err) {
      console.error('Polling auth status error:', err);
    }
  }, 3000);
}

// Helper function to stop polling
function stopPollingYtAuthStatus() {
  if (ytAuthPollInterval) {
    clearInterval(ytAuthPollInterval);
    ytAuthPollInterval = null;
  }
}

async function checkYtAuthStatus() {
  try {
    const badge = document.getElementById('yt-auth-status-badge');
    if (!badge) return;
    const res = await window.scify.ytAuthStatus();
    if (res.authenticated) {
      badge.textContent = 'Authenticated ✅';
      badge.style.color = '#22c55e';
      badge.style.background = 'rgba(34, 197, 94, 0.1)';
    } else {
      badge.textContent = 'Not Authenticated ❌';
      badge.style.color = '#ef4444';
      badge.style.background = 'rgba(239, 68, 68, 0.1)';
    }
  } catch (err) {
    console.error('Check YouTube auth error:', err);
  }
}

// ── Spotify Sync (removed — merged into Playlists page) ─────────────────────

// ── Playlist Management ──────────────────────────────────────────────────────
/**
 * Playlist state scoped to the playlist views.
 */
const playlistState = {
  currentPlaylistId: null,
  currentTracks: [],       // raw tracks from store (with originalIndex assigned)
  currentSortedTracks: [], // sorted view used for rendering and playback
  sortCriterion: 'custom',
  viewMode: 'list',
};

/**
 * Wire all playlist UI: library grid, detail view, import modal, playback, removal.
 * Called once from bootMainApp().
 */
function bindPlaylists() {
  // ── Load persisted view preferences ──
  window.scify.playlistGetViewMode().then((prefs) => {
    if (prefs) {
      playlistState.viewMode = prefs.viewMode || 'list';
      playlistState.sortCriterion = prefs.sortCriterion || 'custom';
    }
  }).catch(() => {});

  // ── Navigation: "Playlists" nav item handler ──
  const navPlaylists = document.getElementById('nav-playlists');
  if (navPlaylists) {
    navPlaylists.addEventListener('click', () => {
      // Ensure we show the library view and hide detail view
      showPlaylistLibrary();
      loadPlaylistLibrary();
    });
  }

  // ── Back button in detail view ──
  const backBtn = document.getElementById('btn-back-to-playlists');
  if (backBtn) {
    backBtn.onclick = () => {
      showPlaylistLibrary();
    };
  }

  // ── Sort dropdown ──
  const sortSelect = document.getElementById('playlist-sort-select');
  if (sortSelect) {
    sortSelect.value = playlistState.sortCriterion;
    sortSelect.onchange = () => {
      playlistState.sortCriterion = sortSelect.value;
      playlistState.currentSortedTracks = sortTracks(playlistState.currentTracks, playlistState.sortCriterion);
      renderPlaylistTracks();
      persistViewPrefs();
    };
  }

  // ── View mode toggle ──
  const btnList = document.getElementById('btn-view-list');
  const btnCompact = document.getElementById('btn-view-compact');
  if (btnList) {
    btnList.onclick = () => {
      playlistState.viewMode = 'list';
      btnList.classList.add('active');
      if (btnCompact) btnCompact.classList.remove('active');
      renderPlaylistTracks();
      persistViewPrefs();
    };
  }
  if (btnCompact) {
    btnCompact.onclick = () => {
      playlistState.viewMode = 'compact';
      btnCompact.classList.add('active');
      if (btnList) btnList.classList.remove('active');
      renderPlaylistTracks();
      persistViewPrefs();
    };
  }

  // ── Playback controls in detail view (Task 10.1) ──
  const playAllBtn = document.getElementById('btn-playlist-play-all');
  if (playAllBtn) {
    playAllBtn.onclick = () => {
      playAll(playlistState.currentSortedTracks);
    };
  }

  const queueAllBtn = document.getElementById('btn-playlist-queue-all');
  if (queueAllBtn) {
    queueAllBtn.onclick = () => {
      addToQueue(playlistState.currentSortedTracks);
    };
  }

  // ── Remove playlist button in detail header (Task 10.2) ──
  const removeBtn = document.getElementById('btn-playlist-remove');
  if (removeBtn) {
    removeBtn.onclick = async () => {
      const playlistId = playlistState.currentPlaylistId;
      if (!playlistId || playlistId === '__liked__') return;
      if (!confirm('Are you sure you want to remove this playlist? This cannot be undone.')) return;

      try {
        await window.scify.playlistRemove(playlistId);
        toast('Playlist removed', 'success');
        // Navigate back to the library view and refresh it
        showPlaylistLibrary();
        loadPlaylistLibrary();
      } catch (err) {
        toast(err.message || 'Failed to remove playlist.', 'error');
      }
    };
  }

  // ── Import modal wiring (Task 8.2) ──
  bindPlaylistImportModal();

  // ── Create playlist modal wiring ──
  bindCreatePlaylistModal();

  // ── Liked Songs wiring ──
  bindLikedSongs();
}

// ── Playlist library grid ────────────────────────────────────────────────────

function showPlaylistLibrary() {
  // Show the playlists library section, hide the detail view
  const libraryView = document.getElementById('view-playlists');
  const detailView = document.getElementById('view-playlist-detail');
  if (libraryView) libraryView.classList.add('active');
  if (detailView) detailView.classList.remove('active');

  // Ensure nav items reflect playlists view as active
  document.querySelectorAll('.nav-item').forEach((i) =>
    i.classList.toggle('active', i.dataset.view === 'playlists'),
  );
  // Hide all other views except playlists
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('active', v.id === 'view-playlists'),
  );
}

function showPlaylistDetail() {
  // Hide all views, show only the detail view
  document.querySelectorAll('.view').forEach((v) =>
    v.classList.toggle('active', v.id === 'view-playlist-detail'),
  );
  // Keep "Playlists" nav highlighted
  document.querySelectorAll('.nav-item').forEach((i) =>
    i.classList.toggle('active', i.dataset.view === 'playlists'),
  );
}

async function loadPlaylistLibrary() {
  const customGrid = document.getElementById('custom-playlists-grid');
  const importedGrid = document.getElementById('imported-playlists-grid');
  const customHeader = document.getElementById('custom-playlists-header');
  const importedHeader = document.getElementById('imported-playlists-header');
  const emptyState = document.getElementById('playlists-empty-state');
  const likedCountEl = document.getElementById('liked-songs-count');

  if (!customGrid || !importedGrid) return;

  customGrid.innerHTML = '';
  importedGrid.innerHTML = '';

  // Update liked songs count
  try {
    const liked = await window.scify.likedSongsGet();
    if (likedCountEl) likedCountEl.textContent = `${liked.length} song${liked.length !== 1 ? 's' : ''}`;
  } catch { /* ignore */ }

  try {
    const playlists = await window.scify.playlistGetAll();

    const customPlaylists = (playlists || []).filter((p) => p.source === 'custom');
    const importedPlaylists = (playlists || []).filter((p) => p.source !== 'custom');

    if (!customPlaylists.length && !importedPlaylists.length) {
      if (customHeader) customHeader.style.display = 'none';
      if (importedHeader) importedHeader.style.display = 'none';
      if (emptyState) emptyState.style.display = '';
      return;
    }

    if (emptyState) emptyState.style.display = 'none';

    // Custom playlists section
    if (customPlaylists.length) {
      if (customHeader) customHeader.style.display = '';
      customGrid.innerHTML = customPlaylists.map((p) => renderPlaylistCard(p)).join('');
    } else {
      if (customHeader) customHeader.style.display = 'none';
    }

    // Imported playlists section
    if (importedPlaylists.length) {
      if (importedHeader) importedHeader.style.display = '';
      importedGrid.innerHTML = importedPlaylists.map((p) => renderPlaylistCard(p)).join('');
    } else {
      if (importedHeader) importedHeader.style.display = 'none';
    }
  } catch (err) {
    customGrid.innerHTML = `<div class="empty-state"><div class="es-icon">😢</div><div class="es-text">Failed to load playlists</div><div class="es-sub">${esc(err.message)}</div></div>`;
  }
}

function renderPlaylistCard(p) {
  return `
    <div class="playlist-library-card" onclick="window.__openPlaylistDetail('${esc(p.id)}')">
      ${p.coverUrl
        ? `<img class="playlist-library-card-cover" src="${esc(p.coverUrl)}" alt="${esc(p.name)}" loading="lazy" />`
        : `<div class="playlist-library-card-cover-placeholder">${p.source === 'custom' ? '📝' : '🎶'}</div>`}
      <div class="playlist-library-card-info">
        <div class="playlist-library-card-title">${esc(p.name)}</div>
        <div class="playlist-library-card-meta">
          <span>${p.trackCount || 0} tracks</span>
          <span class="playlist-source-badge source-${esc(p.source)}">${esc(p.source)}</span>
        </div>
      </div>
      <div class="playlist-library-card-actions">
        <button class="playlist-library-card-btn remove" onclick="window.__removePlaylist(event, '${esc(p.id)}')">Remove</button>
      </div>
    </div>
  `;
}

// ── Playlist detail view ─────────────────────────────────────────────────────

window.__openPlaylistDetail = async (playlistId) => {
  playlistState.currentPlaylistId = playlistId;

  // Show detail view
  showPlaylistDetail();

  // Show remove button (hidden for liked songs)
  const removeBtn = document.getElementById('btn-playlist-remove');
  if (removeBtn) removeBtn.style.display = '';

  const trackListEl = document.getElementById('playlist-track-list');
  if (trackListEl) {
    trackListEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading…</div>';
  }

  try {
    const result = await window.scify.playlistGetTracks(playlistId);

    if (!result || result.ok === false) {
      throw new Error(result?.error || 'Playlist not found');
    }

    // Update header with playlist metadata
    document.getElementById('playlist-detail-name').textContent = result.name || 'Playlist';
    document.getElementById('playlist-detail-count').textContent = `${result.trackCount || (result.tracks || []).length} tracks`;
    document.getElementById('playlist-detail-source').textContent = result.source || '';

    // Apply source-specific badge styling
    const sourceBadge = document.getElementById('playlist-detail-source');
    if (sourceBadge) {
      sourceBadge.className = `playlist-source-badge source-${esc(result.source || '')}`;
      sourceBadge.textContent = result.source || '';
    }

    const coverImg = document.getElementById('playlist-cover-img');
    const coverPlaceholder = document.getElementById('playlist-cover-placeholder');
    if (result.coverUrl) {
      coverImg.src = result.coverUrl;
      coverImg.style.display = '';
      if (coverPlaceholder) coverPlaceholder.style.display = 'none';
    } else {
      coverImg.style.display = 'none';
      if (coverPlaceholder) coverPlaceholder.style.display = '';
    }

    // Assign original indices and store tracks
    const tracks = assignOriginalIndices(result.tracks || []);
    playlistState.currentTracks = tracks;

    // Apply current sort
    const sortSelect = document.getElementById('playlist-sort-select');
    if (sortSelect) sortSelect.value = playlistState.sortCriterion;

    // Update view mode toggle to reflect current preference
    const btnList = document.getElementById('btn-view-list');
    const btnCompact = document.getElementById('btn-view-compact');
    if (btnList) btnList.classList.toggle('active', playlistState.viewMode === 'list');
    if (btnCompact) btnCompact.classList.toggle('active', playlistState.viewMode === 'compact');

    playlistState.currentSortedTracks = sortTracks(tracks, playlistState.sortCriterion);
    renderPlaylistTracks();
  } catch (err) {
    if (trackListEl) {
      trackListEl.innerHTML = `<div class="empty-state"><div class="es-icon">😢</div><div class="es-text">Failed to load tracks</div><div class="es-sub">${esc(err.message)}</div></div>`;
    }
  }
};

function renderPlaylistTracks() {
  const trackListEl = document.getElementById('playlist-track-list');
  if (!trackListEl) return;

  const tracks = playlistState.currentSortedTracks;
  if (!tracks || !tracks.length) {
    trackListEl.innerHTML = '<div class="empty-state-small">No tracks in this playlist.</div>';
    return;
  }

  // Determine currently playing track title for highlighting
  const nowPlayingTitle = state.status?.current?.title || '';

  trackListEl.innerHTML = tracks.map((track, index) => {
    const isPlaying = nowPlayingTitle && track.title && nowPlayingTitle.toLowerCase().includes(track.title.toLowerCase());
    return renderTrackRow(track, index, playlistState.viewMode, isPlaying);
  }).join('');

  // Bind click handlers for play/queue buttons on each track row
  trackListEl.querySelectorAll('.playlist-track-row').forEach((row) => {
    const idx = parseInt(row.dataset.index, 10);
    const track = tracks[idx];
    if (!track) return;

    // Play on row click or thumbnail overlay click
    const thumbWrap = row.querySelector('.ptr-thumb-wrap');
    if (thumbWrap) {
      thumbWrap.onclick = (e) => {
        e.stopPropagation();
        playTrack(track);
      };
    }

    // Play button in compact mode
    const playBtn = row.querySelector('.ptr-play-btn');
    if (playBtn) {
      playBtn.onclick = (e) => {
        e.stopPropagation();
        playTrack(track);
      };
    }

    // Row double-click also plays
    row.ondblclick = () => {
      playTrack(track);
    };

    // Queue button
    const queueBtn = row.querySelector('.ptr-queue-btn');
    if (queueBtn) {
      queueBtn.onclick = (e) => {
        e.stopPropagation();
        addToQueue([track]);
      };
    }
  });
}

// ── Playlist playing indicator update ─────────────────────────────────────────

/**
 * Update the currently-playing indicator in the playlist detail view
 * without a full re-render. Called on every status-update poll event.
 * Compares now-playing title with track titles in the currently displayed list.
 * @param {object|null} status - Latest bot status
 */
function updatePlaylistPlayingIndicator(status) {
  // Only update if the playlist detail view is currently active
  const detailView = document.getElementById('view-playlist-detail');
  if (!detailView || !detailView.classList.contains('active')) return;

  const tracks = playlistState.currentSortedTracks;
  if (!tracks || !tracks.length) return;

  const nowPlayingTitle = status?.current?.title || '';
  const trackListEl = document.getElementById('playlist-track-list');
  if (!trackListEl) return;

  const rows = trackListEl.querySelectorAll('.playlist-track-row');
  rows.forEach((row) => {
    const idx = parseInt(row.dataset.index, 10);
    const track = tracks[idx];
    if (!track) return;

    const isPlaying = nowPlayingTitle && track.title &&
      nowPlayingTitle.toLowerCase().includes(track.title.toLowerCase());

    if (isPlaying) {
      row.classList.add('is-playing');
    } else {
      row.classList.remove('is-playing');
    }
  });
}

// ── Playlist removal (Task 10.2) ─────────────────────────────────────────────

window.__removePlaylist = async (event, playlistId) => {
  event.stopPropagation(); // Prevent opening the playlist detail
  if (!confirm('Are you sure you want to remove this playlist?')) return;

  try {
    await window.scify.playlistRemove(playlistId);
    toast('Playlist removed.', 'success');
    loadPlaylistLibrary();
  } catch (err) {
    toast(err.message || 'Failed to remove playlist.', 'error');
  }
};

// ── Import playlist modal (Task 8.2) ─────────────────────────────────────────

function bindPlaylistImportModal() {
  const modal = document.getElementById('playlist-import-modal');
  const urlInput = document.getElementById('playlist-import-url');
  const sourceBadge = document.getElementById('playlist-import-source-badge');
  const sourceText = document.getElementById('playlist-import-source-text');
  const feedback = document.getElementById('playlist-import-feedback');
  const confirmBtn = document.getElementById('btn-confirm-import');
  const cancelBtn = document.getElementById('btn-cancel-import');
  const closeBtn = document.getElementById('btn-close-import-modal');
  const openBtn = document.getElementById('btn-open-import-dialog');

  if (!modal) return;

  // Open the modal
  if (openBtn) {
    openBtn.onclick = () => {
      modal.style.display = 'flex';
      if (urlInput) urlInput.value = '';
      if (sourceBadge) sourceBadge.style.display = 'none';
      if (feedback) { feedback.textContent = ''; feedback.style.color = ''; }
      if (confirmBtn) confirmBtn.disabled = false;
    };
  }

  // Close / Cancel
  const closeModal = () => {
    modal.style.display = 'none';
    if (urlInput) urlInput.value = '';
    if (sourceBadge) sourceBadge.style.display = 'none';
    if (feedback) { feedback.innerHTML = ''; feedback.textContent = ''; feedback.style.color = ''; }
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.textContent = 'Import'; }
  };

  if (closeBtn) closeBtn.onclick = closeModal;
  if (cancelBtn) cancelBtn.onclick = closeModal;

  // Auto-detect source from URL pattern
  if (urlInput) {
    urlInput.addEventListener('input', () => {
      const url = urlInput.value.trim();
      const detected = detectPlaylistSource(url);
      if (detected && sourceBadge && sourceText) {
        sourceText.textContent = detected === 'spotify' ? '💚 Spotify' : '▶️ YouTube';
        sourceBadge.className = 'playlist-import-source-badge ' + detected;
        sourceBadge.style.display = '';
      } else if (sourceBadge) {
        sourceBadge.style.display = 'none';
      }
    });
  }

  // Confirm import
  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const url = (urlInput?.value || '').trim();
      if (!url) {
        showImportFeedback('Please enter a playlist URL.', 'error');
        toast('Please enter a playlist URL.', 'error');
        return;
      }

      const source = detectPlaylistSource(url);
      if (!source) {
        showImportFeedback('Could not detect source. Please paste a valid Spotify or YouTube playlist URL.', 'error');
        toast('Invalid URL. Use a Spotify or YouTube playlist link.', 'error');
        return;
      }

      // Loading state with spinner
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Importing…';
      showImportFeedback('<div class="loading-spinner" style="padding:8px 0;justify-content:flex-start;"><div class="spinner"></div>Importing playlist…</div>', 'loading');

      try {
        let result;
        if (source === 'spotify') {
          result = await window.scify.playlistImportSpotify(url);
        } else {
          result = await window.scify.playlistImportYoutube(url);
        }

        if (result && result.ok !== false) {
          const name = result.playlist?.name || result.name || 'playlist';
          const count = result.playlist?.trackCount || result.trackCount || 0;
          showImportFeedback('Playlist imported successfully!', 'success');
          toast(`Imported ${count} tracks from '${name}' ✓`, 'success');
          // Close modal after brief delay, then refresh library
          setTimeout(() => {
            closeModal();
            confirmBtn.textContent = 'Import';
            loadPlaylistLibrary();
          }, 1000);
        } else {
          const errMsg = result?.error || 'Import failed.';
          showImportFeedback(errMsg, 'error');
          toast(errMsg, 'error');
          confirmBtn.disabled = false;
          confirmBtn.textContent = 'Import';
        }
      } catch (err) {
        const errMsg = err.message || 'Import failed.';
        showImportFeedback(errMsg, 'error');
        toast(errMsg, 'error');
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Import';
      }
    };
  }

  function showImportFeedback(msg, type) {
    if (!feedback) return;
    if (type === 'loading') {
      feedback.innerHTML = msg;
      feedback.style.color = '';
    } else {
      feedback.innerHTML = '';
      feedback.textContent = msg;
      if (type === 'success') {
        feedback.style.color = '#22c55e';
      } else if (type === 'error') {
        feedback.style.color = '#ef4444';
      } else {
        feedback.style.color = 'var(--text-secondary)';
      }
    }
  }
}

/**
 * Detect playlist source from a URL pattern.
 * @param {string} url
 * @returns {'spotify' | 'youtube' | null}
 */
function detectPlaylistSource(url) {
  if (!url) return null;
  if (/open\.spotify\.com/i.test(url)) return 'spotify';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  return null;
}

// ── Create Playlist Modal ─────────────────────────────────────────────────────

function bindCreatePlaylistModal() {
  const modal = document.getElementById('create-playlist-modal');
  const nameInput = document.getElementById('create-playlist-name');
  const descInput = document.getElementById('create-playlist-desc');
  const feedback = document.getElementById('create-playlist-feedback');
  const confirmBtn = document.getElementById('btn-confirm-create-playlist');
  const cancelBtn = document.getElementById('btn-cancel-create-playlist');
  const closeBtn = document.getElementById('btn-close-create-modal');
  const openBtn = document.getElementById('btn-open-create-playlist');

  if (!modal) return;

  const openModal = () => {
    modal.style.display = 'flex';
    if (nameInput) nameInput.value = '';
    if (descInput) descInput.value = '';
    if (feedback) { feedback.textContent = ''; feedback.style.color = ''; }
    if (confirmBtn) confirmBtn.disabled = false;
    if (nameInput) nameInput.focus();
  };

  const closeModal = () => {
    modal.style.display = 'none';
  };

  if (openBtn) openBtn.onclick = openModal;
  if (closeBtn) closeBtn.onclick = closeModal;
  if (cancelBtn) cancelBtn.onclick = closeModal;

  if (confirmBtn) {
    confirmBtn.onclick = async () => {
      const name = (nameInput?.value || '').trim();
      if (!name) {
        if (feedback) { feedback.textContent = 'Name is required.'; feedback.style.color = '#ef4444'; }
        return;
      }
      confirmBtn.disabled = true;
      try {
        const result = await window.scify.playlistCreate(name, (descInput?.value || '').trim());
        if (result && result.ok) {
          toast(`Created playlist "${name}" ✓`, 'success');
          closeModal();
          loadPlaylistLibrary();
        } else {
          if (feedback) { feedback.textContent = result?.error || 'Failed to create.'; feedback.style.color = '#ef4444'; }
          confirmBtn.disabled = false;
        }
      } catch (err) {
        if (feedback) { feedback.textContent = err.message; feedback.style.color = '#ef4444'; }
        confirmBtn.disabled = false;
      }
    };
  }
}

// ── Liked Songs ──────────────────────────────────────────────────────────────

function bindLikedSongs() {
  // Nothing to bind at boot — the liked songs card is already clickable via onclick in HTML
}

/**
 * Open liked songs as a "playlist detail" view
 */
window.__openLikedSongs = async () => {
  playlistState.currentPlaylistId = '__liked__';

  // Show detail view
  showPlaylistDetail();

  const trackListEl = document.getElementById('playlist-track-list');
  if (trackListEl) {
    trackListEl.innerHTML = '<div class="loading-spinner"><div class="spinner"></div>Loading…</div>';
  }

  try {
    const liked = await window.scify.likedSongsGet();

    // Update header
    document.getElementById('playlist-detail-name').textContent = 'Liked Songs';
    document.getElementById('playlist-detail-count').textContent = `${liked.length} song${liked.length !== 1 ? 's' : ''}`;
    const sourceBadge = document.getElementById('playlist-detail-source');
    if (sourceBadge) {
      sourceBadge.className = 'playlist-source-badge';
      sourceBadge.textContent = '❤️';
    }

    // Hide remove button for liked songs
    const removeBtn = document.getElementById('btn-playlist-remove');
    if (removeBtn) removeBtn.style.display = 'none';

    const coverImg = document.getElementById('playlist-cover-img');
    const coverPlaceholder = document.getElementById('playlist-cover-placeholder');
    if (coverImg) coverImg.style.display = 'none';
    if (coverPlaceholder) { coverPlaceholder.style.display = ''; coverPlaceholder.textContent = '❤️'; }

    // Assign original indices
    const tracks = assignOriginalIndices(liked.map((t) => ({
      title: t.title || '',
      artist: t.artist || '',
      album: t.album || '',
      durationMs: t.durationMs || 0,
      thumbnail: t.thumbnail || null,
      query: t.query || '',
      addedAt: t.addedAt || 0,
    })));

    playlistState.currentTracks = tracks;

    const sortSelect = document.getElementById('playlist-sort-select');
    if (sortSelect) sortSelect.value = playlistState.sortCriterion;

    const btnList = document.getElementById('btn-view-list');
    const btnCompact = document.getElementById('btn-view-compact');
    if (btnList) btnList.classList.toggle('active', playlistState.viewMode === 'list');
    if (btnCompact) btnCompact.classList.toggle('active', playlistState.viewMode === 'compact');

    playlistState.currentSortedTracks = sortTracks(tracks, playlistState.sortCriterion);
    renderPlaylistTracks();
  } catch (err) {
    if (trackListEl) {
      trackListEl.innerHTML = `<div class="empty-state"><div class="es-icon">😢</div><div class="es-text">Failed to load liked songs</div><div class="es-sub">${esc(err.message)}</div></div>`;
    }
  }
};

// ── Add to Playlist / Like functionality for search results ──────────────────

/**
 * Show add-to-playlist dropdown for a search result card
 */
window.__showAddToPlaylist = async (event, cardId) => {
  event.stopPropagation();
  // Close any existing dropdown
  document.querySelectorAll('.add-to-playlist-dropdown').forEach((d) => d.remove());

  const track = window.__searchCards?.[cardId];
  if (!track) return;

  const btn = event.currentTarget;
  const wrap = btn.parentElement;

  // Fetch all playlists
  let playlists = [];
  try {
    playlists = await window.scify.playlistGetAll();
  } catch { /* ignore */ }

  const dropdown = document.createElement('div');
  dropdown.className = 'add-to-playlist-dropdown';

  if (!playlists.length) {
    dropdown.innerHTML = '<div class="add-to-playlist-dropdown-item"><span class="atpd-name" style="color:var(--text-muted)">No playlists yet</span></div>';
  } else {
    dropdown.innerHTML = playlists.map((p) => `
      <div class="add-to-playlist-dropdown-item" data-playlist-id="${esc(p.id)}">
        <span class="atpd-icon">${p.source === 'custom' ? '📝' : (p.source === 'spotify' ? '💚' : '▶️')}</span>
        <span class="atpd-name">${esc(p.name)}</span>
      </div>
    `).join('');
  }

  wrap.appendChild(dropdown);

  // Bind click on each item
  dropdown.querySelectorAll('.add-to-playlist-dropdown-item[data-playlist-id]').forEach((item) => {
    item.onclick = async (e) => {
      e.stopPropagation();
      const playlistId = item.dataset.playlistId;
      const playlistName = item.querySelector('.atpd-name')?.textContent || 'playlist';

      const trackToAdd = {
        title: track.title || '',
        artist: track.artist || '',
        album: '',
        query: track.url || `${track.artist || ''} - ${track.title || ''}`,
        durationMs: (track.durationSec || track.durationInSec || 0) * 1000,
        thumbnail: track.thumbnail || null,
        addedAt: Date.now(),
      };

      try {
        const res = await window.scify.playlistAddTrack(playlistId, trackToAdd);
        if (res.ok) {
          toast(`Added to "${playlistName}" ✓`, 'success');
        } else {
          toast(res.error || 'Failed to add track.', 'error');
        }
      } catch (err) {
        toast(err.message, 'error');
      }
      dropdown.remove();
    };
  });

  // Close dropdown on outside click
  const closeDropdown = (e) => {
    if (!dropdown.contains(e.target) && e.target !== btn) {
      dropdown.remove();
      document.removeEventListener('click', closeDropdown);
    }
  };
  setTimeout(() => document.addEventListener('click', closeDropdown), 10);
};

/**
 * Toggle like status for a search result card
 */
window.__toggleLike = async (event, cardId) => {
  event.stopPropagation();
  const track = window.__searchCards?.[cardId];
  if (!track) return;

  const btn = event.currentTarget;
  const query = track.url || `${track.artist || ''} - ${track.title || ''}`;

  try {
    const { liked } = await window.scify.likedSongsCheck(query);
    if (liked) {
      await window.scify.likedSongsRemove(query);
      btn.classList.remove('liked');
      btn.textContent = '🤍';
      toast('Removed from Liked Songs', 'success');
    } else {
      const trackToLike = {
        title: track.title || '',
        artist: track.artist || '',
        album: '',
        query,
        durationMs: (track.durationSec || track.durationInSec || 0) * 1000,
        thumbnail: track.thumbnail || null,
        addedAt: Date.now(),
      };
      await window.scify.likedSongsAdd(trackToLike);
      btn.classList.add('liked');
      btn.textContent = '❤️';
      toast('Added to Liked Songs ❤️', 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
};

/**
 * Toggle like for the currently playing track (from mini-bar)
 */
window.__toggleNowPlayingLike = async () => {
  const current = state.status?.current;
  if (!current || !current.title) {
    toast('Nothing is playing right now.', 'error');
    return;
  }

  const query = current.url || current.title;
  const btn = document.getElementById('mini-like-btn');

  try {
    const { liked } = await window.scify.likedSongsCheck(query);
    if (liked) {
      await window.scify.likedSongsRemove(query);
      if (btn) { btn.classList.remove('liked'); btn.textContent = '🤍'; }
      toast('Removed from Liked Songs', 'success');
    } else {
      const trackToLike = {
        title: current.title || '',
        artist: current.requestedBy || '',
        album: '',
        query,
        durationMs: (state.status?.durationSec || 0) * 1000,
        thumbnail: current.thumbnail || null,
        addedAt: Date.now(),
      };
      await window.scify.likedSongsAdd(trackToLike);
      if (btn) { btn.classList.add('liked'); btn.textContent = '❤️'; }
      toast('Added to Liked Songs ❤️', 'success');
    }
  } catch (err) {
    toast(err.message, 'error');
  }
};

// ── Persist view preferences ─────────────────────────────────────────────────

function persistViewPrefs() {
  window.scify.playlistSetViewMode({
    viewMode: playlistState.viewMode,
    sortCriterion: playlistState.sortCriterion,
  }).catch(() => {});
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function formatTime(secs) {
  if (!secs || secs < 0) return '0:00';
  const m = Math.floor(secs / 60);
  const s = String(Math.floor(secs % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Toast notifications ───────────────────────────────────────────────────────
function injectToastContainer() {
  const el = document.createElement('div');
  el.id = 'toast-container';
  document.body.appendChild(el);
}

function toast(message, type = '') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Start ─────────────────────────────────────────────────────────────────────
boot().catch(console.error);
