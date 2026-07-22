import { describe, it, expect } from 'vitest';

const { formatDuration, renderTrackRow, renderPlaylistHeader } = await import('../renderer/playlistRender.js');

// ── formatDuration tests ──────────────────────────────────────────────────────
describe('formatDuration', () => {
  it('formats 0 ms as "0:00"', () => {
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats 180000 ms (3 minutes) as "3:00"', () => {
    expect(formatDuration(180000)).toBe('3:00');
  });

  it('formats 65000 ms (1 min 5 sec) as "1:05"', () => {
    expect(formatDuration(65000)).toBe('1:05');
  });

  it('formats null/undefined as "0:00"', () => {
    expect(formatDuration(null)).toBe('0:00');
    expect(formatDuration(undefined)).toBe('0:00');
  });

  it('formats negative values as "0:00"', () => {
    expect(formatDuration(-5000)).toBe('0:00');
  });

  it('formats 59999 ms as "0:59"', () => {
    expect(formatDuration(59999)).toBe('0:59');
  });
});

// ── renderTrackRow — List mode ────────────────────────────────────────────────
describe('renderTrackRow — List mode', () => {
  const track = {
    title: 'Espresso',
    artist: 'Sabrina Carpenter',
    album: 'Short n\' Sweet',
    durationMs: 175000,
    thumbnail: 'https://example.com/thumb.jpg',
  };

  it('includes thumbnail img element', () => {
    const html = renderTrackRow(track, 0, 'list', false);
    expect(html).toContain('<img');
    expect(html).toContain('ptr-thumb-img');
    expect(html).toContain('https://example.com/thumb.jpg');
    expect(html).toContain('width="48"');
    expect(html).toContain('height="48"');
  });

  it('includes title, artist, album, and duration', () => {
    const html = renderTrackRow(track, 0, 'list', false);
    expect(html).toContain('Espresso');
    expect(html).toContain('Sabrina Carpenter');
    expect(html).toContain('Short n&#039; Sweet');
    expect(html).toContain('2:55');
  });

  it('uses playlist-track-row class for styling (height controlled by CSS)', () => {
    const html = renderTrackRow(track, 0, 'list', false);
    expect(html).toContain('playlist-track-row');
    // Height is 56px via CSS .playlist-track-row rule, not inline
    expect(html).not.toContain('compact');
  });

  it('includes play overlay and add-to-queue button', () => {
    const html = renderTrackRow(track, 0, 'list', false);
    expect(html).toContain('ptr-play-overlay');
    expect(html).toContain('ptr-queue-btn');
  });

  it('renders empty album span when album is empty', () => {
    const noAlbumTrack = { ...track, album: '' };
    const html = renderTrackRow(noAlbumTrack, 0, 'list', false);
    expect(html).toContain('ptr-album');
    // Album span exists but is empty
    expect(html).toContain('<span class="ptr-album"></span>');
  });
});

// ── renderTrackRow — Compact mode ─────────────────────────────────────────────
describe('renderTrackRow — Compact mode', () => {
  const track = {
    title: 'Espresso',
    artist: 'Sabrina Carpenter',
    album: 'Short n\' Sweet',
    durationMs: 175000,
    thumbnail: 'https://example.com/thumb.jpg',
  };

  it('includes title, artist, and duration', () => {
    const html = renderTrackRow(track, 0, 'compact', false);
    expect(html).toContain('Espresso');
    expect(html).toContain('Sabrina Carpenter');
    expect(html).toContain('2:55');
  });

  it('does NOT include thumbnail img element', () => {
    const html = renderTrackRow(track, 0, 'compact', false);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('ptr-thumb-img');
  });

  it('uses compact class for styling (height controlled by CSS)', () => {
    const html = renderTrackRow(track, 0, 'compact', false);
    expect(html).toContain('playlist-track-row compact');
    // Height is 36px via CSS .playlist-track-row.compact rule, not inline
  });

  it('includes add-to-queue button', () => {
    const html = renderTrackRow(track, 0, 'compact', false);
    expect(html).toContain('ptr-queue-btn');
  });
});

// ── renderTrackRow — Playing indicator ────────────────────────────────────────
describe('renderTrackRow — Playing indicator', () => {
  const track = {
    title: 'Test Track',
    artist: 'Test Artist',
    album: '',
    durationMs: 120000,
    thumbnail: null,
  };

  it('adds "is-playing" class when isPlaying is true', () => {
    const html = renderTrackRow(track, 0, 'list', true);
    expect(html).toContain('is-playing');
  });

  it('does not add "is-playing" class when isPlaying is false', () => {
    const html = renderTrackRow(track, 0, 'list', false);
    expect(html).not.toContain('is-playing');
  });

  it('adds "is-playing" class in compact mode when isPlaying is true', () => {
    const html = renderTrackRow(track, 0, 'compact', true);
    expect(html).toContain('is-playing');
  });
});

// ── renderPlaylistHeader ──────────────────────────────────────────────────────
describe('renderPlaylistHeader', () => {
  it('renders playlist name, track count, source badge, and cover', () => {
    const playlist = {
      name: 'Top Hits',
      coverUrl: 'https://example.com/cover.jpg',
      trackCount: 50,
      source: 'spotify',
    };
    const html = renderPlaylistHeader(playlist);
    expect(html).toContain('Top Hits');
    expect(html).toContain('50 tracks');
    expect(html).toContain('spotify');
    expect(html).toContain('https://example.com/cover.jpg');
    expect(html).toContain('<img');
  });

  it('renders placeholder when coverUrl is null', () => {
    const playlist = {
      name: 'My Playlist',
      coverUrl: null,
      trackCount: 10,
      source: 'youtube',
    };
    const html = renderPlaylistHeader(playlist);
    expect(html).toContain('My Playlist');
    expect(html).toContain('10 tracks');
    expect(html).toContain('youtube');
    expect(html).not.toContain('<img');
    expect(html).toContain('placeholder');
  });
});
