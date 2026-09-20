# Bounded HLS Producer Cushion Design

## Purpose

Prevent brief TiviMate freezes near the end of MarkTV episodes and around commercial transitions by keeping a small amount of already-produced HLS video available to the player.

The current HLS producer uses `-readrate 1`, which gives it no way to recover time lost to FFmpeg startup and lineup-item transitions. A previous unpaced experiment recovered quickly but let one long lineup item run several minutes ahead. This design adds a bounded catch-up mode that can rebuild a reserve without allowing that overshoot.

## User Outcome

- TiviMate should play a complete episode and both commercial pods without buffering, repeating, or skipping.
- Shows and commercials must remain in their scheduled order.
- Resuming an episode after an internal producer chunk must continue at the exact source offset, with no repeated or missing content.
- The served HLS timeline must remain monotonic across every FFmpeg process boundary.
- The channel may maintain approximately 90 seconds of produced reserve. That reserve must not make the viewer jump ahead of the scheduled air time.

## Scope

This change applies only to Tunarr's standard `hls` producer. It does not change MarkTV scheduling, commercial selection, TiviMate settings, `hls_slower`, `hls_direct_v2`, concat streams, the watchdog, or the passive playback monitor.

The existing 300-segment served-window and retention safety limits remain unchanged. Reducing them is a separate cleanup task after sustained live evidence shows the smaller bound is safe.

## Producer Policy

The HLS session owns a two-threshold catch-up state:

- Enter catch-up when the measured producer reserve is below 60 seconds.
- Remain in catch-up until the reserve reaches at least 90 seconds.
- While catching up, cap each FFmpeg work unit at 30 seconds of output and suppress input throttling for that work unit.
- Because catch-up state is checked between 30-second work units, the reserve can overshoot the 90-second target by at most one work unit. The designed ceiling is therefore 120 seconds, excluding sub-second measurement and segment-boundary rounding.
- Outside catch-up, keep the existing realtime pacing and allow the remainder of the current lineup item to run as one job.
- Never start a new job while the existing outer producer admission gate says the producer is too far ahead.

The policy uses hysteresis deliberately. A single 60-second threshold would repeatedly switch modes near the boundary; separate 60- and 90-second thresholds provide a stable reserve and limit extra FFmpeg restarts.

## Bounded Work Units

Catch-up changes only the output duration of the lineup item returned for the producer's future timestamp. It does not rewrite the schedule or the source file's original offset.

For a catch-up work unit:

1. Ask `StreamProgramCalculator` for the lineup item at `transcodedUntil`, as today.
2. If it is playable standard-HLS content and its remaining `streamDuration` exceeds 30 seconds, create an immutable copy whose `streamDuration` is 30 seconds.
3. Pass that copy through the existing `PlayerContext` and `ProgramStream` pipeline with `suppressInputThrottle: true`.
4. Advance `transcodedUntil` by the actual bounded session duration.
5. On the next loop, ask the calculator again using the new future timestamp. The calculator must return the same scheduled item with an advanced `startOffset`, or the next scheduled item if the chunk ended at a real boundary.

Offline, redirect, and error placeholders remain realtime-paced. They may be duration-bounded for accounting consistency, but they must not use the unpaced input policy. `hls_direct_v2` retains its current behavior.

No source offset is calculated by adding 30 seconds locally. The schedule calculator remains the source of truth for continuation offsets, which prevents mid-roll `startOffsetMs` from being counted twice.

## Timestamp and Playlist Continuity

FFmpeg process-local `PROGRAM-DATE-TIME` values cannot be trusted when an unpaced process writes into the future and the next process starts from the current wall clock.

The served playlist already reconstructs segment times from the HLS session's stable `playlistStart` plus cumulative `EXTINF` durations. This behavior becomes an explicit invariant of the bounded producer:

- The first served segment is anchored to the session timeline.
- Every later segment time equals the previous segment time plus the previous segment duration.
- A discontinuity tag may separate FFmpeg processes, but it must not reset or move program time backward.
- Segment PTS continuity continues to use `getPtsOffset()` and the last completed segment.

