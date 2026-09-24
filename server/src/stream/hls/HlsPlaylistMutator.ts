import { isNonEmptyString } from '@/util/index.js';
import { seq } from '@tunarr/shared/util';
import type { Dayjs } from 'dayjs';
import dayjs from 'dayjs';
import {
  filter,
  first,
  isEmpty,
  last,
  nth,
  reject,
  takeRight,
  trimEnd,
} from 'lodash-es';
import { basename } from 'node:path';
import { match } from 'ts-pattern';
import { SegmentNameRegex } from './BaseHlsSession.ts';

type MutateOptions = {
  maxSegmentsToKeep: number;
  endWithDiscontinuity: boolean;
  targetDuration: number;
  previousDiscontinuitySequence?: number;
  /**
   * How far behind the producer's head to end the advertised playlist. See
   * `HOLD_BACK_SECONDS`. Omitted or 0 means "end at the head", which is the
   * behaviour every existing caller and test expects.
   */
  holdBackSeconds?: number;
};

type FilterBeforeDate = {
  type: 'before_date';
  before: Dayjs;
};

type FilterBeforeSegmentNumber = {
  type: 'before_segment_number';
  segmentNumber: number;
  segmentsToKeepBefore: number;
  // Hard floor: never include segments below this number. Prevents the
  // playlist from referencing segments that have been deleted from disk.
  segmentFloor?: number;
};

type FilterThroughDate = {
  type: 'through_date';
  through: Dayjs;
  segmentFloor?: number;
};

export type HlsPlaylistFilterOptions =
  | FilterBeforeDate
  | FilterBeforeSegmentNumber
  | FilterThroughDate;

/**
 * How far behind the producer's head to end the advertised playlist.
 *
 * NOT USED, and it is recorded here because it looks like the obvious fix and is
 * actually the opposite of one.
 *
 * The reasoning that produced it: every client starts at the END of the playlist, the
 * producer deliberately races ahead and then rests once it is far enough in front, and
 * a viewer therefore began with only ~12 seconds of runway while a six minute cushion
 * sat behind the playhead. Ending the playlist behind the head appears to put
 * already-produced content in front of the client instead.
 *
 * WHY IT DOES NOT WORK, measured on a live channel: a client can only buffer as far as
 * the playlist's END. Holding the end back from the head therefore CAPS every client's
 * forward buffer at the hold-back gap - removing precisely the room to run that a deep
 * buffer needs. With this at 180s the served end sat 52 segments (~208s) behind the
 * producer's head and the viewer reported being "about 30 seconds from a freeze" while
 * complaining the player "wasn't buffering before it got close". The buffer belongs to
 * the CLIENT (see `web/src/hooks/useHls.ts`, where `lowLatencyMode` was pinning hls.js
 * to the live edge), not to the playlist. Left in place, exercised by tests, and unused
 * by HlsSession.
 */
export const HOLD_BACK_SECONDS = 180;

/**
 * Never hold back so far that the playlist has nothing left to serve - a young
 * session must still produce a playable playlist.
 */
const MIN_SEGMENTS_TO_SERVE = 10;

const ProgramDateTimePrefix = '#EXT-X-PROGRAM-DATE-TIME:';

/**
 * The segment's own program date time, when the tag is present and parses.
 *
 * Returns undefined for an absent, empty, or unparsable tag so the caller can
 * fall back to accumulating EXTINF durations, which is the only option for a
 * playlist FFmpeg produced without program date times.
 */
function parseProgramDateTime(tagLine: string | undefined): Dayjs | undefined {
  if (tagLine === undefined || !tagLine.startsWith(ProgramDateTimePrefix)) {
    return undefined;
  }

  const parsed = dayjs(tagLine.slice(ProgramDateTimePrefix.length).trim());
  return parsed.isValid() ? parsed : undefined;
}

export class HlsPlaylistMutator {
  trimPlaylist(
    start: Dayjs,
    filter: HlsPlaylistFilterOptions,
    playlistLines: string[],
    opts: MutateOptions,
  ): TrimPlaylistResult {
    const items = this.parsePlaylist(
      start,
      playlistLines,
      opts.endWithDiscontinuity,
    );

    const generateResult = this.generatePlaylist(
      items,
      filter,
      opts.maxSegmentsToKeep,
      opts.targetDuration,
      opts.previousDiscontinuitySequence,
      opts.holdBackSeconds ?? 0,
    );

    return {
      playlistStart: generateResult.nextPlaylistStart,
      sequence: generateResult.startSequence,
      playlist: generateResult.playlist,
      segmentCount: generateResult.count,
      discontinuitySequence: generateResult.discontinuitySequence,
    };
  }

