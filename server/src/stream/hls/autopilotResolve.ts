/**
 * Offline resolver: turns a captured invocation record into a source interval.
 *
 * It joins the two halves captured live — the mux-pre stats file (which FFmpeg
 * wrote for this invocation) and the HLS segments this invocation produced — and
 * feeds them to `mapAuthenticatedStatsToClosedSegments`. Kept OFF the playback
 * path: the capture writes raw files, this reads them afterwards.
 *
 * Honesty rules it must not bend:
 *  - It only claims `authenticated` because the pid, args and stats file all
 *    came from the same real process, captured at spawn.
 *  - It does NOT claim a verified seek basis for a non-zero offset. Tunarr seeks
 *    with an INPUT `-ss`, which lands on the preceding keyframe, so the true
 *    source position of the first packet is not `requestedOffset + ptsi`. When
 *    the offset is non-zero the basis is 'unknown' and the mapper fails closed.
 *    A zero offset (a programme starting at its own 0) is genuinely
 *    'not-applicable'.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type {
  AutopilotEvidenceInput,
  AutopilotEvidenceResult,
} from './autopilotEvidence.ts';
import { mapAuthenticatedStatsToClosedSegments } from './autopilotEvidence.ts';

export type ResolvedSegment = {
  path: string;
  closed: boolean;
  ptsStart: number;
  ptsEnd: number;
  videoPacketPts: number[];
  timeBase: string;
};

export type ResolveDependencies = {
  readStats: (path: string) => Promise<string>;
  probeSegments: (input: {
    pattern: string;
    startedAt: string;
    /** End of the invocation; segments outside [startedAt, finishedAt] are not its. */
    finishedAt?: string | null;
  }) => Promise<ResolvedSegment[]>;
};

/** The output segment filename pattern, taken from the invocation's own args. */
export function parseSegmentPattern(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-hls_segment_filename') {
      return args[index + 1] ?? null;
    }
  }
  return null;
}

/** The source `-ss` seek, in milliseconds, read from the args. */
export function parseSeekMs(args: readonly string[]): number {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '-ss') {
      const value = args[index + 1] ?? '';
      const ms = /^(-?\d+(?:\.\d+)?)ms$/.exec(value);
      if (ms) return Math.round(Number(ms[1]));
      const seconds = Number(value);
      return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
    }
  }
  return 0;
}

/** First non-empty stats row's output PTS and time base. */
export function firstStatsRow(
  text: string,
): { pts: number; tb: string } | null {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (!line) return null;
  const [, pts, tb] = line.split(',');
  if (pts === undefined || tb === undefined) return null;
  const value = Number(pts);
  return Number.isSafeInteger(value) ? { pts: value, tb } : null;
}

type InputRow = {
  ptsi: number;
  tiSeconds: number;
  ni: number;
  /** Output timestamp of the row, used to size a frame when `ni` is frozen. */
  outputSeconds: number | undefined;
};

function parseTimeBase(value: string): number | undefined {
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match || Number(match[2]) === 0) return undefined;
  const tick = Number(match[1]) / Number(match[2]);
  return Number.isFinite(tick) && tick > 0 ? tick : undefined;
}

function parseInputRows(text: string): InputRow[] {
  const rows: InputRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split(',');
    if (fields.length !== 7) continue;
    const tick = parseTimeBase(fields[4]!);
    const ptsi = Number(fields[3]);
    const ni = Number(fields[5]);
    if (
      tick === undefined ||
      !Number.isSafeInteger(ptsi) ||
      !Number.isSafeInteger(ni)
    )
      continue;
    const outputTick = parseTimeBase(fields[2]!);
    const outputPts = Number(fields[1]);
    rows.push({
      ptsi,
      tiSeconds: ptsi * tick,
      ni,
      outputSeconds:
        outputTick !== undefined && Number.isSafeInteger(outputPts)
          ? outputPts * outputTick
          : undefined,
    });
  }
  return rows;
}

/** Per-frame input duration derived from the rows' own input PTS and frame index. */
export function deriveInputFrameSeconds(text: string): number | null {
  const rows = parseInputRows(text).sort((a, b) => a.ni - b.ni);
  if (rows.length < 2) return null;
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const frames = last.ni - first.ni;
  const seconds = last.tiSeconds - first.tiSeconds;
  if (frames <= 0 || seconds <= 0) return null;
  const frameSeconds = seconds / frames;
  return Number.isFinite(frameSeconds) && frameSeconds > 0
    ? frameSeconds
    : null;
}

