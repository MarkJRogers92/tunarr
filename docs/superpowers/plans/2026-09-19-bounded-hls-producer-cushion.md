# Bounded HLS Producer Cushion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give standard Tunarr HLS playback a self-replenishing 60-90 second producer reserve without allowing any unpaced FFmpeg job to run more than 30 seconds of media ahead.

**Architecture:** `HlsSession` owns a hysteresis policy: enter catch-up below 60 seconds, emit unpaced content-backed work units of at most 30 seconds, and leave catch-up at 90 seconds. `StreamProgramCalculator` remains the source of truth for continuation offsets, while the playlist mutator continues rebuilding monotonic time from session start plus cumulative segment durations.

**Tech Stack:** TypeScript, Node.js 22, pnpm 10.28.0, Vitest, Day.js, Tunarr's existing HLS/PlayerContext/ProgramStream pipeline, FFmpeg.

**Spec:** `docs/superpowers/specs/2026-09-19-bounded-hls-producer-cushion-design.md`

## Global Constraints

- Change standard `hls` only; leave `hls_slower`, `hls_direct_v2`, concat streams, MarkTV scheduling, watchdogs, and client settings unchanged.
- Enter catch-up below 60 seconds and remain there until reserve reaches at least 90 seconds.
- Cap every unpaced work unit at 30,000 ms; designed reserve overshoot is at most one unit, for a 120-second ceiling before segment rounding.
- Treat calculator-provided `startOffset` as authoritative; never advance source offsets locally.
- Only content-backed items (`program`, `commercial`, `fallback`) may suppress input throttling. Offline, redirect, and error items remain paced.
- Reuse `suppressInputThrottle`; add no database migration, API, UI, dependency, or persisted setting.
- Keep the 300-segment playlist and retention limits unchanged.
- Preserve the existing uncommitted `server/scripts/bundle.ts` change exactly; do not stage, rewrite, or revert it.
- Workers use an isolated worktree and may commit locally, but never push, merge, publish, deploy, restart services, or use network access.

## Review Focus

- `NaN`, `Infinity`, and `-Infinity` reserve values must fail closed to paced work; Task 1 tests all three.
- Exact 60- and 90-second boundaries must not flap state; Task 1 tests both prior states at each boundary.
- Remaining content shorter than 30 seconds must retain its actual duration; Task 1 tests 12,000 ms.
- Commercial/fallback content must catch up like episodes, while placeholders and `hls_direct_v2` must never become unpaced; Task 1 covers each case.
- A MarkTV mid-roll continuation must advance the existing `startOffsetMs` exactly once when a 30-second chunk ends; Task 2 adds consecutive calculator requests.

---

### Task 1: Define the bounded producer policy

**Files:**
- Modify: `server/src/stream/hls/HlsSession.ts:47-70`
- Modify: `server/src/stream/hls/HlsSession.test.ts:1-76`

**Interfaces:**
- Consumes: `StreamLineupItem`, `isContentBackedLineupItem`, and `HlsSessionOptions['streamMode']`.
- Produces: `HLS_CATCH_UP_ENTER_SECONDS`, `HLS_CATCH_UP_EXIT_SECONDS`, `HLS_CATCH_UP_WORK_UNIT_MS`, `HlsProducerWorkDecision`, `decideHlsProducerWork()`, and `prepareHlsProducerItem()`.

- [ ] **Step 1: Write failing hysteresis tests**

Replace the existing `shouldPaceHlsTranscode` table with:

```ts
describe('bounded producer policy', () => {
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
```

- [ ] **Step 2: Verify RED**

Run `pnpm --dir server test src/stream/hls/HlsSession.test.ts`.

Expected: FAIL because `decideHlsProducerWork` is not exported.

- [ ] **Step 3: Implement the pure decision**

Replace `shouldPaceHlsTranscode` with:

```ts
export const HLS_CATCH_UP_ENTER_SECONDS = 60;
export const HLS_CATCH_UP_EXIT_SECONDS = 90;
export const HLS_CATCH_UP_WORK_UNIT_MS = 30_000;

export type HlsProducerWorkDecision = {
  catchingUp: boolean;
  maxWorkDurationMs: number | undefined;
};

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
```

