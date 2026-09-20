import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import {
  isContentBackedLineupItem,
  type StreamLineupItem,
} from '@/db/derived_types/StreamLineup.js';
import type { FfmpegTranscodeSession } from '@/ffmpeg/FfmpegTrancodeSession.js';
import { GetLastPtsDurationTask } from '@/ffmpeg/GetLastPtsDuration.js';
import type { HlsOptions } from '@/ffmpeg/builder/constants.js';
import {
  HlsDirectOutputFormat,
  HlsOutputFormat,
} from '@/ffmpeg/builder/constants.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import { PlayerContext } from '@/stream/PlayerStreamContext.js';
import type {
  CurrentLineupItemResult,
  StreamProgramCalculator,
} from '@/stream/StreamProgramCalculator.js';
import type { HlsSlowerSession } from '@/stream/hls/HlsSlowerSession.js';
import type {
  AudioRenditionInfo,
  SubtitleRenditionInfo,
} from '@/stream/types.js';
import { Result } from '@/types/result.js';
import type { Maybe } from '@/types/util.js';
import { fileExists } from '@/util/fsUtil.js';
import { wait } from '@/util/index.js';
import { seq } from '@tunarr/shared/util';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import { filter, isEmpty, last, maxBy, sortBy } from 'lodash-es';
import fs from 'node:fs/promises';
import path, { basename, dirname, extname } from 'node:path';
import type { DeepRequired } from 'ts-essentials';
import type { ProgramStreamFactory } from '../ProgramStreamFactory.ts';
import type { BaseHlsSessionOptions } from './BaseHlsSession.js';
import { BaseHlsSession } from './BaseHlsSession.js';
import { HlsMasterPlaylistMutator } from './HlsMasterPlaylistMutator.js';
import type { HlsPlaylistFilterOptions } from './HlsPlaylistMutator.js';
import { HlsPlaylistMutator } from './HlsPlaylistMutator.js';

export type HlsSessionProvider = (
  channel: ChannelOrmWithTranscodeConfig,
  options: HlsSessionOptions,
) => HlsSession;

export type HlsSlowerSessionProvider = (
  channel: ChannelOrmWithTranscodeConfig,
  options: BaseHlsSessionOptions,
) => HlsSlowerSession;

export interface HlsSessionOptions extends BaseHlsSessionOptions {
  streamMode: 'hls' | 'hls_direct_v2';
}

export const HLS_CATCH_UP_ENTER_SECONDS = 60;
export const HLS_CATCH_UP_EXIT_SECONDS = 90;
export const HLS_CATCH_UP_WORK_UNIT_MS = 30_000;

export type HlsProducerWorkDecision = {
  catchingUp: boolean;
  maxWorkDurationMs: number | undefined;
};

export type HlsProducerTransition = 'entered' | 'exited';

export function decideHlsProducerWork(
  reserveSeconds: number,
  wasCatchingUp: boolean,
  streamMode: HlsSessionOptions['streamMode'],
): HlsProducerWorkDecision {
  if (!Number.isFinite(reserveSeconds) || streamMode !== 'hls') {
    return { catchingUp: false, maxWorkDurationMs: undefined };
  }
  const catchingUp = wasCatchingUp
    ? reserveSeconds < HLS_CATCH_UP_EXIT_SECONDS
    : reserveSeconds < HLS_CATCH_UP_ENTER_SECONDS;
  return {
    catchingUp,
    maxWorkDurationMs: catchingUp ? HLS_CATCH_UP_WORK_UNIT_MS : undefined,
  };
}

export function prepareHlsProducerItem(
  item: StreamLineupItem,
  decision: HlsProducerWorkDecision,
): { lineupItem: StreamLineupItem; suppressInputThrottle: boolean } {
  if (
    !decision.catchingUp ||
    decision.maxWorkDurationMs === undefined ||
    !isContentBackedLineupItem(item)
  ) {
    return { lineupItem: item, suppressInputThrottle: false };
  }
  return {
    lineupItem: {
      ...item,
      streamDuration: Math.min(item.streamDuration, decision.maxWorkDurationMs),
    },
    suppressInputThrottle: true,
  };
}

