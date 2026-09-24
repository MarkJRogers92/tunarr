import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { OutputFormat } from '@/ffmpeg/builder/constants.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import type { PlayerContext } from '@/stream/PlayerStreamContext.js';
import type {
  CurrentLineupItemResult,
  StreamProgramCalculator,
} from '@/stream/StreamProgramCalculator.js';
import type { StreamLineupItem } from '@/db/derived_types/StreamLineup.js';
import dayjs from 'dayjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProgramStream } from '../ProgramStream.ts';
import {
  applyHlsInvalidReserveWarning,
  applyHlsProducerDecision,
  createHlsProducerPlayerContext,
  decideHlsProducerCycle,
  decideHlsProducerWork,
  HlsSession,
  normalizeHlsProducerClock,
  prepareHlsProducerItem,
} from './HlsSession.js';

vi.mock('@/util/logging/LoggerFactory.js', () => ({
  LoggerFactory: {
    child: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    }),
  },
}));

vi.mock('@/stream/ConnectionTracker.ts', () => {
  return {
    ConnectionTracker: class {
      on = vi.fn();
      recordHeartbeat = vi.fn();
      removeStaleConnections = vi.fn(() => []);
    },
  };
});

const channelUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function contentItem(
  type: 'program' | 'commercial' | 'fallback',
  streamDuration: number,
  startOffset = 480_000,
): StreamLineupItem {
  return {
    type,
    streamDuration,
    duration: 1_320_000,
    startOffset,
    programBeginMs: 0,
    infiniteLoop: false,
    program: {
      uuid: 'program-uuid',
      persisted: { externalSourceId: 'source-id' },
    },
    ...(type === 'commercial' ? { fillerListId: 'filler' } : {}),
  } as unknown as StreamLineupItem;
}