  parsePlaylist(
    start: Dayjs,
    playlistLines: string[],
    endWithDiscontinuity: boolean,
  ): PlaylistLine[] {
    const items: PlaylistLine[] = [];

    let i = 0;
    // The monotonic fallback, and the time of the segment published before the
    // current one. A tagged time is only adopted when it advances past
    // `previousStart`; otherwise the tag is a raw-timeline reset, not a move.
    let previousStart: Dayjs | undefined;
    let currentTime = start;

    while (
      i < playlistLines.length &&
      !playlistLines[i]!.startsWith('#EXTINF:')
    ) {
      // Skip header lines — DISCs in the header are FFmpeg artifacts from
      // process restarts (discont_start), not actual program boundaries.
      // The DISC-SEQ header is also ignored because with hls_list_size=0
      // all DISCs are in the body; counting both would double-count.
      // This is beacuse Tunarr has discrete ffmpeg processes continuouly write
      // to the same underlying playlist file.
      // TODO: We could consider writing out the trimmed playlist periodically
      // in the session manager to keep things cleaner
      i++;
    }

    while (i < playlistLines.length) {
      const line = playlistLines[i];
      if (!isNonEmptyString(line)) {
        i++;
        continue;
      }

      if (line.startsWith('#EXT-X-DISCONTINUITY')) {
        items.push(PlaylistDiscontinuity());
        i++;
        continue;
      }

      // EXTINF
      const duration = parseFloat(trimEnd(line.trim(), ',').split(':')[1]!);
      // A segment's time is the one FFmpeg WROTE for it - unless that would move
      // the timeline backwards, in which case continue monotonically instead.
      //
      // Both halves are load-bearing and each was measured.
      //
      // USE THE TAG. This used to seed everything from the `start` argument and
      // add EXTINF durations forward, ignoring the tag on the very line it steps
      // over. The tags are the truth about when each segment airs, and they agree
      // with wall clock; a re-derived timeline has no reason to.
      //
      // ONLY WHEN IT ADVANCES. The tags of a live install are NOT monotonic. The
      // working directory is written by a succession of FFmpeg processes, one per
      // lineup item, each starting its own raw timeline with its own
      // schedule-derived -output_ts_offset, and while the producer is running
      // ahead the next item's offset lands BEHIND where the previous process
      // finished. Measured on a live channel: 165 segments contained FIVE backward
      // steps - 26.0s, 3.2s, 22.8s, 21.1s, 21.6s, 94.7s in total. Publishing a
      // backwards jump is itself a rewind for the player (see 'reconstructs
      // monotonic time when a new ffmpeg process resets raw time'), so those are
      // repaired: the tag is honoured only when it moves past the segment already
      // published before it, and otherwise `currentTime` carries the timeline
      // forward by EXTINF exactly as it always did. The invariant is that a
      // published segment's time never precedes its predecessor's.
      //
      // The price of that repair is that the served timeline ends up ~95s AHEAD of
      // the tags once a jump has happened. That is why the served window's END
      // must not depend on the caller: see `trimPlaylistForClient`, whose
      // wall-clock-bounded branch used to clip the tail below the producer's head
      // and made the advertised live edge jump backwards ~96s for any client that
      // lost its recorded segment position.
      const taggedTime = parseProgramDateTime(playlistLines[i + 1]);
      const startTime =
        taggedTime !== undefined &&
        (previousStart === undefined || taggedTime.isAfter(previousStart))
          ? taggedTime
          : currentTime;
      items.push(new PlaylistSegment(startTime, line, playlistLines[i + 2]!));

      previousStart = startTime;
      currentTime = startTime.add(duration, 'seconds');
      i += 3;
    }

    if (endWithDiscontinuity && last(items)?.type !== 'discontinuity') {
      items.push(PlaylistDiscontinuity());
    }

    return items;
  }