/**
 * Verifies the input-seek basis from the invocation's own stats.
 *
 * Two regimes, because the invocation itself decides which one applies.
 *
 * WITH `-copyts` (input timestamps preserved) the stats' input-side values are
 * ABSOLUTE source positions, so the attestation is direct: the first output
 * packet must have come from the requested offset. Measured on a real item, the
 * first row's `ptsi` was 1260009ms for a requested 1260000ms, and forcing the
 * seek to land on an earlier keyframe moved it to 1255045ms - 4.955s early -
 * while the request was unchanged. So this does not merely confirm the request
 * was passed; it detects a seek that did not land where it was asked to. Only the
 * first packet is asserted, because under `-copyts` these fields were observed
 * constant across rows rather than advancing per frame.
 *
 * WITHOUT it, a non-zero `-ss` is an INPUT seek, so `ti`/`ptsi` are RELATIVE to
 * the landing point and alone cannot say where in the source a frame really is.
 * There, `ni` is treated as the absolute input frame index and `ni / fps` as an
 * independent source time; when it agrees with `requestedOffset + ptsi` within a
 * frame the seek landed where it was asked to. In practice real invocations
 * report `ni` starting at 0, which fails this test - and that is the honest
 * outcome, because nothing in the row then establishes the source position.
 */
export function verifySeekBasis(
  text: string,
  requestedOffsetSeconds: number,
  options: { copyTimestamps?: boolean } = {},
): boolean {
  const rows = parseInputRows(text);
  if (rows.length === 0) return false;

  if (options.copyTimestamps) {
    // Each regime requires only what it actually uses. In particular the
    // relative rule's input-frame duration must NOT be required here: under
    // `-copyts` the input frame index is frozen, so that duration is underivable
    // and an earlier version of this function returned false before ever
    // reaching this branch - refusing exactly the evidence the flag provides.
    const tolerance = deriveOutputFrameSeconds(text);
    if (tolerance === null) return false;
    const first = [...rows].sort((left, right) => left.ni - right.ni)[0]!;
    return Math.abs(first.tiSeconds - requestedOffsetSeconds) <= tolerance;
  }

  const frameSeconds = deriveInputFrameSeconds(text);
  if (frameSeconds === null) return false;

  return rows.every(
    (row) =>
      Math.abs(
        row.ni * frameSeconds - (requestedOffsetSeconds + row.tiSeconds),
      ) <= frameSeconds,
  );
}

/**
 * The output frame duration, from the rows' own output timestamps.
 *
 * Needed because under `-copyts` the stats' input frame index was measured
 * CONSTANT across rows (119, 119, 119 on a real invocation), so
 * `deriveInputFrameSeconds` finds no frame progression there and cannot size a
 * tolerance. The output timestamps advance in both regimes, so they give a frame
 * duration either way.
 */
export function deriveOutputFrameSeconds(text: string): number | null {
  const rows = parseInputRows(text)
    .filter(
      (row): row is InputRow & { outputSeconds: number } =>
        row.outputSeconds !== undefined,
    )
    .sort((left, right) => left.outputSeconds - right.outputSeconds);
  if (rows.length < 2) return null;
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < rows.length; index += 1) {
    const delta = rows[index]!.outputSeconds - rows[index - 1]!.outputSeconds;
    if (delta > 0 && delta < smallest) smallest = delta;
  }
  return Number.isFinite(smallest) && smallest > 0 ? smallest : null;
}

