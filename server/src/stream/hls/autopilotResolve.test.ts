import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  firstStatsRow,
  firstTimeBase,
  parsePacketPts,
  parseSegmentPattern,
  parseSeekMs,
  probeHlsSegments,
  resolveInvocation,
  segmentNameRegex,
  verifySeekBasis,
} from './autopilotResolve.ts';

const ARGS = [
  '-nostdin',
  '-ss',
  '2000ms',
  '-i',
  '/m/ep.mkv',
  '-c:v',
  'libx264',
  '-f',
  'hls',
  '-hls_time',
  '4',
  '-hls_segment_filename',
  '/s/stream_x/data%06d.ts',
  '/s/stream_x/stream.m3u8',
];

const STATS =
  '0,0,1/90000,21,1/1000,146,0.021\n1,3754,1/90000,55,1/1000,147,0.055\n';

const deps = {
  readStats: async () => STATS,
  probeSegments: async () => [
    {
      path: '/s/stream_x/data000000.ts',
      closed: true,
      ptsStart: 0,
      ptsEnd: 1000,
      videoPacketPts: [0, 1000],
      timeBase: '1/90000',
    },
  ],
};

describe('autopilot resolve', () => {
  test('reads the segment pattern and seek from the invocation args', () => {
    expect(parseSegmentPattern(ARGS)).toBe('/s/stream_x/data%06d.ts');
    expect(parseSeekMs(ARGS)).toBe(2000);
    expect(parseSeekMs(['-ss', '3', '-i', 'x'])).toBe(3000);
  });

  test('reads the first stats row', () => {
    expect(firstStatsRow(STATS)).toEqual({ pts: 0, tb: '1/90000' });
    expect(firstStatsRow('')).toBeNull();
  });

  test('refuses when identity or evidence is missing', async () => {
    expect(
      await resolveInvocation({ kind: 'invocation', args: ARGS }, deps),
    ).toEqual({
      ok: false,
      reason: 'missing-identity',
    });
    expect(
      await resolveInvocation(
        {
          kind: 'invocation',
          invocationId: 'a',
          sourceId: '/m/ep.mkv',
          pid: 1,
          args: ARGS,
        },
        deps,
      ),
    ).toEqual({ ok: false, reason: 'no-stats-file' });
    expect(
      await resolveInvocation(
        {
          kind: 'invocation',
          invocationId: 'a',
          sourceId: '/m/ep.mkv',
          pid: 1,
          statsFile: '/x',
          args: ['-i', 'x'],
        },
        deps,
      ),
    ).toEqual({ ok: false, reason: 'no-segment-pattern' });
  });

  test('the segment window contains only the invocation that produced it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tunarr-win-'));
    temporary.push(dir);
    const at = (seconds: number) => new Date(seconds * 1000).toISOString();
    const names = ['data000000.ts', 'data000001.ts', 'data000002.ts'];
    for (const [index, name] of names.entries()) {
      const p = join(dir, name);
      await writeFile(p, 'x');
      await utimes(p, 1_700_000_000 + index * 10, 1_700_000_000 + index * 10);
    }
    const run = (_f: string, args: string[]) =>
      args.includes('packet=pts') ? '1\n2\n' : '1/90000\n';
    const segments = probeHlsSegments(
      {
        pattern: join(dir, 'data%06d.ts'),
        startedAt: at(1_700_000_010),
        finishedAt: at(1_700_000_010),
      },
      run,
    );
    // Only the segment written inside the invocation's own lifetime.
    expect(segments.map((s) => s.path.split('/').pop())).toEqual([
      'data000001.ts',
    ]);
  });

  test('verifySeekBasis accepts a frame-aligned seek and rejects a keyframe pre-roll', () => {
    // Offline probe: -ss 2 at 30fps; ni is the ABSOLUTE input frame (60 = 2s x
    // 30fps) while ptsi is relative to the landing point.
    const aligned =
      '0,0,1/90000,0,1/15360,60,0\n1,12000,1/90000,2048,1/15360,64,0.133333\n';
    expect(verifySeekBasis(aligned, 2)).toBe(true);

    // Same relative times but ni says the frames are really 1.5s into the
    // source, not 2s: the seek landed on an earlier keyframe, so the relative
    // basis would be wrong and must be refused.
    const preroll =
      '0,0,1/90000,0,1/15360,45,0\n1,12000,1/90000,2048,1/15360,49,0.133333\n';
    expect(verifySeekBasis(preroll, 2)).toBe(false);
  });

  // The rows below are REAL, captured from the -copyts experiment on an actual
  // item (`The Wonder Years - S02E14`, `-ss 1260000ms`, 23.976fps). They are the
  // evidence that -copyts turns the stats' input side into an absolute source
  // position, and that the position reported is the one actually reached.
  test('[stage 1] with -copyts the absolute input position attests the seek', () => {
    // ptsi 1260009ms for a requested 1260000ms: within a frame (1/90000 * 3754
    // = 41.7ms derived from the output timestamps).
    const accurate =
      '0,0,1/90000,1260009,1/1000,119,1260.01\n' +
      '1,3754,1/90000,1260009,1/1000,119,1260.01\n' +
      '2,7508,1/90000,1260009,1/1000,119,1260.01\n';
    expect(verifySeekBasis(accurate, 1260, { copyTimestamps: true })).toBe(
      true,
    );
    // And it is NOT accepted on the relative rule, which would be the wrong
    // regime for these rows.
    expect(verifySeekBasis(accurate, 1260)).toBe(false);

    // The control: forcing a keyframe landing moved the reported position to
    // 1255045ms - 4.955s early - while the request was unchanged. That is the
    // seek failing to land where it was asked, and it must be refused.
    const preroll =
      '0,0,1/90000,1255045,1/1000,119,1255.045\n' +
      '1,3754,1/90000,1255045,1/1000,119,1255.045\n' +
      '2,7508,1/90000,1255045,1/1000,119,1255.045\n';
    expect(verifySeekBasis(preroll, 1260, { copyTimestamps: true })).toBe(
      false,
    );
  });

  test('[stage 1] the copyts rule refuses when no frame duration can be derived', () => {
    // A single row cannot size a tolerance, so there is nothing to compare
    // against and the basis stays unverified rather than assumed.
    const single = '0,0,1/90000,1260009,1/1000,119,1260.01\n';
    expect(verifySeekBasis(single, 1260, { copyTimestamps: true })).toBe(false);
  });

  test('a non-zero input seek fails closed - no verified seek basis', async () => {
    const result = await resolveInvocation(
      {
        kind: 'invocation',
        invocationId: 'a',
        sourceId: '/m/ep.mkv',
        pid: 123,
        requestedOffsetMs: 2000,
        mode: 'transcode',
        statsFile: '/x',
        args: ARGS,
        startedAt: '2026-09-24T00:00:00.000Z',
      },
      deps,
    );
    expect(result).toEqual({ ok: false, reason: 'unverified-seek-basis' });
  });

  test('matches only the files the segment pattern names', () => {
    const re = segmentNameRegex('/s/stream_x/data%06d.ts');
    expect(re.test('data000000.ts')).toBe(true);
    expect(re.test('data999999.ts')).toBe(true);
    expect(re.test('data.ts')).toBe(false);
    expect(re.test('other000000.ts')).toBe(false);
  });

  test('parses bare ffprobe output', () => {
    expect(parsePacketPts('132000\n144000\n\n')).toEqual([132000, 144000]);
    expect(firstTimeBase('1/90000\n')).toBe('1/90000');
    expect(firstTimeBase('')).toBeNull();
  });

  const temporary: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporary
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  test('probes only the matching, in-window segments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tunarr-seg-'));
    temporary.push(dir);
    await writeFile(join(dir, 'data000000.ts'), 'x');
    await writeFile(join(dir, 'data000001.ts'), 'x');
    await writeFile(join(dir, 'notes.txt'), 'x');

    const run = (_file: string, args: string[]): string =>
      args.includes('packet=pts') ? '100\n200\n300\n' : '1/90000\n';

    const segments = probeHlsSegments(
      {
        pattern: join(dir, 'data%06d.ts'),
        startedAt: new Date(Date.now() - 5000).toISOString(),
      },
      run,
    );
    expect(segments.map((segment) => segment.path.split('/').pop())).toEqual([
      'data000000.ts',
      'data000001.ts',
    ]);
    expect(segments[0]).toMatchObject({
      ptsStart: 100,
      ptsEnd: 300,
      timeBase: '1/90000',
      closed: true,
    });
  });
});