  private generatePlaylist(
    items: PlaylistLine[],
    filterOptions: HlsPlaylistFilterOptions,
    maxSegmentsToKeep: number,
    targetDuration: number,
    previousDiscontinuitySequence?: number,
    holdBackSeconds: number = 0,
  ) {
    // Count and remove leading discontinuities
    let leadingDiscontinuities = 0;
    let discontinuitySequence = 0;
    while (items[leadingDiscontinuities]?.type === 'discontinuity') {
      leadingDiscontinuities++;
    }
    discontinuitySequence += leadingDiscontinuities;
    items = items.slice(leadingDiscontinuities);

    let allSegments = filter(
      items,
      (item): item is PlaylistSegment => item.type === 'segment',
    );

    // End the window behind the producer's head - see HOLD_BACK_SECONDS. Applied
    // before the window selection below, so the served window ends this far back and
    // every client starts with that much already-produced content in front of it.
    // Off unless a caller asks for it, so every existing behaviour is unchanged.
    const headSegment = last(allSegments);
    if (holdBackSeconds > 0 && headSegment) {
      const cutoff = headSegment.startTime.subtract(holdBackSeconds, 'second');
      const heldBack = reject(allSegments, (segment) =>
        segment.startTime.isAfter(cutoff),
      );
      if (heldBack.length >= MIN_SEGMENTS_TO_SERVE) {
        allSegments = heldBack;
      }
    }

    // The HARD physical floor and the SOFT playback/history anchor are separated here,
    // deliberately and in this order.
    //
    // The floor answers "does this file still exist on disk". The soft filter answers
    // "which of those does this client's position want". Conflating them let the
    // fallback advertise deleted files: when the soft filter matched nothing, the old
    // code fell back to the UNFILTERED list, which still contained segments below the
    // floor, and a client then requested a URI with no file behind it. The floor was
    // also evaluated only inside `allSegments.length > maxSegmentsToKeep`, so a playlist
    // shorter than the window skipped it entirely. Measured against this file before the
    // change: with a floor of 12 and 16 segments present, the served list was 6..15.
    //
    // Order is eligible (physical) -> preferred (soft) -> window policy applied to one of
    // those, never to anything below the floor. A short valid list beats padding with
    // deleted files; when nothing is eligible the result is genuinely empty, and the
    // session/HTTP layer owns deciding that is "not ready" rather than publishing it as a
    // healthy playable manifest.
    const segmentNumberOf = (segment: PlaylistSegment): number | undefined => {
      const matches = basename(segment.line).match(SegmentNameRegex);
      if (!matches || matches.length < 2) {
        return undefined;
      }
      const parsed = parseInt(matches[1]!);
      return isNaN(parsed) ? undefined : parsed;
    };

    const physicalFloor =
      filterOptions.type === 'before_date'
        ? 0
        : (filterOptions.segmentFloor ?? 0);
    const eligible =
      physicalFloor > 0
        ? filter(allSegments, (segment) => {
            const number = segmentNumberOf(segment);
            return number !== undefined && number >= physicalFloor;
          })
        : allSegments;

    const preferred = match(filterOptions)
      .with({ type: 'before_date' }, ({ before }) =>
        reject(eligible, (segment) => segment.startTime.isBefore(before)),
      )
      .with({ type: 'before_segment_number' }, (beforeSeg) =>
        seq.collect(eligible, (segment) => {
          const number = segmentNumberOf(segment);
          if (number === undefined) {
            return;
          }
          if (
            number <
            beforeSeg.segmentNumber - beforeSeg.segmentsToKeepBefore
          ) {
            return;
          }
          return segment;
        }),
      )
      .with({ type: 'through_date' }, ({ through }) =>
        reject(eligible, (segment) => segment.startTime.isAfter(through)),
      )
      .exhaustive();

    // Always the NEWEST segments, never the oldest.
    //
    // This previously took the FIRST maxSegmentsToKeep of the filtered set, which
    // anchored the window to the SLOWEST client's position rather than to the live
    // edge. Two consequences, both observed on a live install: a player that paused
    // or a tab that was throttled pinned the window minutes behind the producer (and
    // stayed pinned, because polling the playlist keeps a connection alive without
    // moving its position), and everything the producer built beyond the slowest
    // client's position was unreachable - 52 segments of a 5 minute cushion measured
    // invisible. Taking the last N puts the window where the content actually is.
    //
    // The no-match fallback uses the newest of the ELIGIBLE set rather than of
    // everything, while still never reaching below the physical floor. The scheduled
    // wall-time cutoff is stricter: an empty match stays empty rather than exposing
    // future content to an unanchored client.
    const source =
      preferred.length > 0
        ? preferred
        : filterOptions.type === 'through_date'
          ? []
          : eligible;
    allSegments =
      source.length > maxSegmentsToKeep
        ? takeRight(source, maxSegmentsToKeep)
        : source;

    const startSequence = first(allSegments)?.startSequence ?? 0;

    if (!isEmpty(allSegments)) {
      const firstSeg = first(allSegments)!;
      const firstSegIndex = firstSeg
        ? items.findIndex(
            (item): item is PlaylistSegment =>
              item.type === 'segment' && item.equals(firstSeg),
          )
        : -1;
      // ALL discontinuities before the first selected segment are folded into
      // the discontinuity sequence number. They must never be emitted as tags
      // because there are no selected segments before them — emitting a tag
      // would create an empty leading period which confuses clients like Kodi
      // (inputstream.adaptive maps each discontinuity to a "period" and
      // errors with "No segments in the manifest" when a period is empty).
      for (let i = 0; i < firstSegIndex; i++) {
        if (items[i]!.type === 'discontinuity') {
          discontinuitySequence++;
        }
      }
    }

    // NOTE: there used to be a cap here that limited this number to
    // `previousDiscontinuitySequence + 1` and, when it clamped, invented a trailing
    // `#EXT-X-DISCONTINUITY`. It is removed deliberately; do not restore it.
    //
    // It was intended to stop a client seeing the discontinuity sequence jump by more
    // than one when several short items left the sliding window between two polls. What
    // it actually did was make the published identity depend on REQUEST HISTORY rather
    // than on the media: the same underlying snapshot produced `1`, then `2`, then `3`
    // as a client polled it, because each response fed the previous response's clamped
    // value back in as `previousDiscontinuitySequence`. Measured against this file: the
    // same input yields three different playlists across three consecutive GETs.
    //
    // A client that sees a segment's discontinuity identity change underneath it cannot
    // reconcile the timeline; it re-syncs, which presents as playback repeatedly
    // starting again from the same place. The invariant that matters is that the
    // identity of an overlapping segment must not change while the window moves, and
    // that is only achievable if the count is derived purely from the snapshot.
    //
    // `previousDiscontinuitySequence` is therefore no longer read here. RFC 8216
    // 6.2.1/6.2.2 require the discontinuity sequence to identify the first segment's
    // period, not to be smoothed for the client's benefit.
    void previousDiscontinuitySequence;

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:6',
      `#EXT-X-TARGETDURATION:${targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${startSequence}`,
      `#EXT-X-DISCONTINUITY-SEQUENCE:${discontinuitySequence}`,
      '#EXT-X-INDEPENDENT-SEGMENTS',
    ];