export function applyHlsProducerDecision(
  wasCatchingUp: boolean,
  reserveSeconds: number,
  streamMode: HlsSessionOptions['streamMode'],
): HlsProducerWorkDecision & { transition?: HlsProducerTransition } {
  const decision = decideHlsProducerWork(
    reserveSeconds,
    wasCatchingUp,
    streamMode,
  );
  const transition =
    decision.catchingUp === wasCatchingUp
      ? undefined
      : decision.catchingUp
        ? 'entered'
        : 'exited';
  return transition === undefined ? decision : { ...decision, transition };
}

export function createHlsProducerPlayerContext(
  result: CurrentLineupItemResult,
  transcodeConfig: ChannelOrmWithTranscodeConfig['transcodeConfig'],
  streamMode: HlsSessionOptions['streamMode'],
  decision: HlsProducerWorkDecision,
): PlayerContext {
  const prepared = prepareHlsProducerItem(result.lineupItem, decision);
  return new PlayerContext(
    prepared.lineupItem,
    result.channelContext,
    result.sourceChannel,
    transcodeConfig,
    {
      audioOnly: false,
      realtime: true,
      suppressInputThrottle: prepared.suppressInputThrottle,
      streamMode,
    },
  );
}

/**
 * Initializes an ffmpeg process that concatenates via the /playlist
 * endpoint and outputs an HLS format + segments
 */
export class HlsSession extends BaseHlsSession<HlsSessionOptions> {
  #playlistStart?: Dayjs;
  #hlsPlaylistMutator: HlsPlaylistMutator = new HlsPlaylistMutator();
  #currentSession: Maybe<FfmpegTranscodeSession>;
  #lastDelete: Dayjs = dayjs().subtract(1, 'year');
  #isFirstTranscode = true;
  #lastDiscontinuitySequence: number | undefined;
  /**
   * Highest segment number below which segments have been deleted.
   *
   * Everything below this is gone, so the advertised window must never start
   * below it - doing so advertises pruned segments, and every one of them 404s.
   */
  #highestDeletedBelow = 0;
  #currentSubtitleRendition: SubtitleRenditionInfo | undefined;
  #currentAudioRenditions: AudioRenditionInfo[] = [];
  #catchingUp = false;
  #invalidReserveWarningActive = false;

  constructor(
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
    private programCalculator: StreamProgramCalculator,
    private settingsDB: ISettingsDB,
    private onDemandService: OnDemandChannelService,
    private programStreamFactory: ProgramStreamFactory,
  ) {
    super(channel, options);
  }

  public get sessionType(): HlsSessionOptions['streamMode'] {
    return this.sessionOptions.streamMode;
  }

  async getPlaylist() {
    return this.readPlaylist();
  }

  async getMasterPlaylist(): Promise<Result<string | undefined>> {
    return Result.attemptAsync(async () => {
      if (!(await fileExists(this._masterPlaylistPath))) {
        return undefined;
      }
      const content = await fs.readFile(this._masterPlaylistPath, 'utf-8');
      const rendition = this.#currentSubtitleRendition;
      const hlsOptions = this.getHlsOptions();
      const lines = HlsMasterPlaylistMutator.rewriteVariantPlaylistUrls(
        content,
        rendition,
        hlsOptions,
      );
      if (rendition) {
        HlsMasterPlaylistMutator.injectSubtitleMediaTag(
          lines,
          rendition,
          hlsOptions,
        );
      }
      if (this.#currentAudioRenditions.length > 0) {
        HlsMasterPlaylistMutator.injectAudioMediaTags(
          lines,
          this.#currentAudioRenditions,
          hlsOptions,
        );
      }
      return lines.join('\n');
    });
  }

