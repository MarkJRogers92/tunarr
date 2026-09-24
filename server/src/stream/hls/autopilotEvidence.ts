/**
 * Offline-only contract for correlating authenticated FFmpeg mux-pre stats
 * with closed MPEG-TS segment packet PTS ranges. This module performs no I/O
 * and is not wired into HLS playback. `authenticated` and `verified` are
 * assertions from a caller that independently captured and authenticated the
 * invocation and process-origin evidence; this function only checks that the
 * supplied evidence is internally consistent.
 */

export type AutopilotEvidenceIdentity = {
  invocationId: string;
  processId: string;
  sourceId: string;
  requestedOffsetSeconds: number;
  videoStreamIndex: number;
};

export type AutopilotEvidenceInput = {
  expected: AutopilotEvidenceIdentity;
  invocation: AutopilotEvidenceIdentity & {
    mode: 'transcode' | 'copy';
    authenticated: boolean;
    discontinuities: 'none' | 'present' | 'unknown';
    /** Must be tied to this invocation and offset by the caller's attestation. */
    /**
     * How the invocation's source position was established:
     * `verified-absolute` when the invocation preserved input timestamps
     * (`-copyts`), so the stats carry the real source position;
     * `verified-relative` when a relative basis was confirmed against the stats'
     * own frame index; `not-applicable` for no seek; `unknown` = refuse.
     */
    seekBasis:
      | 'not-applicable'
      | 'verified-absolute'
      | 'verified-relative'
      | 'unknown';
  };
  /** Raw rows in FFmpeg `n,pts,tb,ptsi,tbi,ni,ti` format. */
  statsRows: string;
  /** A caller-verified correspondence between one FFmpeg output PTS and one mux PTS. */
  processOrigin: {
    verified: boolean;
    invocationId: string;
    processId: string;
    sourceId: string;
    requestedOffsetSeconds: number;
    videoStreamIndex: number;
    outputPts: number;
    outputTimeBase: string;
    muxPts: number;
    muxTimeBase: string;
  };
  /** Closed segment range and complete video-only packet PTS list. */
  segments: Array<{
    invocationId: string;
    processId: string;
    sourceId: string;
    videoStreamIndex: number;
    closed: boolean;
    discontinuityBefore: boolean;
    ptsStart: number;
    ptsEnd: number;
    /** PTS values from ffprobe `-select_streams v:0`; audio packets are excluded. */
    videoPacketPts: number[];
    timeBase: string;
  }>;
};

export type AutopilotEvidenceFailureReason =
  | 'unauthenticated-invocation'
  | 'identity-mismatch'
  | 'copy-mode'
  | 'unverified-seek-basis'
  | 'discontinuity-ambiguity'
  | 'unverified-process-origin'
  | 'missing-stats'
  | 'invalid-stats-row'
  | 'stats-sequence-gap'
  | 'non-monotonic-source-coverage'
  | 'non-contiguous-source-coverage'
  | 'invalid-process-origin'
  | 'invalid-segment-range'
  | 'segment-not-closed'
  | 'segment-gap-or-overlap'
  | 'video-packet-pts-mismatch'
  | 'segment-does-not-match-stats';

export type AutopilotEvidenceResult =
  | {
      ok: true;
      sourceStartSeconds: number;
      sourceEndSeconds: number;
      outputFrameStepSeconds: number;
      segments: Array<{
        index: number;
        sourceStartSeconds: number;
        sourceEndSeconds: number;
        frameCount: number;
      }>;
    }
  | { ok: false; reason: AutopilotEvidenceFailureReason };

type StatsRow = {
  n: number;
  outputSeconds: number;
  sourceSeconds: number;
};

type MappedSegment = {
  index: number;
  startSeconds: number;
  endSeconds: number;
  packetOutputSeconds: number[];
  sourceRows: StatsRow[];
};

const fail = (
  reason: AutopilotEvidenceFailureReason,
): AutopilotEvidenceResult => ({
  ok: false,
  reason,
});

