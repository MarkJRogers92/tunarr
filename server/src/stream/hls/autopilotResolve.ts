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
import type { AutopilotEvidenceInput, AutopilotEvidenceResult } from './autopilotEvidence.ts';
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
export function firstStatsRow(text: string): { pts: number; tb: string } | null {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  if (!line) return null;
  const [, pts, tb] = line.split(',');
  if (pts === undefined || tb === undefined) return null;
  const value = Number(pts);
  return Number.isSafeInteger(value) ? { pts: value, tb } : null;
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
  const line = text.split(/\r?\n/).map((value) => value.trim()).find(Boolean);
  return line !== undefined && /^\d+\/\d+$/.test(line) ? line : null;
}

export type SegmentProbeRunner = (file: string, args: string[]) => string;

/** The installed ffprobe runner. */
export const ffprobeRunner =
  (ffprobePath = 'ffprobe'): SegmentProbeRunner =>
  (_file, args) =>
    execFileSync(ffprobePath, args, { encoding: 'utf8' });

const packetArgs = (file: string) => [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'packet=pts', '-of', 'default=nw=1:nk=1', file,
];
const timeBaseArgs = (file: string) => [
  '-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=time_base', '-of', 'default=nw=1:nk=1', file,
];

/**
 * Video-packet PTS for the segments this invocation produced. Segments are the
 * files matching the pattern whose mtime falls in (and just after) the
 * invocation's start; all are treated as closed, which is true because the
 * resolver runs after the invocation exited and flushed.
 */
export function probeHlsSegments(
  input: { pattern: string; startedAt: string },
  run: SegmentProbeRunner,
): ResolvedSegment[] {
  const directory = dirname(input.pattern);
  const matcher = segmentNameRegex(input.pattern);
  const since = Date.parse(input.startedAt);
  const segments: ResolvedSegment[] = [];
  for (const name of readdirSync(directory).sort()) {
    if (!matcher.test(name)) continue;
    const path = join(directory, name);
    if (Number.isFinite(since) && statSync(path).mtimeMs < since - 1000) continue;
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
  },
  deps: ResolveDependencies,
): Promise<ResolveResult> {
  if (record.kind !== 'invocation') return { ok: false, reason: 'not-an-invocation' };
  const { invocationId, sourceId } = record;
  if (!invocationId || !sourceId || record.pid === undefined || record.pid === null) {
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
  const segments = await deps.probeSegments({ pattern, startedAt: record.startedAt ?? '' });
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
      // A non-zero INPUT seek lands on the preceding keyframe, so the first
      // packet's true source position is not known; fail closed rather than
      // assert a relative basis that is not true.
      seekBasis: requestedOffsetSeconds > 0 ? 'unknown' : 'not-applicable',
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