Keep this free of clocks, logging, mutable state, and FFmpeg objects.

- [ ] **Step 4: Verify GREEN**

Run `pnpm --dir server test src/stream/hls/HlsSession.test.ts`.

Expected: PASS for thresholds, invalid numbers, and mode exclusion.

- [ ] **Step 5: Write failing work-unit tests**

Use a minimal `unknown`-cast content fixture, never `as any`:

```ts
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
```

- [ ] **Step 6: Verify the second RED state**

Run `pnpm --dir server test src/stream/hls/HlsSession.test.ts`.

Expected: FAIL because `prepareHlsProducerItem` does not exist.

- [ ] **Step 7: Implement immutable content-only preparation**

```ts
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
      streamDuration: Math.min(
        item.streamDuration,
        decision.maxWorkDurationMs,
      ),
    },
    suppressInputThrottle: true,
  };
}
```

Do not alter `startOffset`, `duration`, `programBeginMs`, or nested program data.

- [ ] **Step 8: Verify and commit Task 1**

```bash
pnpm --dir server test src/stream/hls/HlsSession.test.ts
pnpm exec prettier --check server/src/stream/hls/HlsSession.ts server/src/stream/hls/HlsSession.test.ts
git add server/src/stream/hls/HlsSession.ts server/src/stream/hls/HlsSession.test.ts
git commit -m "feat(hls): add bounded producer reserve policy"
```

Expected: both checks PASS; commit only those two files.

---

### Task 2: Wire catch-up into `HlsSession`

**Files:**
- Modify: `server/src/stream/hls/HlsSession.ts:240-405`
- Modify: `server/src/stream/hls/HlsSession.test.ts`
- Modify: `server/src/stream/StreamProgramCalculator.test.ts:587-706`

**Interfaces:**
- Consumes: Task 1's decision/preparation helpers and existing `PlayerContext.suppressInputThrottle`.
- Produces: session-local catch-up state, bounded contexts, transition-only logs, and calculator evidence for exact continuation.

- [ ] **Step 1: Extend the mid-roll calculator characterization**

In the existing `mid-roll break: startOffset should not double-count startOffsetMs` test, add:

```ts
const thirtySeconds = +dayjs.duration({ seconds: 30 });
const next = (
  await calc.getCurrentLineupItem({
    allowSkip: false,
    channelId: 1,
    startTime: currentTime + thirtySeconds,
  })
).get();
expect(next.lineupItem).toMatchObject<DeepPartial<StreamLineupItem>>({
  type: 'program',
  program: { uuid: programId },
  startOffset: expectedStartOffset + thirtySeconds,
  streamDuration: seg2Duration - twoMinutes - thirtySeconds,
});
```

- [ ] **Step 2: Run the characterization gate**

Run `pnpm --dir server test src/stream/StreamProgramCalculator.test.ts`.

Expected: PASS. If it fails, stop and repair the calculator before catch-up wiring.

- [ ] **Step 3: Write a failing transition test**

```ts
test('reports only catch-up state transitions', () => {
  expect(applyHlsProducerDecision(false, 40, 'hls').transition).toBe(
    'entered',
  );
  expect(applyHlsProducerDecision(true, 70, 'hls').transition).toBeUndefined();
  expect(applyHlsProducerDecision(true, 90, 'hls').transition).toBe('exited');
  expect(
    applyHlsProducerDecision(false, Number.NaN, 'hls').transition,
  ).toBeUndefined();
});
```

- [ ] **Step 4: Verify RED**

Run `pnpm --dir server test src/stream/hls/HlsSession.test.ts`.

Expected: FAIL because `applyHlsProducerDecision` is absent.

- [ ] **Step 5: Implement the transition seam and state**

```ts
export type HlsProducerTransition = 'entered' | 'exited';

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
  return transition === undefined
    ? decision
    : { ...decision, transition };
}
```

Add `#catchingUp = false` and `#invalidReserveWarningActive = false` to
`HlsSession`; reset both fields in `startInternal()`.

- [ ] **Step 6: Use the decision in the run loop**

Treat a non-finite reserve as eligible for the existing paced production path,
so it cannot accidentally enable catch-up or permanently skip the worker loop.
Replace the always-paced decision with:

