/**
 * Proposed Tunarr integration regression tests. NOT executed against the local fork here.
 * Copy into server/src/stream/hls/ beside HlsPlaylistMutator.ts in an isolated
 * repair worktree, after comparing that implementation with the review.
 * Use the repository's existing Vitest command from server/.
 * No network, media, scheduler or application restart is required.
 */
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import { HlsPlaylistMutator } from './HlsPlaylistMutator.ts';

const origin = dayjs('2026-09-18T12:00:00.000-05:00');
const defaults = {
  maxSegmentsToKeep: 10,
  targetDuration: 4,
  endWithDiscontinuity: false,
};

function fixture(count: number, discontinuityBefore: number[] = []): string[] {
  const boundaries = new Set(discontinuityBefore);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
  ];
  for (let n = 0; n < count; n++) {
    if (boundaries.has(n)) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(
      '#EXTINF:4.000000,',
      `#EXT-X-PROGRAM-DATE-TIME:${origin.add(n * 4, 'seconds').toISOString()}`,
      `/stream/channels/test/hls/data${String(n).padStart(6, '0')}.ts`,
    );
  }
  return lines;
}

function selector(anchor: number, floor = 0) {
  return {
    type: 'before_segment_number' as const,
    segmentNumber: anchor,
    segmentsToKeepBefore: 0,
    segmentFloor: floor,
  };
}

function segments(playlist: string) {
  let sequence = 0;
  let discontinuity = 0;
  const entries = new Map<number, { uri: string; discontinuity: number }>();
  for (const line of playlist.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      sequence = Number(line.split(':')[1]);
    } else if (line.startsWith('#EXT-X-DISCONTINUITY-SEQUENCE:')) {
      discontinuity = Number(line.split(':')[1]);
    } else if (line === '#EXT-X-DISCONTINUITY') {
      discontinuity++;
    } else if (line.trim() && !line.startsWith('#')) {
      entries.set(sequence++, { uri: line, discontinuity });
    }
  }
  return entries;
}

function fileNumbers(playlist: string): number[] {
  return [...segments(playlist).values()].map(({ uri }) => {
    const match = /data(\d+)\.ts$/.exec(uri);
    if (!match) throw new Error(`Unexpected test segment URI: ${uri}`);
    return Number(match[1]);
  });
}

describe('HLS playlist identity and physical-floor invariants', () => {
  it('counts all removed boundaries, rather than limiting the increment to one', () => {
    const result = new HlsPlaylistMutator().trimPlaylist(
      origin,
      selector(8),
      fixture(18, [2, 4, 6]),
      { ...defaults, previousDiscontinuitySequence: 0 },
    );
    expect(result.sequence).toBe(8);
    expect(result.discontinuitySequence).toBe(3);
    expect(segments(result.playlist).get(8)?.discontinuity).toBe(3);
  });

  it('does not change the same snapshot solely because another GET happened', () => {
    const mutator = new HlsPlaylistMutator();
    const input = fixture(18, [2, 4, 6]);
    let previous = 0;
    const snapshots: string[] = [];
    for (let poll = 0; poll < 3; poll++) {
      const result = mutator.trimPlaylist(origin, selector(8), input, {
        ...defaults,
        previousDiscontinuitySequence: previous,
      });
      previous = result.discontinuitySequence;
      snapshots.push(result.playlist);
    }
    expect(new Set(snapshots).size).toBe(1);
    expect(previous).toBe(3);
  });

  it('keeps the discontinuity identity of overlapping media unchanged', () => {
    const mutator = new HlsPlaylistMutator();
    const input = fixture(18, [2, 4, 6]);
    const first = mutator.trimPlaylist(origin, selector(0), input, defaults);
    const next = mutator.trimPlaylist(origin, selector(8), input, {
      ...defaults,
      previousDiscontinuitySequence: first.discontinuitySequence,
    });
    const a = segments(first.playlist);
    const b = segments(next.playlist);
    expect(a.has(8)).toBe(true);
    expect(b.has(8)).toBe(true);
    for (const [number, before] of a) {
      const after = b.get(number);
      if (after) expect(after).toEqual(before);
    }
  });

  it('does not invent a trailing boundary to conceal a sequence-number jump', () => {
    const result = new HlsPlaylistMutator().trimPlaylist(
      origin,
      selector(8),
      fixture(18, [2, 4, 6]),
      { ...defaults, previousDiscontinuitySequence: 0 },
    );
    expect(result.playlist.trim().split('\n').at(-1)).not.toBe(
      '#EXT-X-DISCONTINUITY',
    );
  });

  it('[PL09] never pads a short filtered result with files below the physical floor', () => {
    const result = new HlsPlaylistMutator().trimPlaylist(
      origin,
      selector(12, 12),
      fixture(16),
      defaults,
    );
    expect(fileNumbers(result.playlist)).toEqual([12, 13, 14, 15]);
  });

  it('applies the physical floor even before a playlist reaches the window size', () => {
    const result = new HlsPlaylistMutator().trimPlaylist(
      origin,
      selector(5, 5),
      fixture(8),
      defaults,
    );
    expect(fileNumbers(result.playlist)).toEqual([5, 6, 7]);
  });

  it('returns no removed files when the physical floor is beyond the snapshot', () => {
    // The HTTP/session layer must handle this not-ready result separately;
    // an empty result must not be published as a healthy playable manifest.
    const result = new HlsPlaylistMutator().trimPlaylist(
      origin,
      selector(20, 20),
      fixture(16),
      defaults,
    );
    expect(fileNumbers(result.playlist)).toEqual([]);
  });

  it('preserves ordinary one-boundary sequence accounting', () => {
    const result = new HlsPlaylistMutator().trimPlaylist(
      origin,
      selector(8),
      fixture(18, [2]),
      { ...defaults, previousDiscontinuitySequence: 0 },
    );
    expect(result.discontinuitySequence).toBe(1);
    expect(result.segmentCount).toBe(10);
  });
});
