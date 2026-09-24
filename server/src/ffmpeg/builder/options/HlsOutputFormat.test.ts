import { FrameState } from '@/ffmpeg/builder/state/FrameState.js';
import { FrameDataLocation, FrameSize } from '@/ffmpeg/builder/types.js';
import { describe, expect, test } from 'vitest';
import { HlsOutputFormat } from './HlsOutputFormat.ts';

function makeFormat(
  isFirstTranscode: boolean,
  playlistPath = '/some/path/stream.m3u8',
  emitEndList = false,
) {
  const state = new FrameState({
    isAnamorphic: false,
    scaledSize: FrameSize.FHD,
    paddedSize: FrameSize.FHD,
    frameDataLocation: FrameDataLocation.Software,
  });
  return new HlsOutputFormat(
    state,
    24,
    playlistPath,
    '/some/path/data%06d.ts',
    '/stream/channels/test-uuid/hls/',
    isFirstTranscode,
    false,
    emitEndList,
  );
}

describe('HlsOutputFormat', () => {
  test('includes -master_pl_name playlist.m3u8 for first transcode', () => {
    const opts = makeFormat(true).options();
    const idx = opts.indexOf('-master_pl_name');
    expect(idx).toBeGreaterThan(-1);
    expect(opts[idx + 1]).toBe('playlist.m3u8');
  });

  test('includes -master_pl_name playlist.m3u8 for subsequent transcodes', () => {
    const opts = makeFormat(false).options();
    const idx = opts.indexOf('-master_pl_name');
    expect(idx).toBeGreaterThan(-1);
    expect(opts[idx + 1]).toBe('playlist.m3u8');
  });

  test('-master_pl_name appears before the output path', () => {
    const playlistPath = '/some/path/stream.m3u8';
    const opts = makeFormat(true, playlistPath).options();
    const masterIdx = opts.indexOf('-master_pl_name');
    const outputIdx = opts.lastIndexOf(playlistPath);
    expect(masterIdx).toBeGreaterThan(-1);
    expect(outputIdx).toBeGreaterThan(-1);
    expect(masterIdx).toBeLessThan(outputIdx);
  });

  // PL12 — "Live presentation remains open; no per-program ENDLIST/channel
  // shutdown." A linear channel is a single continuous presentation, so the
  // playlist must never carry ENDLIST and the segment list must never be capped.
  test('[PL12] a live producer never ends the presentation and never caps its segment list', () => {
    const opts = makeFormat(true).options();

    const flagsIndex = opts.indexOf('-hls_flags');
    expect(flagsIndex).toBeGreaterThan(-1);
    // omit_endlist means no ENDLIST tag is ever written, so a player is never
    // told the presentation finished at a programme boundary.
    expect(opts[flagsIndex + 1]).toContain('omit_endlist');
    expect(opts[flagsIndex + 1]).not.toContain('ENDLIST');

    // -hls_list_size 0: ffmpeg does not drop segments out of the list itself.
    // Retention is then a decision made by the playlist mutator against the
    // published window, not something the muxer does behind its back.
    const listIndex = opts.indexOf('-hls_list_size');
    expect(listIndex).toBeGreaterThan(-1);
    expect(opts[listIndex + 1]).toBe('0');

    // And it is still a live stream, not an on-demand one.
    const segmentFlagsIndex = opts.indexOf('-segment_list_flags');
    expect(segmentFlagsIndex).toBeGreaterThan(-1);
    expect(opts[segmentFlagsIndex + 1]).toBe('+live');
  });

  test('[PL12] ending a presentation is opt-in, so it cannot happen by default', () => {
    // The only way to get a closing presentation is for a caller to ask for it
    // explicitly; every live producer constructs this with the default.
    const opts = makeFormat(true, '/some/path/stream.m3u8', true).options();
    const flagsIndex = opts.indexOf('-hls_flags');
    expect(flagsIndex).toBeGreaterThan(-1);
    expect(opts[flagsIndex + 1]).not.toContain('omit_endlist');
  });
});