```ts
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
await this.transcode(decision);
```

Change the existing outer admission condition to
`if (!Number.isFinite(transcodeBuffer) || transcodeBuffer <= 300)`. Keep its
rest path unchanged. The warning above fires once per continuous invalid-value
episode and a later finite value re-arms it.

- [ ] **Step 7: Prepare the item before `PlayerContext`**

Import the existing `CurrentLineupItemResult` type and expose one pure context
builder so the wiring is directly testable:

```ts
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
```

Change `transcode` to accept `decision` and call the helper inside the calculator
result mapping. Keep `realtime: true`; the explicit suppression is content-only,
so an error substitute remains paced. Use
`context.lineupItem.streamDuration ?? context.lineupItem.duration` for the error
substitute duration and pass `true` for its realtime argument.

- [ ] **Step 8: Assert the resulting contexts**

Add this direct test of the context-builder seam (import
`CurrentLineupItemResult` and `ChannelOrmWithTranscodeConfig` as types):

```ts
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
```

This test must not instantiate a `ProgramStream`, start FFmpeg, or write HLS
media.

- [ ] **Step 9: Verify and commit Task 2**

```bash
pnpm --dir server test src/stream/hls/HlsSession.test.ts src/stream/StreamProgramCalculator.test.ts
git add server/src/stream/hls/HlsSession.ts server/src/stream/hls/HlsSession.test.ts server/src/stream/StreamProgramCalculator.test.ts
git commit -m "fix(hls): replenish playback reserve in bounded chunks"
```

Expected: tests PASS; commit only the listed files.

---

### Task 3: Lock in monotonic served timestamps

**Files:**
- Modify: `server/src/stream/hls/HlsPlaylistMutator.test.ts:240-305`
- Modify only if characterization fails: `server/src/stream/hls/HlsPlaylistMutator.ts:95-140`

**Interfaces:**
- Consumes: `HlsPlaylistMutator.trimPlaylist()`.
- Produces: regression evidence that raw process-local time resets never reach clients.

- [ ] **Step 1: Add the reset characterization**

```ts
it('reconstructs monotonic time when a new ffmpeg process resets raw time', () => {
  const start = dayjs('2026-09-19T20:00:00.000-0500');
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-TARGETDURATION:4',
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:4.000000,',
    '#EXT-X-PROGRAM-DATE-TIME:2026-09-19T20:00:00.000-0500',
    '/stream/channels/test/hls/data000000.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:4.000000,',
    '#EXT-X-PROGRAM-DATE-TIME:2026-09-19T19:59:30.000-0500',
    '/stream/channels/test/hls/data000001.ts',
    '#EXTINF:4.000000,',
    '#EXT-X-PROGRAM-DATE-TIME:2026-09-19T19:59:34.000-0500',
    '/stream/channels/test/hls/data000002.ts',
  ];
  const result = mutator.trimPlaylist(
    start,
    { type: 'before_date', before: start },
    lines,
    defaultOpts,
  );
  const times = result.playlist.split('\n')
    .filter((line) => line.startsWith('#EXT-X-PROGRAM-DATE-TIME:'))
    .map((line) => dayjs(line.slice(line.indexOf(':') + 1)).valueOf());
  expect(times).toEqual([
    start.valueOf(),
    start.add(4, 'seconds').valueOf(),
    start.add(8, 'seconds').valueOf(),
  ]);
});
```

- [ ] **Step 2: Run the characterization gate**

Run `pnpm --dir server test src/stream/hls/HlsPlaylistMutator.test.ts`.

Expected: PASS because the parser already reconstructs from `start + cumulative EXTINF`. If it fails, minimally repair `parsePlaylist` before enabling catch-up.

- [ ] **Step 3: Run HLS invariants together**

```bash
pnpm --dir server test src/stream/hls/HlsSession.test.ts src/stream/hls/HlsPlaylistMutator.test.ts src/stream/hls/HlsPlaylistMutator.invariants.test.ts src/api/streamApiHlsConnections.test.ts
```

Expected: PASS with playlist identity, floor, cleanup, and time behavior unchanged.

- [ ] **Step 4: Commit Task 3**