Regression tests must prove this invariant across multiple artificial process boundaries before catch-up is enabled in the running service.

## Failure Handling

- If a bounded program stream cannot be created, retain the existing error-stream substitution behavior.
- A failed work unit must not advance the reserve beyond the duration actually accepted by the transcode session.
- If the calculator returns an item whose remaining duration is already 30 seconds or less, use that duration without padding.
- If the producer reserve is not finite, log the invalid value and fall back to realtime pacing for that work unit.
- Catch-up state is session-local and resets when the HLS session is recreated.
- The existing watchdog must not restart Tunarr merely because the producer is resting with a healthy reserve.

## Code Boundaries

The implementation should stay within the existing streaming architecture:

- `server/src/stream/hls/HlsSession.ts`
  - Define the pure reserve-policy decision and constants.
  - Track catch-up state.
  - Bound eligible lineup-item work units.
  - Set `suppressInputThrottle` only for bounded standard-HLS catch-up work.
- `server/src/stream/hls/HlsSession.test.ts`
  - Exercise threshold hysteresis, the 30-second cap, the 120-second maximum designed overshoot, short remaining items, non-finite input, and mode/type exclusions.
- `server/src/stream/hls/HlsPlaylistMutator.test.ts`
  - Lock in monotonic reconstructed `PROGRAM-DATE-TIME` values across discontinuities and simulated process-local timestamp resets.
- Existing `PlayerContext`, `ProgramStream`, and FFmpeg pipeline policy fields should be reused. Their interfaces should change only if a failing test proves the bounded decision cannot be expressed through the current fields.

No database migration, API change, UI change, or new dependency is required.

## Test Strategy

Implementation follows test-driven development.

### Unit and integration tests

1. A fresh session below 60 seconds enters catch-up.
2. Catch-up remains active between 60 and 90 seconds.
3. Catch-up exits at 90 seconds or above.
4. A session already outside catch-up does not enter it between 60 and 90 seconds.
5. Catch-up work is capped at 30 seconds and never padded beyond the remaining item duration.
6. Standard paced work remains unbounded by the catch-up quantum.
7. Non-standard HLS modes and non-playable placeholders never receive the unpaced input policy.
8. Repeated bounded requests continue the same source at the calculator-provided offset without gaps or repeats, including a MarkTV-style mid-roll item with `startOffsetMs`.
9. Served playlist timestamps remain strictly monotonic through multiple discontinuities even if raw FFmpeg timestamps reset.
10. Existing playlist identity, retention-floor, and stream API tests remain green.

### Repository verification

- Run the focused HLS session and playlist tests while iterating.
- Run the complete server test suite once the implementation is stable.
- Run `pnpm lint-changed`, server typechecking, and the production server bundle/build.
- Review the actual diff independently because this changes shared streaming behavior.

### Live acceptance

Live deployment requires one controlled restart of the patched Tunarr service after the built bundle is verified. Before judging playback, remove diagnostic segment consumers and confirm `/api/sessions` contains only the real TiviMate client, apart from brief playlist-only health checks that do not request segments.

Observe one complete episode through both commercial pods and into the following program. Acceptance requires all of the following:

- TiviMate shows no freeze, repeat, skip, or playback error.
- The producer reserve recovers above 90 seconds after falling below 60 seconds.
- The reserve never exceeds 120 seconds beyond segment-boundary rounding.
- Playlist media sequence and segment fetches continue advancing.
- Served `PROGRAM-DATE-TIME` values never move backward.
- No new FFmpeg error dumps appear.
- The episode resumes at the correct source position after each commercial pod.

A health endpoint, playlist HTTP 200, short synthetic probe, or producer-only segment advancement is not sufficient evidence of success.

## Rollback

The change must remain isolated behind the pure reserve-policy decision. Rollback consists of restoring the always-paced policy, rebuilding the existing patched service, and restarting that service once. MarkTV schedule data and the Tunarr database are not modified by this feature, so rollback requires no data migration.
