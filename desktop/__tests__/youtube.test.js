import { describe, it, expect, vi } from 'vitest';
import { fetchYouTubePlaylist } from '../youtube.js';

describe('fetchYouTubePlaylist', () => {
  const validUrl = 'https://www.youtube.com/playlist?list=PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf';

  const mockApiResponse = {
    playlistId: 'PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf',
    title: 'My Playlist',
    thumbnail: 'https://i.ytimg.com/vi/xxx/hqdefault.jpg',
    tracks: [
      {
        title: 'Song One',
        artist: 'Artist A',
        channel: 'Artist A',
        durationSec: 180,
        url: 'https://youtube.com/watch?v=abc123',
        thumbnail: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
      },
      {
        title: 'Song Two',
        artist: '',
        channel: 'Channel B',
        durationSec: 240,
        url: 'https://youtube.com/watch?v=def456',
        thumbnail: null,
      },
    ],
  };

  it('throws for invalid URLs', async () => {
    const apiRequest = vi.fn();

    await expect(fetchYouTubePlaylist('not-a-url', apiRequest)).rejects.toThrow(
      'Invalid YouTube playlist URL',
    );
    await expect(fetchYouTubePlaylist('https://example.com', apiRequest)).rejects.toThrow(
      'Invalid YouTube playlist URL',
    );
    await expect(
      fetchYouTubePlaylist('https://www.youtube.com/watch?v=abc', apiRequest),
    ).rejects.toThrow('Invalid YouTube playlist URL');
    await expect(fetchYouTubePlaylist('', apiRequest)).rejects.toThrow(
      'Invalid YouTube playlist URL',
    );
    await expect(fetchYouTubePlaylist(null, apiRequest)).rejects.toThrow(
      'Invalid YouTube playlist URL',
    );

    expect(apiRequest).not.toHaveBeenCalled();
  });

  it('accepts valid YouTube playlist URLs', async () => {
    const apiRequest = vi.fn().mockResolvedValue(mockApiResponse);

    const result = await fetchYouTubePlaylist(validUrl, apiRequest);
    expect(result).toBeDefined();
    expect(apiRequest).toHaveBeenCalledWith('POST', '/resolve-playlist', { url: validUrl });
  });

  it('maps response into StoredPlaylist schema correctly', async () => {
    const apiRequest = vi.fn().mockResolvedValue(mockApiResponse);

    const result = await fetchYouTubePlaylist(validUrl, apiRequest);

    expect(result.id).toBe('PLrAXtmErZgOeiKm4sgNOknGvNjby9efdf');
    expect(result.name).toBe('My Playlist');
    expect(result.description).toBe('');
    expect(result.coverUrl).toBe('https://i.ytimg.com/vi/xxx/hqdefault.jpg');
    expect(result.source).toBe('youtube');
    expect(result.sourceUrl).toBe(validUrl);
    expect(result.trackCount).toBe(2);
    expect(result.syncedAt).toBeTypeOf('number');
    expect(result.tracks).toHaveLength(2);
  });

  it('maps tracks with correct fields', async () => {
    const apiRequest = vi.fn().mockResolvedValue(mockApiResponse);

    const result = await fetchYouTubePlaylist(validUrl, apiRequest);
    const [track1, track2] = result.tracks;

    // Track 1: has artist
    expect(track1.title).toBe('Song One');
    expect(track1.artist).toBe('Artist A');
    expect(track1.album).toBe('');
    expect(track1.durationMs).toBe(180000);
    expect(track1.thumbnail).toBe('https://i.ytimg.com/vi/abc123/hqdefault.jpg');
    expect(track1.query).toBe('https://youtube.com/watch?v=abc123');
    expect(track1.addedAt).toBeTypeOf('number');

    // Track 2: no artist, falls back to channel
    expect(track2.title).toBe('Song Two');
    expect(track2.artist).toBe('Channel B');
    expect(track2.album).toBe('');
    expect(track2.durationMs).toBe(240000);
    expect(track2.thumbnail).toBeNull();
    expect(track2.query).toBe('https://youtube.com/watch?v=def456');
  });

  it('uses "artist - title" as query when track URL is missing', async () => {
    const responseNoUrl = {
      ...mockApiResponse,
      tracks: [
        { title: 'My Song', artist: 'Some Artist', channel: 'Some Artist', durationSec: 200 },
      ],
    };
    const apiRequest = vi.fn().mockResolvedValue(responseNoUrl);

    const result = await fetchYouTubePlaylist(validUrl, apiRequest);
    expect(result.tracks[0].query).toBe('Some Artist - My Song');
  });

  it('throws descriptive error when API call fails', async () => {
    const apiRequest = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(fetchYouTubePlaylist(validUrl, apiRequest)).rejects.toThrow(
      'Could not load YouTube playlist',
    );
  });

  it('throws when API returns unexpected structure', async () => {
    const apiRequest = vi.fn().mockResolvedValue({ unexpected: 'data' });

    await expect(fetchYouTubePlaylist(validUrl, apiRequest)).rejects.toThrow(
      'YouTube playlist could not be resolved',
    );
  });

  it('handles music.youtube.com URLs', async () => {
    const musicUrl = 'https://music.youtube.com/playlist?list=PLtest123';
    const apiRequest = vi.fn().mockResolvedValue(mockApiResponse);

    const result = await fetchYouTubePlaylist(musicUrl, apiRequest);
    expect(result).toBeDefined();
    expect(apiRequest).toHaveBeenCalledWith('POST', '/resolve-playlist', { url: musicUrl });
  });

  it('defaults name to "Untitled Playlist" when title is empty', async () => {
    const noTitleResponse = { ...mockApiResponse, title: '' };
    const apiRequest = vi.fn().mockResolvedValue(noTitleResponse);

    const result = await fetchYouTubePlaylist(validUrl, apiRequest);
    expect(result.name).toBe('Untitled Playlist');
  });

  it('handles tracks with missing duration', async () => {
    const response = {
      ...mockApiResponse,
      tracks: [{ title: 'No Duration', artist: 'A', channel: 'A', url: 'https://youtube.com/watch?v=x' }],
    };
    const apiRequest = vi.fn().mockResolvedValue(response);

    const result = await fetchYouTubePlaylist(validUrl, apiRequest);
    expect(result.tracks[0].durationMs).toBe(0);
  });
});