function makeSession(transcodeDirectory: string): HlsSession {
  const channel = {
    uuid: channelUuid,
    transcodeConfig: {},
  } as ChannelOrmWithTranscodeConfig;

  const options = {
    streamMode: 'hls' as const,
    initialSegmentCount: 2,
    transcodeDirectory,
  };

  return new HlsSession(
    channel,
    options,
    {} as StreamProgramCalculator,
    {} as ISettingsDB,
    {} as OnDemandChannelService,
    (() => ({}) as unknown as ProgramStream) as (
      ctx: PlayerContext,
      fmt: OutputFormat,
    ) => ProgramStream,
  );
}
describe('HlsSession', () => {
  describe('bounded producer policy', () => {
    test('re-anchors an invalid clock and forces its recovery work to stay paced', () => {
      const now = new Date('2026-09-19T20:00:00.000-05:00');
      const recovered = normalizeHlsProducerClock(new Date(Number.NaN), now);

      expect(recovered.recoveredInvalidClock).toBe(true);
      expect(Number.isFinite(recovered.reserveSeconds)).toBe(true);
      expect(recovered.reserveSeconds).toBe(0);
      expect(recovered.transcodedUntil.valueOf()).toBe(now.valueOf());

      const cycle = decideHlsProducerCycle({
        reserveSeconds: recovered.reserveSeconds,
        recoveredInvalidClock: recovered.recoveredInvalidClock,
        wasCatchingUp: true,
        streamMode: 'hls',
        hasSegmentAnchor: true,
        startupProducedMs: 0,
        initialSegmentCount: 2,
        segmentDurationSeconds: 4,
      });
      expect(cycle).toMatchObject({
        type: 'produce',
        decision: {
          catchingUp: false,
          maxWorkDurationMs: 120_000,
        },
      });
    });

    test('paces the bounded startup window before normal production', () => {
      const initial = decideHlsProducerCycle({
        reserveSeconds: 0,
        recoveredInvalidClock: false,
        wasCatchingUp: false,
        streamMode: 'hls',
        hasSegmentAnchor: false,
        startupProducedMs: 0,
        initialSegmentCount: 2,
        segmentDurationSeconds: 4,
      });
      expect(initial).toEqual({
        type: 'produce',
        decision: { catchingUp: false, maxWorkDurationMs: 8_000 },
      });

      const afterStartup = decideHlsProducerCycle({
        reserveSeconds: 0,
        recoveredInvalidClock: false,
        wasCatchingUp: false,
        streamMode: 'hls',
        hasSegmentAnchor: false,
        startupProducedMs: 8_000,
        initialSegmentCount: 2,
        segmentDurationSeconds: 4,
      });
      expect(afterStartup).toEqual({
        type: 'produce',
        decision: { catchingUp: false, maxWorkDurationMs: 120_000 },
      });
      expect(
        decideHlsProducerCycle({
          reserveSeconds: 0,
          recoveredInvalidClock: false,
          wasCatchingUp: false,
          streamMode: 'hls',
          hasSegmentAnchor: false,
          startupProducedMs: 12_000,
          initialSegmentCount: 2,
          segmentDurationSeconds: 4,
        }),
      ).toEqual({
        type: 'produce',
        decision: { catchingUp: false, maxWorkDurationMs: 120_000 },
      });
    });

    test('continues paced production when Safari never requests a startup segment', () => {
      expect(
        decideHlsProducerCycle({
          reserveSeconds: 0,
          recoveredInvalidClock: false,
          wasCatchingUp: false,
          streamMode: 'hls',
          hasSegmentAnchor: false,
          startupProducedMs: 12_000,
          initialSegmentCount: 3,
          segmentDurationSeconds: 4,
        }),
      ).toEqual({
        type: 'produce',
        decision: { catchingUp: false, maxWorkDurationMs: 120_000 },
      });
    });

    test('uses normal catch-up policy after the first segment anchor exists', () => {
      expect(
        decideHlsProducerCycle({
          reserveSeconds: 8,
          recoveredInvalidClock: false,
          wasCatchingUp: false,
          streamMode: 'hls',
          hasSegmentAnchor: true,
          startupProducedMs: 8_000,
          initialSegmentCount: 2,
          segmentDurationSeconds: 4,
        }),
      ).toMatchObject({
        type: 'produce',
        decision: { catchingUp: true, maxWorkDurationMs: 30_000 },
      });
    });

    test('bounds paced HLS work so a slow encoder cannot drain the reserve for an entire program', () => {
      expect(decideHlsProducerWork(90, false, 'hls')).toEqual({
        catchingUp: false,
        maxWorkDurationMs: 120_000,
      });
    });

    test('does not apply the startup hold to hls_direct_v2', () => {
      expect(
        decideHlsProducerCycle({
          reserveSeconds: 0,
          recoveredInvalidClock: false,
          wasCatchingUp: false,
          streamMode: 'hls_direct_v2',
          hasSegmentAnchor: false,
          startupProducedMs: 0,
          initialSegmentCount: 2,
          segmentDurationSeconds: 4,
        }),
      ).toEqual({
        type: 'produce',
        decision: { catchingUp: false, maxWorkDurationMs: undefined },
      });
    });

    test('re-arms invalid reserve warnings after a finite reserve above admission', () => {
      const firstInvalid = applyHlsInvalidReserveWarning(false, Number.NaN);
      expect(firstInvalid.shouldWarn).toBe(true);

      const finiteReserve = applyHlsInvalidReserveWarning(
        firstInvalid.warningActive,
        301,
      );
      expect(finiteReserve.shouldWarn).toBe(false);
      expect(finiteReserve.warningActive).toBe(false);

      const secondInvalid = applyHlsInvalidReserveWarning(
        finiteReserve.warningActive,
        Number.NaN,
      );
      expect(secondInvalid.shouldWarn).toBe(true);
    });

    test('reports only catch-up state transitions', () => {
      expect(applyHlsProducerDecision(false, 40, 'hls').transition).toBe(
        'entered',
      );
      expect(
        applyHlsProducerDecision(true, 70, 'hls').transition,
      ).toBeUndefined();
      expect(applyHlsProducerDecision(true, 90, 'hls').transition).toBe(
        'exited',
      );
      expect(
        applyHlsProducerDecision(false, Number.NaN, 'hls').transition,
      ).toBeUndefined();
    });

    test.each([
      { reserve: 0, wasCatchingUp: false, expected: true },
      { reserve: 59.999, wasCatchingUp: false, expected: true },
      { reserve: 60, wasCatchingUp: false, expected: false },
      { reserve: 60, wasCatchingUp: true, expected: true },
      { reserve: 89.999, wasCatchingUp: true, expected: true },
      { reserve: 90, wasCatchingUp: true, expected: false },
      { reserve: 90, wasCatchingUp: false, expected: false },
    ])(
      'reserve=$reserve previous=$wasCatchingUp -> $expected',
      ({ reserve, wasCatchingUp, expected }) => {
        expect(
          decideHlsProducerWork(reserve, wasCatchingUp, 'hls').catchingUp,
        ).toBe(expected);
      },
    );

    test.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
      'keeps paced HLS bounded for invalid reserve %s',
      (reserve) => {
        expect(decideHlsProducerWork(reserve, true, 'hls')).toEqual({
          catchingUp: false,
          maxWorkDurationMs: 120_000,
        });
      },
    );

    test('does not catch up in hls_direct_v2', () => {
      expect(decideHlsProducerWork(0, true, 'hls_direct_v2')).toEqual({
        catchingUp: false,
        maxWorkDurationMs: undefined,
      });
    });

    test('cannot overshoot the 90-second exit target by more than one quantum', () => {
      const finalCatchUpDecision = decideHlsProducerWork(89.999, true, 'hls');
      expect(finalCatchUpDecision.maxWorkDurationMs).toBe(30_000);
      const nextReserve =
        89.999 + (finalCatchUpDecision.maxWorkDurationMs ?? 0) / 1_000;
      expect(nextReserve).toBeLessThanOrEqual(120);
      expect(decideHlsProducerWork(nextReserve, true, 'hls').catchingUp).toBe(
        false,
      );
    });
  });

  describe('bounded producer work units', () => {
    test('builds bounded unpaced and paced player contexts', () => {
      const channel = {
        uuid: channelUuid,
      } as unknown as CurrentLineupItemResult['channelContext'];
      const result: CurrentLineupItemResult = {
        lineupItem: contentItem('program', 120_000),
        channelContext: channel,
        sourceChannel: channel,
      };
      const transcodeConfig =
        {} as unknown as ChannelOrmWithTranscodeConfig['transcodeConfig'];

      const catchUp = createHlsProducerPlayerContext(
        result,
        transcodeConfig,
        'hls',
        { catchingUp: true, maxWorkDurationMs: 30_000 },
      );
      expect(catchUp.lineupItem.streamDuration).toBe(30_000);
      expect(catchUp.lineupItem.startOffset).toBe(480_000);
      expect(catchUp.realtime).toBe(true);
      expect(catchUp.suppressInputThrottle).toBe(true);

      const paced = createHlsProducerPlayerContext(
        result,
        transcodeConfig,
        'hls',
        { catchingUp: false, maxWorkDurationMs: 120_000 },
      );
      expect(paced.lineupItem.streamDuration).toBe(120_000);
      expect(paced.realtime).toBe(true);
      expect(paced.suppressInputThrottle).toBe(false);
    });

    test.each(['program', 'commercial', 'fallback'] as const)(
      'caps %s without changing its source offset',
      (type) => {
        const original = contentItem(type, 120_000);
        const originalProgram = original.program;
        const prepared = prepareHlsProducerItem(original, {
          catchingUp: true,
          maxWorkDurationMs: 30_000,
        });
        expect(prepared.lineupItem).not.toBe(original);
        expect(prepared.lineupItem.streamDuration).toBe(30_000);
        expect(prepared.lineupItem.startOffset).toBe(480_000);
        expect(original.streamDuration).toBe(120_000);
        expect(prepared.lineupItem.duration).toBe(1_320_000);
        expect(prepared.lineupItem.programBeginMs).toBe(0);
        expect(prepared.lineupItem.program).toBe(originalProgram);
        expect(prepared.lineupItem.program).toMatchObject({
          uuid: 'program-uuid',
          persisted: { externalSourceId: 'source-id' },
        });
        expect(prepared.suppressInputThrottle).toBe(true);
      },
    );

    test('does not pad a 12-second remaining item', () => {
      const prepared = prepareHlsProducerItem(contentItem('program', 12_000), {
        catchingUp: true,
        maxWorkDurationMs: 30_000,
      });
      expect(prepared.lineupItem.streamDuration).toBe(12_000);
    });

    test('bounds long paced content without suppressing input throttling', () => {
      const original = contentItem('program', 450_000);
      const prepared = prepareHlsProducerItem(original, {
        catchingUp: false,
        maxWorkDurationMs: 120_000,
      });
      expect(prepared.lineupItem.streamDuration).toBe(120_000);
      expect(prepared.suppressInputThrottle).toBe(false);
    });

    test('bounds a paced startup item without suppressing input throttling', () => {
      const original = contentItem('program', 120_000);
      const prepared = prepareHlsProducerItem(original, {
        catchingUp: false,
        maxWorkDurationMs: 8_000,
      });

      expect(prepared.lineupItem.streamDuration).toBe(8_000);
      expect(prepared.suppressInputThrottle).toBe(false);
    });

    test.each(['offline', 'error', 'redirect'] as const)(
      'never unpaces %s',
      (type) => {
        const item = {
          type,
          streamDuration: 120_000,
          duration: 120_000,
          startOffset: 0,
          programBeginMs: 0,
          ...(type === 'error' ? { error: 'test' } : {}),
          ...(type === 'redirect' ? { channel: 'other' } : {}),
        } as unknown as StreamLineupItem;
        expect(
          prepareHlsProducerItem(item, {
            catchingUp: true,
            maxWorkDurationMs: 30_000,
          }),
        ).toEqual({ lineupItem: item, suppressInputThrottle: false });
      },
    );
  });

  describe('getMasterPlaylist', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    test('returns undefined when playlist.m3u8 does not exist', async () => {
      // Working directory will be created by initDirectories, but we skip that here.
      // The file simply won't exist.
      const session = makeSession(dir.name);
      const result = await session.getMasterPlaylist();
      expect(result.isSuccess()).toBe(true);
      expect(result.get()).toBeUndefined();
    });
  });

  // The served window's END must not depend on whether the client has a recorded
  // segment position. It used to: an unanchored client got a `through_date`
  // window bounded by wall-clock `now`, and because a live channel's served
  // timeline runs a cushion ahead of `now` (the producer produces ahead, and
  // FFmpeg's tags that step backwards at item boundaries are repaired into a
  // monotonic timeline), that clipped the tail below the producer's head. A
  // player starts at the END of the window, so every client that lost its
  // position record - which happens on each master-playlist fetch, on a
  // reconnect, or after 120s of quiet - saw the live edge jump backwards.
  describe('the served window does not depend on the client position record', () => {
    let dir: tmp.DirResult;

    beforeEach(() => {
      dir = tmp.dirSync({ unsafeCleanup: true });
    });

    afterEach(() => {
      dir.removeCallback();
    });

    const HEAD_SEGMENT = 'data000014.ts';

    /** A 15 segment playlist whose tags run from +60s to +116s from now. */
    async function writeCushionedPlaylist(session: HlsSession) {
      await mkdir(session.workingDirectory, { recursive: true });
      const first = dayjs().add(60, 'second').startOf('second');
      const lines = [
        '#EXTM3U',
        '#EXT-X-VERSION:6',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-MEDIA-SEQUENCE:0',
      ];
      for (let n = 0; n < 15; n++) {
        lines.push(
          '#EXTINF:4.004000,',
          `#EXT-X-PROGRAM-DATE-TIME:${first
            .add(n * 4, 'second')
            .format('YYYY-MM-DDTHH:mm:ss.SSSZZ')}`,
          `/stream/channels/${channelUuid}/hls/data${String(n).padStart(6, '0')}.ts`,
        );
      }
      await writeFile(
        join(session.workingDirectory, 'stream.m3u8'),
        lines.join('\n'),
      );
    }

    test('offers an unanchored client the same live edge as an anchored one', async () => {
      // Fake timers keep `dayjs()` (the scheduled-time cutoff) stable.
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const session = makeSession(dir.name);
        await writeCushionedPlaylist(session);

        const unanchored = await session.trimPlaylistForClient('203.0.113.9');
        expect(unanchored.isSuccess()).toBe(true);
        const unanchoredPlaylist = unanchored.get()?.playlist;
        expect(unanchoredPlaylist).toContain(HEAD_SEGMENT);

        // The same client, now with a position recorded, must be offered the
        // identical window rather than one ending further forward.
        session.onSegmentRequested('203.0.113.9', 'data000010.ts');
        const anchored = await session.trimPlaylistForClient('203.0.113.9');
        expect(anchored.isSuccess()).toBe(true);
        expect(anchored.get()?.playlist).toBe(unanchoredPlaylist);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