    // Track whether we've emitted at least one selected segment.
    // A DISC tag is only emitted when it separates two groups of selected
    // segments — never before the first selected segment (that case is
    // handled above by incrementing discontinuitySequence).
    let hasEmittedSegment = false;

    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      switch (item.type) {
        case 'discontinuity': {
          if (!hasEmittedSegment) {
            // Before the first selected segment — already counted in
            // discontinuitySequence above, do not emit a tag.
            break;
          }
          const next = items[i + 1];
          const nextIsSelected =
            next?.type === 'segment' &&
            allSegments.some((seg) => seg.equals(next));
          if (i === items.length - 1 || nextIsSelected) {
            lines.push('#EXT-X-DISCONTINUITY');
          }
          break;
        }
        case 'segment':
          if (allSegments.some((seg) => seg.equals(item))) {
            lines.push(item.extInf);
            lines.push(
              `#EXT-X-PROGRAM-DATE-TIME:${item.startTime.format(
                'YYYY-MM-DDTHH:mm:ss.SSSZZ',
              )}`,
            );
            lines.push(item.line);
            hasEmittedSegment = true;
          }
          break;
      }
    }

    const playlist = lines.join('\n');
    const nextPlaylistStart = first(allSegments)?.startTime ?? dayjs();
    return {
      playlist,
      nextPlaylistStart,
      startSequence,
      count: allSegments.length,
      discontinuitySequence,
    };
  }
}

class PlaylistSegment {
  public readonly type = 'segment' as const;

  constructor(
    public startTime: Dayjs,
    public extInf: string,
    public line: string,
  ) {}

  get startSequence() {
    const matches = this.line.match(/[A-z/]+(\d+)\.(ts|mp4)/);
    const match = nth(matches, 1);
    return match ? parseInt(match) : null;
  }

  equals(other: PlaylistSegment) {
    return (
      this === other ||
      (this.startTime.isSame(other.startTime) &&
        this.extInf === other.extInf &&
        this.line === other.line)
    );
  }
}

type PlaylistDiscontinuity = {
  type: 'discontinuity';
};

function PlaylistDiscontinuity(): PlaylistDiscontinuity {
  return {
    type: 'discontinuity',
  };
}

type PlaylistLine = PlaylistSegment | PlaylistDiscontinuity;

type TrimPlaylistResult = {
  playlistStart: Dayjs;
  sequence: number;
  playlist: string;
  segmentCount: number;
  discontinuitySequence: number;
};
