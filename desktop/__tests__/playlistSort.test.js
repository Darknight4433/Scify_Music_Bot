import { describe, it, expect } from 'vitest';

// The module uses CJS exports for dual browser/Node compat.
// Vitest handles this via interop since package.json has "type": "module".
const { SORT_OPTIONS, sortTracks, assignOriginalIndices } = await import('../renderer/playlistSort.js');

describe('playlistSort', () => {
  describe('SORT_OPTIONS', () => {
    it('contains all six sort criteria', () => {
      expect(SORT_OPTIONS).toEqual([
        'custom', 'title', 'artist', 'album', 'recentlyAdded', 'duration',
      ]);
    });
  });

  describe('assignOriginalIndices', () => {
    it('assigns sequential originalIndex to each track', () => {
      const tracks = [
        { title: 'A' },
        { title: 'B' },
        { title: 'C' },
      ];
      const result = assignOriginalIndices(tracks);
      expect(result[0].originalIndex).toBe(0);
      expect(result[1].originalIndex).toBe(1);
      expect(result[2].originalIndex).toBe(2);
    });

    it('does not mutate the original tracks', () => {
      const tracks = [{ title: 'A' }];
      const result = assignOriginalIndices(tracks);
      expect(tracks[0].originalIndex).toBeUndefined();
      expect(result[0].originalIndex).toBe(0);
    });
  });

  describe('sortTracks', () => {
    it('returns an empty array for empty input', () => {
      expect(sortTracks([], 'title')).toEqual([]);
    });

    it('returns an empty array for null/undefined input', () => {
      expect(sortTracks(null, 'title')).toEqual([]);
      expect(sortTracks(undefined, 'title')).toEqual([]);
    });

    it('does not mutate the original array', () => {
      const tracks = [
        { title: 'Banana', originalIndex: 0 },
        { title: 'Apple', originalIndex: 1 },
      ];
      const sorted = sortTracks(tracks, 'title');
      expect(tracks[0].title).toBe('Banana');
      expect(sorted[0].title).toBe('Apple');
    });

    describe('custom sort (by originalIndex)', () => {
      it('sorts tracks by originalIndex ascending', () => {
        const tracks = [
          { title: 'C', originalIndex: 2 },
          { title: 'A', originalIndex: 0 },
          { title: 'B', originalIndex: 1 },
        ];
        const sorted = sortTracks(tracks, 'custom');
        expect(sorted.map(t => t.title)).toEqual(['A', 'B', 'C']);
      });

      it('treats missing originalIndex as 0', () => {
        const tracks = [
          { title: 'B', originalIndex: 1 },
          { title: 'A' },
        ];
        const sorted = sortTracks(tracks, 'custom');
        expect(sorted[0].title).toBe('A');
        expect(sorted[1].title).toBe('B');
      });
    });

    describe('title sort (locale-aware ascending)', () => {
      it('sorts tracks alphabetically by title', () => {
        const tracks = [
          { title: 'Cherry', originalIndex: 0 },
          { title: 'Apple', originalIndex: 1 },
          { title: 'Banana', originalIndex: 2 },
        ];
        const sorted = sortTracks(tracks, 'title');
        expect(sorted.map(t => t.title)).toEqual(['Apple', 'Banana', 'Cherry']);
      });

      it('handles case-insensitive comparison', () => {
        const tracks = [
          { title: 'banana', originalIndex: 0 },
          { title: 'Apple', originalIndex: 1 },
        ];
        const sorted = sortTracks(tracks, 'title');
        // localeCompare is case-insensitive by default in most locales
        expect(sorted[0].title.toLowerCase()).toBe('apple');
        expect(sorted[1].title.toLowerCase()).toBe('banana');
      });

      it('treats missing title as empty string', () => {
        const tracks = [
          { title: 'Zebra', originalIndex: 0 },
          { originalIndex: 1 },
        ];
        const sorted = sortTracks(tracks, 'title');
        expect(sorted[0].title || '').toBe('');
        expect(sorted[1].title).toBe('Zebra');
      });
    });

    describe('artist sort (locale-aware ascending)', () => {
      it('sorts tracks alphabetically by artist', () => {
        const tracks = [
          { title: 'Song1', artist: 'Zedd', originalIndex: 0 },
          { title: 'Song2', artist: 'Adele', originalIndex: 1 },
          { title: 'Song3', artist: 'Muse', originalIndex: 2 },
        ];
        const sorted = sortTracks(tracks, 'artist');
        expect(sorted.map(t => t.artist)).toEqual(['Adele', 'Muse', 'Zedd']);
      });

      it('treats missing artist as empty string', () => {
        const tracks = [
          { title: 'Song1', artist: 'Beyonce', originalIndex: 0 },
          { title: 'Song2', originalIndex: 1 },
        ];
        const sorted = sortTracks(tracks, 'artist');
        expect(sorted[0].artist || '').toBe('');
        expect(sorted[1].artist).toBe('Beyonce');
      });
    });

    describe('album sort (locale-aware ascending, empty albums at end)', () => {
      it('sorts tracks alphabetically by album with empty albums at the end', () => {
        const tracks = [
          { title: 'Song1', album: '', originalIndex: 0 },
          { title: 'Song2', album: 'Thriller', originalIndex: 1 },
          { title: 'Song3', album: 'Abbey Road', originalIndex: 2 },
          { title: 'Song4', album: '', originalIndex: 3 },
        ];
        const sorted = sortTracks(tracks, 'album');
        // Non-empty albums sorted first
        expect(sorted[0].album).toBe('Abbey Road');
        expect(sorted[1].album).toBe('Thriller');
        // Empty albums at end
        expect(sorted[2].album).toBe('');
        expect(sorted[3].album).toBe('');
      });

      it('treats null/undefined album as empty (sorts to end)', () => {
        const tracks = [
          { title: 'Song1', album: null, originalIndex: 0 },
          { title: 'Song2', album: 'Rumours', originalIndex: 1 },
          { title: 'Song3', originalIndex: 2 },
        ];
        const sorted = sortTracks(tracks, 'album');
        expect(sorted[0].album).toBe('Rumours');
        // Null/undefined albums at the end
        expect(sorted[1].album ?? '').toBe('');
        expect(sorted[2].album ?? '').toBe('');
      });
    });

    describe('recentlyAdded sort (addedAt descending)', () => {
      it('sorts tracks by addedAt descending (newest first)', () => {
        const tracks = [
          { title: 'Old', addedAt: 1000, originalIndex: 0 },
          { title: 'Newest', addedAt: 3000, originalIndex: 1 },
          { title: 'Middle', addedAt: 2000, originalIndex: 2 },
        ];
        const sorted = sortTracks(tracks, 'recentlyAdded');
        expect(sorted.map(t => t.title)).toEqual(['Newest', 'Middle', 'Old']);
      });

      it('treats missing addedAt as 0 (sorts to end)', () => {
        const tracks = [
          { title: 'Recent', addedAt: 5000, originalIndex: 0 },
          { title: 'Unknown', originalIndex: 1 },
        ];
        const sorted = sortTracks(tracks, 'recentlyAdded');
        expect(sorted[0].title).toBe('Recent');
        expect(sorted[1].title).toBe('Unknown');
      });
    });

    describe('duration sort (durationMs ascending)', () => {
      it('sorts tracks by durationMs ascending (shortest first)', () => {
        const tracks = [
          { title: 'Long', durationMs: 300000, originalIndex: 0 },
          { title: 'Short', durationMs: 120000, originalIndex: 1 },
          { title: 'Medium', durationMs: 200000, originalIndex: 2 },
        ];
        const sorted = sortTracks(tracks, 'duration');
        expect(sorted.map(t => t.title)).toEqual(['Short', 'Medium', 'Long']);
      });

      it('treats missing durationMs as 0 (sorts to front)', () => {
        const tracks = [
          { title: 'HasDuration', durationMs: 180000, originalIndex: 0 },
          { title: 'NoDuration', originalIndex: 1 },
        ];
        const sorted = sortTracks(tracks, 'duration');
        expect(sorted[0].title).toBe('NoDuration');
        expect(sorted[1].title).toBe('HasDuration');
      });
    });

    describe('unknown criterion', () => {
      it('returns a copy without sorting for unknown criteria', () => {
        const tracks = [
          { title: 'B', originalIndex: 1 },
          { title: 'A', originalIndex: 0 },
        ];
        const sorted = sortTracks(tracks, 'unknownCriterion');
        // Returns a copy (same order, different reference)
        expect(sorted).not.toBe(tracks);
        expect(sorted.map(t => t.title)).toEqual(['B', 'A']);
      });
    });
  });
});
