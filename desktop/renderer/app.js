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
  bindSpotify();
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

  if (name === 'spotify') {
    const tracksSection = document.getElementById('spotify-tracks-section');
    if (tracksSection && tracksSection.style.display !== 'block') {
      loadSpotifyPlaylists();
    }
  }

  if (name === 'queue') loadQueue();
  if (name === 'library') loadLibrary();
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
    </div>
  `;
}

window.playNow = async (id) => {
  const track = window.__searchCards?.[id];
  if (!track) return;
  await playQuery(track.url);
};

window.addToQueue = async (id) => {
  const track = window.__searchCards?.[id];
  if (!track) return;
  await playQuery(track.url);
};

async function playQuery(query) {
  const { guildId, channelId } = state.settings;
  if (!guildId || !channelId) {
    toast('Server not configured yet. Go to Settings and click "Load Servers" to pick your Discord server.', 'error');
    switchView('settings');
    return;
  }
  try {
    toast('Sending to bot…');
    const res = await window.scify.api.post('/play', { guildId, channelId, query });
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
  if (!queue.length) {
    list.innerHTML = '<div class="empty-state"><div class="es-icon">📋</div><div class="es-text">Queue is empty</div><div class="es-sub">Search for songs to add them here</div></div>';
    return;
  }

  list.innerHTML = queue.map((t, i) => `
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
    for (let i = queue.length - 1; i >= 0; i--) {
      await window.scify.api.post('/queue/remove', {
        guildId: state.settings.guildId,
        index: i,
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

// ── Spotify Sync ─────────────────────────────────────────────────────────────
function bindSpotify() {
  const addBtn = document.getElementById('btn-add-spotify');
  const urlInput = document.getElementById('spotify-url-input');
  const feedback = document.getElementById('spotify-feedback');
  const syncAllBtn = document.getElementById('btn-sync-all-spotify');
  const syncSingleBtn = document.getElementById('btn-sync-playlist');
  const closeTracksBtn = document.getElementById('btn-close-tracks');

  let activePlaylistId = null;

  if (addBtn) {
    addBtn.onclick = async () => {
      const url = urlInput.value.trim();
      if (!url) {
        showSpotifyFeedback('Please enter a Spotify playlist URL.', 'error');
        return;
      }
      showSpotifyFeedback('Fetching playlist tracks from Spotify (scraping)...');
      addBtn.disabled = true;
      try {
        const res = await window.scify.addSpotifyPlaylist(url);
        addBtn.disabled = false;
        if (res.ok) {
          urlInput.value = '';
          showSpotifyFeedback('Playlist added & synced successfully!', 'success');
          loadSpotifyPlaylists();
        } else {
          showSpotifyFeedback(res.error || 'Failed to add playlist.', 'error');
        }
      } catch (err) {
        addBtn.disabled = false;
        showSpotifyFeedback(err.message, 'error');
      }
    };
  }

  if (syncAllBtn) {
    syncAllBtn.onclick = async () => {
      toast('Syncing all Spotify playlists...');
      syncAllBtn.disabled = true;
      try {
        const res = await window.scify.syncSpotify();
        syncAllBtn.disabled = false;
        if (res.ok) {
          toast(`Synced ${res.synced} playlists!`, 'success');
          loadSpotifyPlaylists();
        } else {
          toast(`Sync failed: ${res.error}`, 'error');
        }
      } catch (err) {
        syncAllBtn.disabled = false;
        toast(err.message, 'error');
      }
    };
  }

  if (syncSingleBtn) {
    syncSingleBtn.onclick = async () => {
      if (!activePlaylistId) return;
      toast('Syncing playlist...');
      syncSingleBtn.disabled = true;
      try {
        const playlistsData = await window.scify.getSpotifyPlaylists();
        const playlist = playlistsData.playlists.find(p => p.id === activePlaylistId);
        if (playlist) {
          const res = await window.scify.addSpotifyPlaylist(playlist.url);
          syncSingleBtn.disabled = false;
          if (res.ok) {
            toast('Playlist synced!', 'success');
            viewPlaylistTracks(res.playlist);
            loadSpotifyPlaylists(); // update background grid too
          } else {
            toast(res.error || 'Failed to sync.', 'error');
          }
        }
      } catch (err) {
        syncSingleBtn.disabled = false;
        toast(err.message, 'error');
      }
    };
  }

  if (closeTracksBtn) {
    closeTracksBtn.onclick = () => {
      document.getElementById('spotify-tracks-section').style.display = 'none';
      document.getElementById('spotify-playlists-section').style.display = 'block';
      document.getElementById('spotify-url-input').parentElement.parentElement.style.display = 'block';
      activePlaylistId = null;
    };
  }

  window.viewPlaylist = async (id) => {
    const playlistsData = await window.scify.getSpotifyPlaylists();
    const playlist = playlistsData.playlists.find(p => p.id === id);
    if (playlist) {
      activePlaylistId = id;
      viewPlaylistTracks(playlist);
    }
  };

  window.deletePlaylist = async (e, id) => {
    e.stopPropagation(); // prevent card click
    if (!confirm('Are you sure you want to remove this playlist from Scify?')) return;
    try {
      await window.scify.removeSpotifyPlaylist(id);
      toast('Playlist removed.', 'success');
      loadSpotifyPlaylists();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  window.playSpotifyTrack = async (artist, title) => {
    await playQuery(`${artist} - ${title}`);
  };

  window.queueSpotifyTrack = async (artist, title) => {
    await playQuery(`${artist} - ${title}`);
  };

  function showSpotifyFeedback(msg, type = '') {
    feedback.textContent = msg;
    feedback.className = `spotify-feedback ${type}`;
    if (type === 'success') {
      feedback.style.color = '#22c55e';
    } else if (type === 'error') {
      feedback.style.color = '#ef4444';
    } else {
      feedback.style.color = 'var(--text-secondary)';
    }
  }
}

async function loadSpotifyPlaylists() {
  const grid = document.getElementById('spotify-playlists-grid');
  const syncAllBtn = document.getElementById('btn-sync-all-spotify');
  if (!grid) return;
  
  try {
    const data = await window.scify.getSpotifyPlaylists();
    const playlists = data.playlists || [];
    
    if (data.lastSync) {
      const syncTimeEl = document.getElementById('spotify-last-sync-time');
      if (syncTimeEl) {
        syncTimeEl.textContent = new Date(data.lastSync).toLocaleString();
      }
    }

    if (!playlists.length) {
      if (syncAllBtn) syncAllBtn.style.display = 'none';
      grid.innerHTML = `
        <div class="empty-state">
          <div class="es-icon">📻</div>
          <div class="es-text">No playlists synced yet</div>
          <div class="es-sub">Enter a public Spotify playlist link above to sync all its tracks.</div>
        </div>`;
      return;
    }

    if (syncAllBtn) syncAllBtn.style.display = 'block';

    grid.innerHTML = playlists.map((p) => `
      <div class="spotify-card" onclick="viewPlaylist('${p.id}')">
        ${p.coverUrl 
          ? `<img class="spotify-card-cover" src="${esc(p.coverUrl)}" alt="${esc(p.name)}" loading="lazy" />`
          : `<div class="spotify-card-cover-placeholder">📻</div>`}
        <div class="spotify-card-info">
          <div class="spotify-card-title">${esc(p.name)}</div>
          <div class="spotify-card-count">${p.trackCount || 0} tracks</div>
        </div>
        <div class="spotify-card-actions">
          <button class="spotify-card-btn delete" onclick="deletePlaylist(event, '${p.id}')">Delete</button>
        </div>
      </div>
    `).join('');

  } catch (err) {
    grid.innerHTML = `<div class="empty-state"><div class="es-icon">😢</div><div class="es-text">Failed to load playlists</div><div class="es-sub">${esc(err.message)}</div></div>`;
  }
}

function viewPlaylistTracks(playlist) {
  document.getElementById('spotify-playlists-section').style.display = 'none';
  document.getElementById('spotify-url-input').parentElement.parentElement.style.display = 'none';
  
  const section = document.getElementById('spotify-tracks-section');
  section.style.display = 'block';

  document.getElementById('active-playlist-title').textContent = playlist.name;
  document.getElementById('active-playlist-desc').textContent = playlist.description || 'No description';

  const trackList = document.getElementById('spotify-track-list');
  if (!playlist.tracks || !playlist.tracks.length) {
    trackList.innerHTML = '<div class="empty-state-small">No tracks found in this playlist.</div>';
    return;
  }

  trackList.innerHTML = playlist.tracks.map((t, i) => `
    <div class="track-row" ondblclick="playSpotifyTrack('${esc(t.artist)}', '${esc(t.title)}')">
      <div class="tr-num">${i + 1}</div>
      <div class="tr-play-icon" onclick="playSpotifyTrack('${esc(t.artist)}', '${esc(t.title)}')">▶</div>
      ${t.thumbnail
        ? `<img class="tr-thumb" src="${esc(t.thumbnail)}" alt="" loading="lazy" />`
        : `<div class="tr-thumb-placeholder">🎵</div>`}
      <div class="tr-info">
        <div class="tr-title">${esc(t.title)}</div>
        <div class="tr-by">by ${esc(t.artist)}</div>
      </div>
      <div class="tr-duration">${t.durationMs ? formatTime(t.durationMs / 1000) : '—'}</div>
      <button class="ghost-btn" style="padding: 4px 8px; font-size: 10px;" onclick="queueSpotifyTrack('${esc(t.artist)}', '${esc(t.title)}')">+ Queue</button>
    </div>
  `).join('');
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
