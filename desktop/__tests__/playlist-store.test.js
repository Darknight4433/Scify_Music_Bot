/**
 * Unit tests for playlist store functions (deserializePlaylist, upsertPlaylist).
 */
import { describe, it, expect } from 'vitest';
import { deserializePlaylist, upsertPlaylist } from '../playlistStore.js';

describe('deserializePlaylist', () => {
  it('returns null/undefined for null/undefined input', () => {
    expect(deserializePlaylist(null)).toBe(null);
    expect(deserializePlaylist(undefined)).toBe(undefined);
  });

  it('fills in all default values for a completely empty object', () => {
    const result = deserializePlaylist({});
    expect(result).toEqual({
      id: '',
      name: '',
      description: '',
      coverUrl: null,
      source: 'spotify',
      sourceUrl: '',
      trackCount: 0,
      tracks: [],
      syncedAt: 0,
    });
  });

  it('preserves valid playlist metadata fields', () => {
    const raw = {
      id: 'abc123',
      name: 'My Playlist',
      description: 'A cool playlist',
      coverUrl: 'https://example.com/cover.jpg',
      source: 'youtube',
      sourceUrl: 'https://youtube.com/playlist?list=abc123',
      trackCount: 2,
      tracks: [],
      syncedAt: 1700000000000,
    };
    const result = deserializePlaylist(raw);
    expect(result.id).toBe('abc123');
    expect(result.name).toBe('My Playlist');
    expect(result.description).toBe('A cool playlist');
    expect(result.coverUrl).toBe('https://example.com/cover.jpg');
    expect(result.source).toBe('youtube');
    expect(result.sourceUrl).toBe('https://youtube.com/playlist?list=abc123');
    expect(result.trackCount).toBe(2);
    expect(result.syncedAt).toBe(1700000000000);
  });

  it('fills in defaults for track fields that are missing', () => {
    const raw = {
      id: 'test',
      tracks: [{}],
    };
    const result = deserializePlaylist(raw);
    expect(result.tracks[0]).toEqual({
      title: '',
      artist: '',
      album: '',
      durationMs: 0,
      thumbnail: null,
      query: '',
      addedAt: 0,
    });
  });

  it('fills in defaults for track fields that are null', () => {
    const raw = {
      id: 'test',
      tracks: [{
        title: null,
        artist: null,
        album: null,
        durationMs: null,
        thumbnail: null,
        query: null,
        addedAt: null,
      }],
    };
    const result = deserializePlaylist(raw);
    expect(result.tracks[0]).toEqual({
      title: '',
      artist: '',
      album: '',
      durationMs: 0,
      thumbnail: null,
      query: '',
      addedAt: 0,
    });
  });

  it('preserves valid track fields', () => {
    const raw = {
      id: 'test',
      tracks: [{
        title: 'Espresso',
        artist: 'Sabrina Carpenter',
        album: 'Short n Sweet',
        durationMs: 175000,
        thumbnail: 'https://i.scdn.co/image/abc',
        query: 'Sabrina Carpenter - Espresso',
        addedAt: 1700000000000,
      }],
    };
    const result = deserializePlaylist(raw);
    expect(result.tracks[0]).toEqual({
      title: 'Espresso',
      artist: 'Sabrina Carpenter',
      album: 'Short n Sweet',
      durationMs: 175000,
      thumbnail: 'https://i.scdn.co/image/abc',
      query: 'Sabrina Carpenter - Espresso',
      addedAt: 1700000000000,
    });
  });

  it('computes trackCount from tracks array when trackCount field is missing', () => {
    const raw = {
      id: 'test',
      tracks: [{ title: 'A' }, { title: 'B' }, { title: 'C' }],
    };
    const result = deserializePlaylist(raw);
    expect(result.trackCount).toBe(3);
  });

  it('handles null coverUrl correctly (returns null)', () => {
    const raw = { id: 'test', coverUrl: null, tracks: [] };
    const result = deserializePlaylist(raw);
    expect(result.coverUrl).toBe(null);
  });

  it('handles numeric coverUrl (invalid type) as null', () => {
    const raw = { id: 'test', coverUrl: 12345, tracks: [] };
    const result = deserializePlaylist(raw);
    expect(result.coverUrl).toBe(null);
  });
});


describe('upsertPlaylist', () => {
  it('appends a new playlist when no matching ID exists', () => {
    const playlists = [{ id: 'existing', name: 'Existing' }];
    const newPlaylist = { id: 'new-one', name: 'New Playlist' };
    const result = upsertPlaylist(playlists, newPlaylist);
    expect(result).toHaveLength(2);
    expect(result[1]).toEqual(newPlaylist);
  });

  it('replaces an existing playlist with the same ID', () => {
    const playlists = [
      { id: 'abc', name: 'Old Name', trackCount: 5 },
      { id: 'def', name: 'Other' },
    ];
    const updated = { id: 'abc', name: 'New Name', trackCount: 10 };
    const result = upsertPlaylist(playlists, updated);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(updated);
    expect(result[1]).toEqual({ id: 'def', name: 'Other' });
  });

  it('does not mutate the original array', () => {
    const playlists = [{ id: 'abc', name: 'Original' }];
    const updated = { id: 'abc', name: 'Updated' };
    const result = upsertPlaylist(playlists, updated);
    expect(playlists[0].name).toBe('Original');
    expect(result[0].name).toBe('Updated');
  });

  it('handles empty playlists array', () => {
    const result = upsertPlaylist([], { id: 'first', name: 'First' });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('first');
  });
});