function parseTimeBase(value: string): number | undefined {
  const match = /^(-?\d+)\/(\d+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    denominator <= 0
  ) {
    return undefined;
  }
  const secondsPerTick = numerator / denominator;
  return Number.isFinite(secondsPerTick) && secondsPerTick > 0
    ? secondsPerTick
    : undefined;
}

function parseStatsRows(
  raw: string,
  requestedOffsetSeconds: number,
): StatsRow[] | undefined {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }

  const rows: StatsRow[] = [];
  const rowNumbers = new Set<number>();
  const inputNumbers = new Set<number>();
  let outputTimeBase: string | undefined;
  let inputTimeBase: string | undefined;
  for (const line of lines) {
    const fields = line.split(',');
    if (fields.length !== 7) {
      return undefined;
    }
    const [rawN, rawPts, rawTb, rawPtsi, rawTbi, rawNi, rawTi] = fields;
    const n = Number(rawN);
    const pts = Number(rawPts);
    const ptsi = Number(rawPtsi);
    const ni = Number(rawNi);
    const ti = Number(rawTi);
    const outputTick = parseTimeBase(rawTb!);
    const inputTick = parseTimeBase(rawTbi!);
    if (
      !Number.isSafeInteger(n) ||
      !Number.isSafeInteger(pts) ||
      !Number.isSafeInteger(ptsi) ||
      !Number.isSafeInteger(ni) ||
      !Number.isFinite(ti) ||
      outputTick === undefined ||
      inputTick === undefined ||
      (outputTimeBase !== undefined && rawTb !== outputTimeBase) ||
      (inputTimeBase !== undefined && rawTbi !== inputTimeBase) ||
      rowNumbers.has(n) ||
      inputNumbers.has(ni)
    ) {
      return undefined;
    }
    rowNumbers.add(n);
    inputNumbers.add(ni);
    outputTimeBase = rawTb;
    inputTimeBase = rawTbi;
    const outputSeconds = pts * outputTick;
    const sourceSeconds = requestedOffsetSeconds + ptsi * inputTick;
    if (!Number.isFinite(outputSeconds) || !Number.isFinite(sourceSeconds)) {
      return undefined;
    }
    rows.push({
      n,
      outputSeconds,
      sourceSeconds,
    });
  }
  return rows;
}

/**
 * Returns a mapping only when every supplied video stats row is uniquely
 * covered by one contiguous closed segment and source presentation time
 * advances at the same cadence as output presentation time. The strict
 * constant-cadence requirement intentionally fails closed for VFR streams.
 */