  async trimPlaylist(filterOpts?: HlsPlaylistFilterOptions) {
    filterOpts ??= {
      type: 'before_segment_number',
      segmentNumber: this.minSegmentRequested,
      // Widened from 10 (~40s) to 30 (~2 minutes) of back-buffer. A player that
      // stalls, rebuffers, or seeks slightly backwards needs segments BEHIND its
      // position to exist; at 40s there was very little room before the deletion
      // floor caught up with it.
      segmentsToKeepBefore: 30,
      segmentFloor: this.#highestDeletedBelow,
    };
    return Result.attemptAsync(async () => {
      return await this.lock.runExclusive(async () => {
        const playlistLines = await this.readPlaylist();
        if (playlistLines) {
          const maxSegmentsToKeep = 300;
          const trimResult = this.#hlsPlaylistMutator.trimPlaylist(
            this.#playlistStart!,
            filterOpts,
            playlistLines,
            {
              // Raised to 120 (~8 minutes) to cover the producer's cushion AND a
              // client's back-buffer at once. Those two have to fit inside the same
              // window: with the producer running ~75 segments ahead and a 30 segment
              // back-buffer, a client sits ~105 segments below the head, so a smaller
              // window cannot reach both the live edge and the client watching it.
              // RAISED from 120 (~8 min) to 300 (~20 min), and it is KEPT - this is a
              // load-bearing backstop for an unfixed defect, not spare capacity.
              //
              // The unfixed defect: a single transcode job runs for a whole lineup item,
              // and the 300s admission gate below is checked BETWEEN items, so one job can
              // be as long as the item - 537s observed, 551s historic maximum. Gate 300s +
              // one job 551s is a ~850s (14 min) lead ceiling. At 120 segments (480s) the
              // window cannot reach a client sitting behind that lead; at 300 (1200s) it
              // can. Do not reduce this to 120 as cleanup until bounded work units exist.
              //
              // The +448s lead that motivated this was produced by an experiment (the
              // throttle override) that has since been reverted. It is history, not the
              // present state - but the ceiling above is a property of the UNFIXED job
              // length, which is why the larger window stays.
              //
              // Retention follows the floor, so the extra advertised segments stay on disk.
              maxSegmentsToKeep,
              targetDuration: this.getHlsOptions().hlsTime,
              previousDiscontinuitySequence: this.#lastDiscontinuitySequence,
              endWithDiscontinuity: false,
            },
          );
          this.#lastDiscontinuitySequence = trimResult.discontinuitySequence;
          const now = dayjs();
          if (now.isAfter(this.#lastDelete.add(30, 'seconds'))) {
            // Delete on a RETENTION bound, never on the served window's start alone.
            //
            // The window start is derived from client REQUEST positions
            // (`minSegmentRequested`, 30 segments behind the most recent request),
            // so passing it straight through as the deletion threshold lets one
            // client's position delete media another client is still reading. The
            // anchor is meant to track the SLOWEST client and protect it; behind a
            // proxy all clients arrive from one address, so the per-IP map collapses
            // to whichever client asked last - the opposite of the intent - and a
            // client that falls behind then requests segments that were just
            // unlinked. Observed on a live install as a player erroring or skipping
            // forward at item boundaries while a second client was further back.
            //
            // Clamping to `head - maxSegmentsToKeep` keeps the documented design
            // above (the advertised window must still be able to reach ~300 segments
            // back for a client sitting behind the producer's lead) while making the
            // floor a function of PRODUCTION rather than of who asked most recently.
            // `min` means it can only ever delete FEWER segments than before, so it
            // cannot regress retention; the floor now advances with the head instead
            // of jumping when a request moves the anchor.
            const headSegmentNumber =
              trimResult.sequence + Math.max(0, trimResult.segmentCount - 1);
            const retentionFloor = headSegmentNumber + 1 - maxSegmentsToKeep;
            const deletionThreshold =
              retentionFloor > 0
                ? Math.min(trimResult.sequence, retentionFloor)
                : trimResult.sequence;
            this.logger.debug(
              'Deleting old segments from stream (channel id = %s, number = %d, below = %d)',
              this.channel.uuid,
              this.channel.number,
              deletionThreshold,
            );
            this.deleteOldSegments(deletionThreshold).catch((e) =>
              this.logger.error(e),
            );
            this.#lastDelete = now;
          }

          return trimResult;
        }

        this.logger.trace(
          'No playlist for HLS sessions at %s',
          this._m3u8PlaylistPath,
        );
        return;
      });
    });
  }

  protected async startInternal() {
    if (this.state === 'started') {
      return;
    }

    await this.initDirectories();

    this.state = 'started';
    this.#playlistStart = this.transcodedUntil = dayjs();
    this.#catchingUp = false;
    this.#invalidReserveWarningActive = false;
    // Fire-and-forget
    this.run().catch((e) => this.logger.error(e));
  }

