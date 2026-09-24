import { describe, expect, it } from 'vitest';
import {
  mapAuthenticatedStatsToClosedSegments,
  type AutopilotEvidenceInput,
} from './autopilotEvidence.ts';

const identity = {
  invocationId: 'run-123',
  processId: 'pid-456',
  sourceId: 'media-789',
  requestedOffsetSeconds: 0,
  videoStreamIndex: 0,
  mode: 'transcode' as const,
  authenticated: true,
  discontinuities: 'none' as const,
  seekBasis: 'not-applicable' as const,
};

// Compact rows captured from video-stats-bframes.txt. FFmpeg's mux-pre rows
// arrive in encoder order, so output PTS 0.1 precedes output PTS 0.0667.
const bFrameRows = [
  '0,0,1/90000,0,1/15360,0,0',
  '1,3000,1/90000,512,1/15360,1,0.0333333',
  '2,9000,1/90000,1536,1/15360,3,0.1',
  '3,6000,1/90000,1024,1/15360,2,0.0666667',
];

function makeInput(overrides: Partial<AutopilotEvidenceInput> = {}): AutopilotEvidenceInput {
  return {
    expected: {
      invocationId: identity.invocationId,
      processId: identity.processId,
      sourceId: identity.sourceId,
      requestedOffsetSeconds: identity.requestedOffsetSeconds,
      videoStreamIndex: identity.videoStreamIndex,
    },
    invocation: identity,
    statsRows: bFrameRows.join('\n'),
    processOrigin: {
      verified: true,
      invocationId: identity.invocationId,
      processId: identity.processId,
      sourceId: identity.sourceId,
      requestedOffsetSeconds: identity.requestedOffsetSeconds,
      videoStreamIndex: identity.videoStreamIndex,
      outputPts: 0,
      outputTimeBase: '1/90000',
      muxPts: 126000,
      muxTimeBase: '1/90000',
    },
    segments: [
      {
        invocationId: identity.invocationId,
        processId: identity.processId,
        sourceId: identity.sourceId,
        videoStreamIndex: 0,
        closed: true,
        discontinuityBefore: false,
        ptsStart: 126000,
        ptsEnd: 129000,
        videoPacketPts: [126000, 129000],
        timeBase: '1/90000',
      },
      {
        invocationId: identity.invocationId,
        processId: identity.processId,
        sourceId: identity.sourceId,
        videoStreamIndex: 0,
        closed: true,
        discontinuityBefore: false,
        ptsStart: 132000,
        ptsEnd: 135000,
        videoPacketPts: [132000, 135000],
        timeBase: '1/90000',
      },
    ],
    ...overrides,
  };
}

