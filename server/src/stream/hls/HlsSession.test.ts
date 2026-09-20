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
import tmp from 'tmp';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ProgramStream } from '../ProgramStream.ts';
import {
  applyHlsInvalidReserveWarning,
  applyHlsProducerDecision,
  createHlsProducerPlayerContext,
  decideHlsProducerWork,
  HlsSession,
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
    program: {},
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
      expect(applyHlsProducerDecision(true, 70, 'hls').transition).toBeUndefined();
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
      'fails closed for invalid reserve %s',
      (reserve) => {
        expect(decideHlsProducerWork(reserve, true, 'hls')).toEqual({
          catchingUp: false,
          maxWorkDurationMs: undefined,
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
    test('builds bounded unpaced and full-duration paced player contexts', () => {
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
        { catchingUp: false, maxWorkDurationMs: undefined },
      );
      expect(paced.lineupItem.streamDuration).toBe(120_000);
      expect(paced.realtime).toBe(true);
      expect(paced.suppressInputThrottle).toBe(false);
    });

    test.each(['program', 'commercial', 'fallback'] as const)(
      'caps %s without changing its source offset',
      (type) => {
        const original = contentItem(type, 120_000);
        const prepared = prepareHlsProducerItem(original, {
          catchingUp: true,
          maxWorkDurationMs: 30_000,
        });
        expect(prepared.lineupItem).not.toBe(original);
        expect(prepared.lineupItem.streamDuration).toBe(30_000);
        expect(prepared.lineupItem.startOffset).toBe(480_000);
        expect(original.streamDuration).toBe(120_000);
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

    test('leaves paced content unbounded', () => {
      const original = contentItem('program', 120_000);
      expect(
        prepareHlsProducerItem(original, {
          catchingUp: false,
          maxWorkDurationMs: undefined,
        }),
      ).toEqual({ lineupItem: original, suppressInputThrottle: false });
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
});
