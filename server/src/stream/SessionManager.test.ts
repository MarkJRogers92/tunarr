import type { IChannelDB } from '@/db/interfaces/IChannelDB.js';
import type { ISettingsDB } from '@/db/interfaces/ISettingsDB.js';
import type { ChannelOrmWithTranscodeConfig } from '@/db/schema/derivedTypes.js';
import type { HlsOptions } from '@/ffmpeg/builder/constants.js';
import type { EventService } from '@/services/EventService.js';
import type { OnDemandChannelService } from '@/services/OnDemandChannelService.js';
import type { Logger } from '@/util/logging/LoggerFactory.js';
import type { DeepRequired } from 'ts-essentials';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HlsSessionOptions } from './hls/HlsSession.ts';

// Mock modules that create circular dependency chains through Inversify
vi.mock('@/services/EventService.js', () => ({
  EventService: vi.fn(),
}));

vi.mock('@/services/OnDemandChannelService.js', () => ({
  OnDemandChannelService: vi.fn(),
}));

// Must be imported after the mocks are set up
const { SessionManager } = await import('./SessionManager.ts');
const { BaseHlsSession } = await import('./hls/BaseHlsSession.ts');

// ---------------------------------------------------------------------------
// Stub session: a minimal HlsSession-like object that lets us control
// start/stop behaviour and manually emit events.
// ---------------------------------------------------------------------------

class StubHlsSession extends BaseHlsSession<HlsSessionOptions> {
  public readonly sessionType: 'hls' | 'hls_direct_v2';

  constructor(
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
  ) {
    super(channel, options);
    this.sessionType = options.streamMode;
  }

  protected getHlsOptions(): DeepRequired<HlsOptions> {
    return {
      hlsDeleteThreshold: 3,
      streamNameFormat: 'stream.m3u8',
      subtitleStreamNameFormat: 'subs.m3u8',
      segmentNameFormat: 'data%06d.ts',
      segmentBaseDirectory: '/tmp/test-sessions',
      streamBasePath: 'test',
      streamBaseUrl: '/test/',
      hlsTime: 4,
      hlsListSize: 0,
      deleteThreshold: null,
      appendSegments: true,
    };
  }

  // Skip all real startup work — just mark as started
  protected override async startInternal() {
    this.state = 'started';
  }

  protected override async stopInternal() {
    this.state = 'stopped';
  }

  // Skip waiting for stream files
  protected override async waitForStreamReady() {
    const { Result } = await import('@/types/result.js');
    return Result.success(void 0);
  }

  // Use the real Session.isStale() implementation so staleness
  // tests exercise the actual threshold logic.
}

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

const noopLogger = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  trace: vi.fn(),
  warn: vi.fn(),
  setBindings: vi.fn(),
  child: () => noopLogger,
  bindings: () => ({}),
} as unknown as Logger;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const channelUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeChannel(): ChannelOrmWithTranscodeConfig {
  return {
    uuid: channelUuid,
    number: 1,
    transcodeConfig: {},
  } as unknown as ChannelOrmWithTranscodeConfig;
}

type HarnessOptions = {
  /**
   * Whether the channel's lineup carries an onDemandConfig, i.e. whether this is
   * an on-demand channel. Defaults to true so the pre-existing staleness and
   * cleanup tests keep exercising the retirement path; the tests for continuous
   * (non-on-demand) channels pass false.
   */
  onDemand?: boolean;
  /** Rejection to raise from loadAllLineupConfigs, for the fail-closed test. */
  lineupFailure?: Error;
};

function makeSessionManager(
  hlsFactory: (
    channel: ChannelOrmWithTranscodeConfig,
    options: HlsSessionOptions,
  ) => StubHlsSession,
  harness: HarnessOptions = {},
) {
  const { onDemand = true, lineupFailure } = harness;
  const channelDB: Partial<IChannelDB> = {
    getChannelOrm: vi.fn().mockResolvedValue(makeChannel()),
    loadAllLineupConfigs: lineupFailure
      ? vi.fn().mockRejectedValue(lineupFailure)
      : vi.fn().mockResolvedValue({
          [channelUuid]: {
            channel: makeChannel(),
            lineup: onDemand ? { onDemandConfig: { state: 'playing' } } : {},
          },
        }),
  };

  const onDemandService: Partial<OnDemandChannelService> = {
    resumeChannel: vi.fn().mockResolvedValue(undefined),
    pauseChannel: vi.fn().mockResolvedValue(undefined),
  };

  const eventService: Partial<EventService> = {
    push: vi.fn(),
  };

  const settingsDB: Partial<ISettingsDB> = {
    ffmpegSettings: vi.fn().mockReturnValue({
      transcodeDirectory: '/tmp/test-sessions',
    }),
  };

  // Construct SessionManager directly, bypassing Inversify
  const manager = new (SessionManager as any)(
    channelDB,
    onDemandService,
    hlsFactory,
    vi.fn(), // hlsSlowerSessionFactory — not used in these tests
    vi.fn(), // concatSessionFactory
    eventService,
    settingsDB,
  ) as SessionManager;

  // Override the @InjectLogger() property with a noop mock so
  // tests don't require an initialized LoggerFactory.
  (manager as any).logger = noopLogger;

  return manager;
}