describe('mapAuthenticatedStatsToClosedSegments', () => {
  it('[PR06] maps presentation-sorted B-frame stats to contiguous closed segment ranges', () => {
    const result = mapAuthenticatedStatsToClosedSegments(makeInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceStartSeconds).toBe(0);
      expect(result.sourceEndSeconds).toBeCloseTo(0.1, 6);
      expect(result.segments.map((segment) => segment.frameCount)).toEqual([2, 2]);
      expect(result.segments[0]?.sourceStartSeconds).toBe(0);
      expect(result.segments[1]?.sourceStartSeconds).toBeCloseTo(2 / 30, 6);
    }
  });

  it('adds the authenticated requested offset to seek-relative input timestamps', () => {
    // First five rows of the captured offline replay's seek-stats.txt.
    // Output PTS is B-frame reordered; after presentation sorting these cover
    // 0 through 0.1333 seconds. The captured segment packet PTS are listed below.
    const seekRows = [
      '0,0,1/90000,0,1/15360,60,0',
      '1,12000,1/90000,2048,1/15360,64,0.133333',
      '2,6000,1/90000,1024,1/15360,62,0.0666667',
      '3,3000,1/90000,512,1/15360,61,0.0333333',
      '4,9000,1/90000,1536,1/15360,63,0.1',
    ].join('\n');
    const result = mapAuthenticatedStatsToClosedSegments(
      makeInput({
        expected: { ...makeInput().expected, requestedOffsetSeconds: 2 },
        invocation: {
          ...identity,
          requestedOffsetSeconds: 2,
          seekBasis: 'verified-relative',
        },
        statsRows: seekRows,
        processOrigin: {
          verified: true,
          invocationId: identity.invocationId,
          processId: identity.processId,
          sourceId: identity.sourceId,
          requestedOffsetSeconds: 2,
          videoStreamIndex: identity.videoStreamIndex,
          outputPts: 0,
          outputTimeBase: '1/90000',
          muxPts: 132000,
          muxTimeBase: '1/90000',
        },
        segments: [
          {
            ...makeInput().segments[0]!,
            ptsStart: 132000,
            ptsEnd: 144000,
            videoPacketPts: [132000, 144000, 138000, 135000, 141000],
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sourceStartSeconds).toBe(2);
      expect(result.sourceEndSeconds).toBeCloseTo(2 + 4 / 30, 6);
    }
  });

  it('refuses missing stats instead of inferring from playlist duration', () => {
    const result = mapAuthenticatedStatsToClosedSegments(makeInput({ statsRows: '' }));
    expect(result).toMatchObject({ ok: false, reason: 'missing-stats' });
  });

  it('rejects a missing FFmpeg n row even when remaining rows are otherwise valid', () => {
    const result = mapAuthenticatedStatsToClosedSegments(
      makeInput({ statsRows: [bFrameRows[0], bFrameRows[2], bFrameRows[3]].join('\n') }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'stats-sequence-gap' });
  });

  it('rejects a duplicate packet PTS replacing an interior PTS with unchanged range and count', () => {
    const firstSegment = makeInput().segments[0]!;
    const result = mapAuthenticatedStatsToClosedSegments(
      makeInput({
        segments: [
          {
            ...firstSegment,
            ptsStart: 126000,
            ptsEnd: 135000,
            videoPacketPts: [126000, 129000, 129000, 135000],
          },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'video-packet-pts-mismatch' });
  });

  it('rejects an identity mismatch rather than attributing another source', () => {
    const result = mapAuthenticatedStatsToClosedSegments(
      makeInput({
        segments: [
          {
            ...makeInput().segments[0]!,
            sourceId: 'different-media',
          },
        ],
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'identity-mismatch' });
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({
          processOrigin: {
            ...makeInput().processOrigin,
            sourceId: 'different-media',
          },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'identity-mismatch' });
  });

  it('rejects stream copy, unclosed segments, gaps, and missing input PTS', () => {
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({ invocation: { ...identity, mode: 'copy' } }),
      ),
    ).toMatchObject({ ok: false, reason: 'copy-mode' });
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({
          invocation: { ...identity, discontinuities: 'unknown' },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'discontinuity-ambiguity' });
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({
          processOrigin: { ...makeInput().processOrigin, verified: false },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'unverified-process-origin' });
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({
          expected: { ...makeInput().expected, requestedOffsetSeconds: 2 },
          invocation: { ...identity, requestedOffsetSeconds: 2 },
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'unverified-seek-basis' });
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({
          segments: [
            { ...makeInput().segments[0]!, closed: false },
            makeInput().segments[1]!,
          ],
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'segment-not-closed' });
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({
          segments: [
            makeInput().segments[0]!,
            {
              ...makeInput().segments[1]!,
              ptsStart: 135000,
              ptsEnd: 138000,
              videoPacketPts: [135000, 138000],
            },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'segment-gap-or-overlap' });
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({
          segments: [
            {
              ...makeInput().segments[0]!,
              videoPacketPts: [126000, 129000, 129000],
            },
            makeInput().segments[1]!,
          ],
        }),
      ),
    ).toMatchObject({ ok: false, reason: 'video-packet-pts-mismatch' });
    expect(
      mapAuthenticatedStatsToClosedSegments(
        makeInput({ statsRows: bFrameRows[0] + '\n1,3000,1/90000,N/A,1/15360,1,0.0333333' }),
      ),
    ).toMatchObject({ ok: false, reason: 'invalid-stats-row' });
  });
});