export function mapAuthenticatedStatsToClosedSegments(
  input: AutopilotEvidenceInput,
): AutopilotEvidenceResult {
  const { expected, invocation } = input;
  if (!invocation.authenticated) {
    return fail('unauthenticated-invocation');
  }
  if (
    invocation.invocationId !== expected.invocationId ||
    invocation.processId !== expected.processId ||
    invocation.sourceId !== expected.sourceId ||
    invocation.requestedOffsetSeconds !== expected.requestedOffsetSeconds ||
    invocation.videoStreamIndex !== expected.videoStreamIndex ||
    !Number.isFinite(expected.requestedOffsetSeconds) ||
    expected.requestedOffsetSeconds < 0 ||
    !expected.invocationId ||
    !expected.processId ||
    !expected.sourceId
  ) {
    return fail('identity-mismatch');
  }
  if (invocation.mode !== 'transcode') {
    return fail('copy-mode');
  }
  if (
    (expected.requestedOffsetSeconds > 0 &&
      invocation.seekBasis !== 'verified-relative' &&
      invocation.seekBasis !== 'verified-absolute') ||
    (expected.requestedOffsetSeconds === 0 &&
      invocation.seekBasis !== 'not-applicable')
  ) {
    return fail('unverified-seek-basis');
  }
  if (invocation.discontinuities !== 'none') {
    return fail('discontinuity-ambiguity');
  }
  if (!input.processOrigin.verified) {
    return fail('unverified-process-origin');
  }
  if (
    input.processOrigin.invocationId !== expected.invocationId ||
    input.processOrigin.processId !== expected.processId ||
    input.processOrigin.sourceId !== expected.sourceId ||
    input.processOrigin.requestedOffsetSeconds !==
      expected.requestedOffsetSeconds ||
    input.processOrigin.videoStreamIndex !== expected.videoStreamIndex
  ) {
    return fail('identity-mismatch');
  }

  for (const segment of input.segments) {
    if (
      segment.invocationId !== expected.invocationId ||
      segment.processId !== expected.processId ||
      segment.sourceId !== expected.sourceId ||
      segment.videoStreamIndex !== expected.videoStreamIndex
    ) {
      return fail('identity-mismatch');
    }
  }

  const rawLines = input.statsRows
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (rawLines.length === 0) {
    return fail('missing-stats');
  }
  const outputOriginTick = parseTimeBase(input.processOrigin.outputTimeBase);
  const muxOriginTick = parseTimeBase(input.processOrigin.muxTimeBase);
  if (
    outputOriginTick === undefined ||
    muxOriginTick === undefined ||
    !Number.isSafeInteger(input.processOrigin.outputPts) ||
    !Number.isSafeInteger(input.processOrigin.muxPts)
  ) {
    return fail('invalid-process-origin');
  }

  const rows = parseStatsRows(input.statsRows, expected.requestedOffsetSeconds);
  if (!rows) {
    return fail('invalid-stats-row');
  }
  const rowNumbers = new Set(rows.map((row) => row.n));
  if (
    rowNumbers.size !== rows.length ||
    !rows.every((row) => row.n >= 0 && row.n < rows.length)
  ) {
    return fail('stats-sequence-gap');
  }
  rows.sort((a, b) => a.outputSeconds - b.outputSeconds);
  const outputTimes = rows.map((row) => row.outputSeconds);
  const sourceTimes = rows.map((row) => row.sourceSeconds);
  const outputStep = outputTimes[1]! - outputTimes[0]!;
  const tolerance = Math.max(outputOriginTick, muxOriginTick, 1 / 15360) / 2;
  if (
    rows.length < 2 ||
    !Number.isFinite(outputStep) ||
    outputStep <= 0 ||
    outputTimes.some(
      (time, index) => index > 0 && time - outputTimes[index - 1]! <= tolerance,
    ) ||
    sourceTimes.some(
      (time, index) => index > 0 && time - sourceTimes[index - 1]! <= tolerance,
    )
  ) {
    return fail('non-monotonic-source-coverage');
  }
  for (let i = 1; i < rows.length; i++) {
    if (
      Math.abs(outputTimes[i]! - outputTimes[i - 1]! - outputStep) >
        tolerance ||
      Math.abs(sourceTimes[i]! - sourceTimes[i - 1]! - outputStep) > tolerance
    ) {
      return fail('non-contiguous-source-coverage');
    }
  }

  const outputOriginSeconds = input.processOrigin.outputPts * outputOriginTick;
  const muxOriginSeconds = input.processOrigin.muxPts * muxOriginTick;
  if (
    !outputTimes.some(
      (time) => Math.abs(time - outputOriginSeconds) <= tolerance,
    ) ||
    !input.segments.some((segment) => {
      const tick = parseTimeBase(segment.timeBase);
      return (
        tick !== undefined &&
        muxOriginSeconds >= segment.ptsStart * tick - tolerance &&
        muxOriginSeconds <= segment.ptsEnd * tick + tolerance
      );
    })
  ) {
    return fail('invalid-process-origin');
  }
  const muxToOutputOffset = outputOriginSeconds - muxOriginSeconds;

  if (input.segments.length === 0) {
    return fail('invalid-segment-range');
  }
  const mappedSegments: MappedSegment[] = [];
  for (const [index, segment] of input.segments.entries()) {
    if (!segment.closed) {
      return fail('segment-not-closed');
    }
    if (segment.discontinuityBefore) {
      return fail('discontinuity-ambiguity');
    }
    const segmentTick = parseTimeBase(segment.timeBase);
    if (
      segmentTick === undefined ||
      segment.timeBase !== input.processOrigin.muxTimeBase ||
      !Number.isSafeInteger(segment.ptsStart) ||
      !Number.isSafeInteger(segment.ptsEnd) ||
      segment.ptsEnd < segment.ptsStart ||
      segment.videoPacketPts.length === 0 ||
      segment.videoPacketPts.some((pts) => !Number.isSafeInteger(pts))
    ) {
      return fail('invalid-segment-range');
    }
    if (
      Math.min(...segment.videoPacketPts) !== segment.ptsStart ||
      Math.max(...segment.videoPacketPts) !== segment.ptsEnd
    ) {
      return fail('invalid-segment-range');
    }
    mappedSegments.push({
      index,
      startSeconds: segment.ptsStart * segmentTick + muxToOutputOffset,
      endSeconds: segment.ptsEnd * segmentTick + muxToOutputOffset,
      packetOutputSeconds: segment.videoPacketPts.map(
        (pts) => pts * segmentTick + muxToOutputOffset,
      ),
      sourceRows: [],
    });
  }
  mappedSegments.sort((a, b) => a.startSeconds - b.startSeconds);

  for (let i = 0; i < mappedSegments.length; i++) {
    const segment = mappedSegments[i]!;
    if (
      i > 0 &&
      Math.abs(
        segment.startSeconds - mappedSegments[i - 1]!.endSeconds - outputStep,
      ) > tolerance
    ) {
      return fail('segment-gap-or-overlap');
    }
    if (
      !outputTimes.some(
        (time) => Math.abs(time - segment.startSeconds) <= tolerance,
      ) ||
      !outputTimes.some(
        (time) => Math.abs(time - segment.endSeconds) <= tolerance,
      )
    ) {
      return fail('segment-does-not-match-stats');
    }
  }
  if (
    Math.abs(mappedSegments[0]!.startSeconds - outputTimes[0]!) > tolerance ||
    Math.abs(
      mappedSegments[mappedSegments.length - 1]!.endSeconds -
        outputTimes.at(-1)!,
    ) > tolerance
  ) {
    return fail('segment-does-not-match-stats');
  }

  const packetOutputTimes = mappedSegments
    .flatMap((segment) => segment.packetOutputSeconds)
    .sort((a, b) => a - b);
  if (
    packetOutputTimes.length !== outputTimes.length ||
    packetOutputTimes.some(
      (time, index) => Math.abs(time - outputTimes[index]!) > tolerance,
    )
  ) {
    return fail('video-packet-pts-mismatch');
  }

  for (const row of rows) {
    const matches = mappedSegments.filter(
      (segment) =>
        row.outputSeconds >= segment.startSeconds - tolerance &&
        row.outputSeconds <= segment.endSeconds + tolerance,
    );
    if (matches.length !== 1) {
      return fail('segment-does-not-match-stats');
    }
    matches[0]!.sourceRows.push(row);
  }
  if (mappedSegments.some((segment) => segment.sourceRows.length === 0)) {
    return fail('segment-does-not-match-stats');
  }
  return {
    ok: true,
    sourceStartSeconds: sourceTimes[0]!,
    sourceEndSeconds: sourceTimes.at(-1)!,
    outputFrameStepSeconds: outputStep,
    segments: mappedSegments.map((segment) => ({
      index: segment.index,
      sourceStartSeconds: segment.sourceRows[0]!.sourceSeconds,
      sourceEndSeconds: segment.sourceRows.at(-1)!.sourceSeconds,
      frameCount: segment.sourceRows.length,
    })),
  };
}