  private async run() {
    while (this.state === 'started') {
      const transcodeBuffer = dayjs
        .duration(dayjs(this.transcodedUntil).diff())
        .asSeconds();

      if (!Number.isFinite(transcodeBuffer) || transcodeBuffer <= 300) {
        const invalidReserve = !Number.isFinite(transcodeBuffer);
        if (invalidReserve && !this.#invalidReserveWarningActive) {
          this.logger.warn(
            'HLS producer reserve is invalid; falling back to paced work (channel=%s, reserve=%s)',
            this.channel.uuid,
            transcodeBuffer,
          );
        }
        this.#invalidReserveWarningActive = invalidReserve;

        const decision = applyHlsProducerDecision(
          this.#catchingUp,
          transcodeBuffer,
          this.sessionType,
        );
        this.#catchingUp = decision.catchingUp;
        if (decision.transition !== undefined) {
          this.logger.info(
            'HLS producer catch-up %s (channel=%s, reserve=%d seconds, target=%d seconds)',
            decision.transition,
            this.channel.uuid,
            transcodeBuffer,
            HLS_CATCH_UP_EXIT_SECONDS,
          );
        }
        this.logger.trace(
          'Transcode buffer is %d. Starting next transcode (catching up = %s)',
          transcodeBuffer,
          decision.catchingUp,
        );
        await this.transcode(decision);
        this.#isFirstTranscode = false;
      } else {
        // trim and delete
        // await this.trimPlaylistAndDeleteSegments();
        await wait(dayjs.duration({ seconds: 5 }));
      }
    }

    this.logger.debug('HLS worker ended main loop with state = %s', this.state);

    // Only schedule cleanup if the session wasn't already explicitly stopped
    // (e.g. via endSession). If the session is already stopped, its cleanup
    // has been handled and scheduling another timer would risk deleting a
    // replacement session that now occupies the same map key.
    if (this.state !== 'stopped') {
      this.scheduleCleanup();
    }
  }

  protected async stopInternal(): Promise<void> {
    try {
      await this.stopStream();
    } catch (e) {
      this.logger.error(e, 'Error while shutting down session');
    } finally {
      this.state = 'stopped';
    }
  }

  private async transcode(decision: HlsProducerWorkDecision) {
    const ptsOffset =
      this.#isFirstTranscode ||
      this.sessionOptions.streamMode === 'hls_direct_v2'
        ? 0
        : await this.getPtsOffset();

    const lineupItemResult = await this.programCalculator.getCurrentLineupItem({
      allowSkip: true,
      channelId: this.channel.uuid,
      startTime: await this.onDemandService.getLiveTimestamp(
        this.channel.uuid,
        +(this.transcodedUntil ?? dayjs()),
      ),
    });

    const transcodeResult = await lineupItemResult.mapAsync(async (result) => {
      this.logger.debug(
        'About to play lineup item: %s',
        JSON.stringify(result.lineupItem, undefined, 4),
      );
      const context = createHlsProducerPlayerContext(
        result,
        this.channel.transcodeConfig,
        this.sessionType,
        decision,
      );

      let programStream = this.getProgramStream(context, ptsOffset);

      programStream.on('error', () => {
        this.state = 'error';
        this.error = new Error(
          `Unrecoverable error in underlying FFMPEG process`,
        );
        this.emit('error', this.error);
      });

      let transcodeSessionResult = await programStream.setup();

      if (transcodeSessionResult.isFailure()) {
        this.logger.error(
          transcodeSessionResult.error,
          'Error while starting program stream. Attempting to subtitute with error stream',
        );

        programStream = this.getProgramStream(
          PlayerContext.error(
            context.lineupItem.streamDuration ?? context.lineupItem.duration,
            transcodeSessionResult.error,
            result.channelContext,
            this.channel,
            true,
            this.channel.transcodeConfig,
            this.sessionType,
          ),
          ptsOffset,
        );

        transcodeSessionResult = await programStream.setup();

        if (transcodeSessionResult.isFailure()) {
          this.state = 'error';
          this.error = transcodeSessionResult.error;
          this.emit('error', this.error);
        }
      }

      transcodeSessionResult.forEach((transcodeSession) => {
        this.transcodedUntil = (this.transcodedUntil ?? dayjs()).add(
          transcodeSession.streamDuration,
        );
        this.#currentSession = transcodeSession;
        this.#currentSubtitleRendition = programStream.renditions?.subtitle;
        this.#currentAudioRenditions = programStream.renditions?.audio ?? [];
      });

      if (this.sessionOptions.streamMode === 'hls') {
        // await this.trimPlaylistAndDeleteSegments();
      }
      await programStream.start();
      return programStream.transcodeSession!.wait();
    });

    if (transcodeResult.isFailure()) {
      this.logger.error(
        transcodeResult.error,
        'Error while transcoding program stream.',
      );
    }

    this.logger.debug('Stream ended.');
  }