const connection = { ip: '127.0.0.1' };

describe('SessionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('HLS startup buffering', () => {
    it('uses one completed segment for normal HLS startup readiness', async () => {
      let capturedOptions: HlsSessionOptions | undefined;
      const manager = makeSessionManager((channel, options) => {
        capturedOptions = options;
        return new StubHlsSession(channel, options);
      });

      const result = await manager.getOrCreateHlsSession(
        channelUuid,
        'startup-token',
        connection,
        { streamMode: 'hls' },
      );

      expect(result.isSuccess()).toBe(true);
      expect(capturedOptions?.initialSegmentCount).toBe(1);
    });
  });

  describe('session replacement race condition', () => {
    it('stop event from Session A does not delete Session B at the same key', async () => {
      // Track which sessions the factory creates so we can reference them
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      // Create Session A
      const resultA = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-a',
        connection,
        { streamMode: 'hls' },
      );
      expect(resultA.isSuccess()).toBe(true);
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      // End Session A through the manager (simulates user stopping stream)
      await manager.endSession(channelUuid, 'hls');
      expect(manager.getHlsSession(channelUuid)).toBeUndefined();

      // Create Session B at the same key (user starts stream again)
      const resultB = await manager.getOrCreateHlsSession(
        channelUuid,
        'token-b',
        connection,
        { streamMode: 'hls' },
      );
      expect(resultB.isSuccess()).toBe(true);
      const sessionB = sessions[1]!;
      expect(sessionB).not.toBe(sessionA);
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);

      // Session A's delayed 'stop' event fires (stale event from the old session)
      sessionA.emit('stop');

      // Session B must still be in the map — the identity guard prevents deletion
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
    });

    it('cleanup event from Session A does not delete Session B at the same key', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      // Create Session A
      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;

      // End Session A
      await manager.endSession(channelUuid, 'hls');

      // Create Session B
      await manager.getOrCreateHlsSession(channelUuid, 'token-b', connection, {
        streamMode: 'hls',
      });
      const sessionB = sessions[1]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);

      // Session A's delayed 'cleanup' event fires
      sessionA.emit('cleanup');

      // Session B must still be in the map
      expect(manager.getHlsSession(channelUuid)).toBe(sessionB);
    });

    it('stop event from the current session DOES remove it from the map', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      // The session's own stop event should still clean up normally
      sessionA.emit('stop');

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
    });

    it('cleanup event from the current session DOES remove it from the map', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, 'token-a', connection, {
        streamMode: 'hls',
      });
      const sessionA = sessions[0]!;
      expect(manager.getHlsSession(channelUuid)).toBe(sessionA);

      sessionA.emit('cleanup');

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
    });
  });

  describe('connection staleness and recovery', () => {
    it('session is not stale when heartbeat is within threshold', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Heartbeat was just recorded by getOrCreateHlsSession → addConnection
      expect(session.isStale()).toBe(false);

      // Advance 60 seconds — well within the 120s default threshold
      vi.advanceTimersByTime(60_000);
      session.recordHeartbeat('10.0.0.1');
      expect(session.isStale()).toBe(false);
    });

    it('session becomes stale when heartbeat exceeds threshold', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past the 120s default threshold
      vi.advanceTimersByTime(121_000);
      expect(session.isStale()).toBe(true);
    });

    it('ghost heartbeat: recordHeartbeat after staleness removal does not prevent cleanup', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(121_000);

      // removeStaleConnections drops the connection
      expect(session.isStale()).toBe(true);
      // Connection is now gone from #connections
      expect(session.isKnownConnection('10.0.0.1')).toBe(false);

      // Client sends a segment request → recordHeartbeat is called
      // but this is a "ghost heartbeat" — it updates #heartbeats only
      session.recordHeartbeat('10.0.0.1');

      // Session is STILL stale because #connections is empty
      expect(session.isStale()).toBe(true);
    });

    it('addConnection after staleness removal restores the session', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(121_000);

      // Connection removed by staleness check
      expect(session.isStale()).toBe(true);
      expect(session.isKnownConnection('10.0.0.1')).toBe(false);

      // The fix: fragment route checks isKnownConnection and re-adds
      session.addConnection('10.0.0.1', { ip: '10.0.0.1' });
      session.recordHeartbeat('10.0.0.1');

      // Session is no longer stale
      expect(session.isStale()).toBe(false);
      expect(session.isKnownConnection('10.0.0.1')).toBe(true);
    });

    it('cleanupStaleSessions does not kill session with re-added connection', async () => {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      });

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });
      const session = sessions[0]!;

      // Advance past staleness threshold
      vi.advanceTimersByTime(121_000);

      // First cleanup pass: marks as stale, removes connection
      manager.cleanupStaleSessions();

      // Simulate the fix: client requests a segment, connection is re-added
      session.addConnection('10.0.0.1', { ip: '10.0.0.1' });
      session.recordHeartbeat('10.0.0.1');

      // Grace period elapses (15s default)
      vi.advanceTimersByTime(16_000);

      // Session should still be in the manager — cleanup was aborted
      // because #connections is non-empty when the timer fires
      expect(manager.getHlsSession(channelUuid)).toBe(session);
    });
  });

  // A channel with no onDemandConfig is continuous, not on-demand: its producer
  // is supposed to keep running with zero viewers. Retiring it stopped FFmpeg,
  // and the next request created a session that DELETES and rebuilds the
  // channel's working directory, so MEDIA-SEQUENCE restarted at 0 and the
  // published timeline reset - seen live as a channel that rewound on its own
  // about two minutes after its last viewer left.
  describe('idle producers on continuous (non-on-demand) channels', () => {
    async function idleSession(harness: HarnessOptions = {}) {
      const sessions: StubHlsSession[] = [];
      const manager = makeSessionManager((channel, options) => {
        const s = new StubHlsSession(channel, options);
        sessions.push(s);
        return s;
      }, harness);

      await manager.getOrCreateHlsSession(channelUuid, '10.0.0.1', connection, {
        streamMode: 'hls',
      });

      // The viewer leaves; nothing refreshes the heartbeat.
      vi.advanceTimersByTime(121_000);
      return { manager, session: sessions[0]! };
    }

    it('keeps producing when the channel is not on-demand', async () => {
      const { manager, session } = await idleSession({ onDemand: false });

      await manager.cleanupStaleSessions();
      // Advanced ASYNCHRONOUSLY on purpose. A synchronous advance would leave the
      // stop() promise chain unresolved when the assertion runs, so the session
      // would look alive even if it had in fact been retired - the test would
      // pass against the unfixed code.
      await vi.advanceTimersByTimeAsync(60_000);

      expect(manager.getHlsSession(channelUuid)).toBe(session);
      expect(session.state).toBe('started');
    });

    it('still retires an idle session when the channel IS on-demand', async () => {
      const { manager } = await idleSession({ onDemand: true });

      await manager.cleanupStaleSessions();
      // Async because the grace period fires a timer whose handler awaits
      // session.stop() before the session is dropped from the manager.
      await vi.advanceTimersByTimeAsync(16_000);

      expect(manager.getHlsSession(channelUuid)).toBeUndefined();
    });

    it('still prunes stale connections on a continuous channel', async () => {
      // The session survives, but the dead connection must not: a stale entry
      // also holds that client's recorded segment position, which the playlist
      // trim reads as its window anchor. Nothing else would ever clear it.
      const { manager, session } = await idleSession({ onDemand: false });

      await manager.cleanupStaleSessions();

      expect(session.isKnownConnection('10.0.0.1')).toBe(false);
      expect(manager.getHlsSession(channelUuid)).toBe(session);
    });

    it('retires nothing at all when the lineups cannot be read', async () => {
      // Fail closed: without the lineups we cannot tell which channels are
      // on-demand, and leaving a producer running is the safer error.
      const { manager, session } = await idleSession({
        lineupFailure: new Error('lineup store unavailable'),
      });

      await manager.cleanupStaleSessions();
      await vi.advanceTimersByTimeAsync(16_000);

      expect(manager.getHlsSession(channelUuid)).toBe(session);
    });
  });
});