/** Regex matching the files an HLS `-hls_segment_filename` printf pattern names. */
export function segmentNameRegex(pattern: string): RegExp {
  const base = basename(pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${base.replace(/%(\d*)d/, '\\d+')}$`);
}

/** `-show_entries packet=pts -of default=nw=1:nk=1` prints bare integer lines. */
export function parsePacketPts(text: string): number[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isInteger(value));
}

/** `-show_entries stream=time_base -of default=nw=1:nk=1` prints one `a/b` line. */
export function firstTimeBase(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line !== undefined && /^\d+\/\d+$/.test(line) ? line : null;
}

export type SegmentProbeRunner = (file: string, args: string[]) => string;

/** The installed ffprobe runner. */
export const ffprobeRunner =
  (ffprobePath = 'ffprobe'): SegmentProbeRunner =>
  (_file, args) =>
    execFileSync(ffprobePath, args, { encoding: 'utf8' });

const packetArgs = (file: string) => [
  '-v',
  'error',
  '-select_streams',
  'v:0',
  '-show_entries',
  'packet=pts',
  '-of',
  'default=nw=1:nk=1',
  file,
];
const timeBaseArgs = (file: string) => [
  '-v',
  'error',
  '-select_streams',
  'v:0',
  '-show_entries',
  'stream=time_base',
  '-of',
  'default=nw=1:nk=1',
  file,
];

/**
 * Video-packet PTS for the segments this invocation produced. Segments are the
 * files matching the pattern whose mtime falls in (and just after) the
 * invocation's start; all are treated as closed, which is true because the
 * resolver runs after the invocation exited and flushed.
 */
export function probeHlsSegments(
  input: { pattern: string; startedAt: string; finishedAt?: string | null },
  run: SegmentProbeRunner,
): ResolvedSegment[] {
  const directory = dirname(input.pattern);
  const matcher = segmentNameRegex(input.pattern);
  const since = Date.parse(input.startedAt);
  const until = input.finishedAt ? Date.parse(input.finishedAt) : Number.NaN;
  const segments: ResolvedSegment[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!matcher.test(name)) continue;
    const path = join(directory, name);
    const mtimeMs = statSync(path).mtimeMs;
    // Narrow to the invocation's own lifetime. Without an upper bound a short
    // invocation claims every later segment too (172 for a 4-second one).
    if (Number.isFinite(since) && mtimeMs < since - 1000) continue;
    if (Number.isFinite(until) && mtimeMs > until + 1000) continue;
    const pts = parsePacketPts(run(path, packetArgs(path)));
    if (pts.length === 0) continue;
    segments.push({
      path,
      closed: true,
      ptsStart: Math.min(...pts),
      ptsEnd: Math.max(...pts),
      videoPacketPts: pts,
      timeBase: firstTimeBase(run(path, timeBaseArgs(path))) ?? '1/90000',
    });
  }
  return segments;
}

export type ResolveFailure =
  | 'not-an-invocation'
  | 'no-stats-file'
  | 'no-segment-pattern'
  | 'no-stats-rows'
  | 'no-segments'
  | 'missing-identity';

export type ResolveResult =
  | AutopilotEvidenceResult
  | { ok: false; reason: ResolveFailure };

export async function resolveInvocation(
  record: {
    kind: string;
    invocationId?: string;
    pid?: number | null;
    sourceId?: string | null;
    requestedOffsetMs?: number;
    mode?: 'transcode' | 'copy';
    statsFile?: string | null;
    args?: string[];
    startedAt?: string;
    finishedAt?: string | null;
  },
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  if (record.kind !== 'invocation')
    return { ok: false, reason: 'not-an-invocation' };
  const { invocationId, sourceId } = record;
  if (
    !invocationId ||
    !sourceId ||
    record.pid === undefined ||
    record.pid === null
  ) {
    return { ok: false, reason: 'missing-identity' };
  }
  if (!record.statsFile) return { ok: false, reason: 'no-stats-file' };
  const args = record.args ?? [];
  const pattern = parseSegmentPattern(args);
  if (!pattern) return { ok: false, reason: 'no-segment-pattern' };

  const statsRows = await deps.readStats(record.statsFile);
  const first = firstStatsRow(statsRows);
  if (!first) return { ok: false, reason: 'no-stats-rows' };

  const requestedOffsetSeconds = (record.requestedOffsetMs ?? 0) / 1000;
  // Taken from the invocation itself rather than a separate field, so the basis
  // rule cannot disagree with the command line that actually ran.
  const copyTimestamps = args.includes('-copyts');
  const segments = await deps.probeSegments({
    pattern,
    startedAt: record.startedAt ?? '',
    finishedAt: record.finishedAt ?? null,
  });
  if (segments.length === 0) return { ok: false, reason: 'no-segments' };

  const processId = String(record.pid);
  const identity = {
    invocationId,
    processId,
    sourceId,
    requestedOffsetSeconds,
    videoStreamIndex: 0,
  };
  const input: AutopilotEvidenceInput = {
    expected: identity,
    invocation: {
      ...identity,
      mode: record.mode ?? 'transcode',
      authenticated: true,
      discontinuities: 'none',
      // With `-copyts` in the invocation the stats carry absolute source
      // positions and the basis is verified directly; without it a non-zero
      // INPUT seek is relative to the landing point, so the basis is only
      // trustworthy when the stats' own frame index agrees with the relative
      // mapping. Either way, anything unverified fails closed.
      seekBasis:
        requestedOffsetSeconds > 0
          ? verifySeekBasis(statsRows, requestedOffsetSeconds, {
              copyTimestamps,
            })
            ? copyTimestamps
              ? 'verified-absolute'
              : 'verified-relative'
            : 'unknown'
          : 'not-applicable',
    },
    statsRows,
    processOrigin: {
      verified: true,
      ...identity,
      outputPts: first.pts,
      outputTimeBase: first.tb,
      muxPts: segments[0]!.ptsStart,
      muxTimeBase: segments[0]!.timeBase,
    },
    segments: segments.map((segment) => ({
      ...identity,
      closed: segment.closed,
      discontinuityBefore: false,
      ptsStart: segment.ptsStart,
      ptsEnd: segment.ptsEnd,
      videoPacketPts: segment.videoPacketPts,
      timeBase: segment.timeBase,
    })),
  };

  return mapAuthenticatedStatsToClosedSegments(input);
}