```bash
git add server/src/stream/hls/HlsPlaylistMutator.test.ts
git commit -m "test(hls): preserve time across producer boundaries"
```

---

### Task 4: Verify, review, integrate, and deploy locally

**Files:**
- Verify: every Task 1-3 change
- Preserve: `server/scripts/bundle.ts`
- Runtime output: `server/dist/`
- Evidence: Tunarr log, channel stream directory, and playback-health log

**Interfaces:**
- Consumes: committed implementation from Tasks 1-3.
- Produces: independently reviewed commits, rebuilt local bundle, one controlled restart, and full-episode TiviMate evidence.

- [ ] **Step 1: Run complete worktree gates**

```bash
pnpm --dir server test
pnpm lint-changed
pnpm --dir server typecheck
pnpm --dir web bundle
pnpm --dir server bundle
```

Expected: every command exits 0. Report every failing test by name.

- [ ] **Step 2: Obtain independent actual-diff review**

Give a read-only Muse or DeepSeek reviewer the committed diff. Review threshold boundaries, non-content/mode exclusions, source-offset preservation, reserve accounting, playlist/PTS continuity, and out-of-scope edits. The reviewer cannot edit, build, commit, push, restart, or deploy. Resolve correctness findings test-first, then repeat Step 1.

- [ ] **Step 3: Inspect and integrate worker commits**

Verify the primary checkout still has only the known `server/scripts/bundle.ts` modification plus approved docs. Inspect `git show --stat` and the complete stream diff, then cherry-pick only reviewed worker commits. Never stage or overwrite `server/scripts/bundle.ts`.

- [ ] **Step 4: Re-run deployment-checkout gates**

```bash
pnpm --dir server test src/stream/hls/HlsSession.test.ts src/stream/hls/HlsPlaylistMutator.test.ts src/stream/hls/HlsPlaylistMutator.invariants.test.ts src/api/streamApiHlsConnections.test.ts src/stream/StreamProgramCalculator.test.ts
pnpm lint-changed
pnpm --dir server typecheck
```

Expected: PASS in `/Users/markrogers/tunarr-fork`; the bundle-script change remains unstaged.

- [ ] **Step 5: Capture baseline without consuming segments**

```bash
date
curl -fsS http://127.0.0.1:8000/api/system/health
curl -fsS http://127.0.0.1:8000/api/sessions
find "$HOME/Library/Preferences/tunarr/logs" -name 'ffmpeg-error-log-*.log' -mmin -60 -print
```

Record the TiviMate connection count, current program, error dumps, and latest playlist/segment numbers. Do not run FFmpeg, fetch `.ts` segments, or open another player.

- [ ] **Step 6: Build and restart once**

```bash
/Users/markrogers/marktv-ops/rebuild-patched-tunarr.sh
launchctl kickstart -k "gui/$(id -u)/com.marktv.tunarr-patched"
for attempt in $(seq 1 30); do
  curl -fsS http://127.0.0.1:8000/api/system/health && break
  sleep 2
done
curl -fsS http://127.0.0.1:8000/api/sessions
```

Expected: the configured patched Tunarr reports healthy and one standard-HLS
session appears after TiviMate reconnects. Logged catch-up commands omit
`-readrate`; ordinary work retains `-readrate 1`.

- [ ] **Step 7: Observe one complete real-client episode**

Keep TiviMate as the only segment consumer. Observe from before the first commercial pod through the second pod and into the next program. Inspect session metadata, filenames, playlist text, and logs only; do not fetch media segments.

Require:

- catch-up enters below 60 seconds and exits at or above 90;
- reserve stays at or below 120 seconds plus one segment of rounding;
- segment filenames and media sequence advance;
- served program times never move backward;
- no new FFmpeg error dumps;
- correct source continuation after each commercial pod;
- user confirmation of no TiviMate freeze, repeat, skip, or playback error.

If playback still freezes, do not stack another tuning change. Save evidence, restore always-paced policy, rebuild/restart once, and return to root-cause investigation.

- [ ] **Step 8: Report and preserve release boundaries**

Report implementation commits, exact files, verification, reviewer findings, live reserve range, transition times, full-episode outcome, untouched bundle-script state, and uncertainty. Do not push, merge to another branch, publish, or release without new explicit authorization.