  protected override getAdditionalRequiredFiles(): string[] {
    return this.#currentSubtitleRendition
      ? [this.getHlsOptions().subtitleStreamNameFormat]
      : [];
  }

  protected getHlsOptions(): DeepRequired<HlsOptions> {
    return {
      hlsDeleteThreshold: 3,
      streamNameFormat: 'stream.m3u8',
      subtitleStreamNameFormat: 'subs.m3u8',
      segmentNameFormat: BaseHlsSession.SegmentNameFormat,
      segmentBaseDirectory: dirname(this.workingDirectory),
      streamBasePath: basename(this.workingDirectory),
      streamBaseUrl: `/stream/channels/${this.channel.uuid}/${this.sessionType}/`,
      hlsTime: 4,
      hlsListSize: 0,
      deleteThreshold: null,
      appendSegments: true,
    };
  }

  private getProgramStream(context: PlayerContext, ptsOffset: Maybe<number>) {
    const hlsOptions = this.getHlsOptions();

    const outputFormat =
      this.sessionType === 'hls_direct_v2'
        ? HlsDirectOutputFormat(hlsOptions)
        : HlsOutputFormat(hlsOptions);

    return this.programStreamFactory(context, outputFormat, {
      ptsOffset,
      isFirstTranscode: this.#isFirstTranscode,
    });
  }

  private async getPtsOffset() {
    const lastSegment = await this.getLastSegment();

    if (!lastSegment) {
      if (!this.#isFirstTranscode) {
        this.logger.debug('No last segment found. Starting with PTS offset 0.');
      }
      return 0;
    }

    const result = await new GetLastPtsDurationTask(this.settingsDB).run(
      lastSegment,
    );

    if (result.isFailure()) {
      this.logger.error(result.error);
      return 0;
    }

    const { pts, duration } = result.get();

    return pts + duration + 1;
  }

  private async getLastSegment() {
    const workingDirectoryFiles = await Result.attemptAsync(() =>
      fs.readdir(this._workingDirectory),
    );

    if (workingDirectoryFiles.isFailure()) {
      this.logger.error(workingDirectoryFiles.error);
      return;
    }

    if (workingDirectoryFiles.get().length === 0) {
      return;
    }

    const p = last(
      sortBy(
        filter(
          workingDirectoryFiles.get(),
          (f) => extname(f) === '.ts' || extname(f) === '.mp4',
        ),
      ),
    );

    if (p) {
      return path.join(this._workingDirectory, p);
    }

    return;
  }

  isStale(): boolean {
    const remainingConnections = this.removeStaleConnections();
    return isEmpty(remainingConnections);
  }

  private async readPlaylist() {
    if (!(await fileExists(this._m3u8PlaylistPath))) {
      return;
    }

    const playlistContents = await fs.readFile(this._m3u8PlaylistPath, {
      encoding: 'utf-8',
    });

    return playlistContents.toString().split('\n');
  }

  private async deleteOldSegments(sequenceNum: number) {
    const workingDirectoryFiles = await fs.readdir(this._workingDirectory);
    const segments = filter(
      seq.collect(
        filter(workingDirectoryFiles, (f) => {
          const ext = extname(f);
          return ext === '.ts' || ext === '.mp4' || ext === '.vtt';
        }),
        (file) => {
          const matches = file.match(/[A-z/]+(\d+)\.[ts|mp4]/);
          if (matches && matches.length > 0) {
            return {
              file,
              seq: parseInt(matches[1]!),
            };
          }
          return;
        },
      ),
      ({ seq }) => seq < sequenceNum,
    );

    // Recorded whether or not anything was deleted: it is the threshold that
    // matters, since everything below it is gone either way.
    this.#highestDeletedBelow = Math.max(
      this.#highestDeletedBelow,
      sequenceNum,
    );

    if (segments.length > 0) {
      this.logger.trace(
        'Deleting %d segments. Max segment number: %d',
        segments.length,
        maxBy(segments, (seg) => seg.seq)?.seq ?? 0,
      );
    }

    for (const { file } of segments) {
      try {
        await fs.unlink(path.join(this._workingDirectory, file));
      } catch (e) {
        this.logger.error(e);
      }
    }
  }

  protected async stopStream(): Promise<void> {
    if (this.#currentSession) {
      this.#currentSession.kill();
    }

    this.logger.debug(
      `Cleaning out stream path for session: %s`,
      this._workingDirectory,
    );

    return await this.cleanupDirectory();
  }
}
