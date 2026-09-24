import { describe, expect, test } from 'vitest';
import {
  allocateInvocation,
  countStatsRows,
  insertStatsArgs,
  parseInvocationArgs,
  receiptDirectory,
} from './autopilotReceipt.ts';

describe('autopilot receipt capture', () => {
  test('is inert unless a receipt directory is configured', () => {
    expect(receiptDirectory({})).toBeNull();
    expect(receiptDirectory({ TUNARR_AUTOPILOT_RECEIPT: '   ' })).toBeNull();
    expect(receiptDirectory({ TUNARR_AUTOPILOT_RECEIPT: '/tmp/x' })).toBe(
      '/tmp/x',
    );
  });

  test('reads the invocation off its own arguments', () => {
    expect(
      parseInvocationArgs([
        '-hide_banner',
        '-ss',
        '2',
        '-i',
        '/media/ep.mkv',
        '-map',
        '0:v:0',
        '-c:v',
        'libx264',
        '-f',
        'hls',
        'out.m3u8',
      ]),
    ).toEqual({ sourceId: '/media/ep.mkv', requestedOffsetMs: 2000, mode: 'transcode' });

    expect(
      parseInvocationArgs(['-ss', '1500ms', '-i', 'http://x/y', '-c', 'copy', 'o.ts']),
    ).toEqual({ sourceId: 'http://x/y', requestedOffsetMs: 1500, mode: 'copy' });
  });

  test('inserts the stats options immediately before the output', () => {
    const args = ['-i', 'in.mkv', '-f', 'hls', 'out.m3u8'];
    const inserted = insertStatsArgs(args, '/tmp/stats.txt');
    expect(inserted.at(-1)).toBe('out.m3u8');
    expect(inserted).toContain('-stats_mux_pre:v:0');
    expect(inserted).toContain('/tmp/stats.txt');
    expect(inserted).toContain('{n},{pts},{tb},{ptsi},{tbi},{ni},{ti}');
    // The output stays last; the stats options sit before it.
    expect(inserted.indexOf('out.m3u8')).toBe(inserted.length - 1);
  });

  test('counts only non-empty stats rows', () => {
    expect(countStatsRows('1,2,3\n\n4,5,6\n')).toBe(2);
    expect(countStatsRows('')).toBe(0);
  });

  test('allocates a distinct id and a stats path that carries it', () => {
    const first = allocateInvocation('/tmp/r');
    const second = allocateInvocation('/tmp/r');
    expect(first.invocationId).not.toBe(second.invocationId);
    expect(first.statsFile).toContain(first.invocationId);
  });
});
