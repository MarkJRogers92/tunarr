import { FileStreamSource } from '../../../stream/types.ts';
import { EmptyFfmpegCapabilities } from '../capabilities/FfmpegCapabilities.ts';
import { AudioVolumeFilter } from '../filter/AudioVolumeFilter.ts';
import { LoudnormFilter } from '../filter/LoudnormFilter.ts';
import { PixelFormatYuv420P } from '../format/PixelFormat.ts';
import { AudioInputSource } from '../input/AudioInputSource.ts';
import { VideoInputSource } from '../input/VideoInputSource.ts';
import { AudioStream, VideoStream } from '../MediaStream.ts';
import { AudioState } from '../state/AudioState.ts';
import { DefaultPipelineOptions, FfmpegState } from '../state/FfmpegState.ts';
import { FrameState } from '../state/FrameState.ts';
import { FrameSize } from '../types.ts';
import { BasePipelineBuilder } from './BasePipelineBuilder.ts';

class NoopPipelineBuilder extends BasePipelineBuilder {
  protected setupVideoFilters(): void {}
}

describe('BasePipelineBuilder', () => {
  const audio = AudioInputSource.withStream(
    new FileStreamSource('/path/to/song.flac'),
    AudioStream.create({
      channels: 2,
      codec: 'flac',
      index: 0,
    }),
    AudioState.create({
      audioBitrate: 192,
      audioBufferSize: 192 * 2,
      audioChannels: 2,
      audioVolume: 150,
    }),
  );

  const video = VideoInputSource.withStream(
    new FileStreamSource('/path/to/video.mkv'),
    VideoStream.create({
      codec: 'h264',
      displayAspectRatio: '16:9',
      frameSize: FrameSize.withDimensions(1920, 900),
      index: 0,
      pixelFormat: new PixelFormatYuv420P(),
      providedSampleAspectRatio: null,
    }),
  );

  const state = FfmpegState.create({
    version: {
      versionString: 'n7.0.2-15-g0458a86656-20240904',
      majorVersion: 7,
      minorVersion: 0,
      patchVersion: 2,
      isUnknown: false,
    },
  });

  const frameState = new FrameState({
    isAnamorphic: false,
    paddedSize: FrameSize.FHD,
    scaledSize: FrameSize.FHD,
  });

  test('set audio volume filter', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        audioVolume: 150,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const volumeFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof AudioVolumeFilter,
    );

    expect(volumeFilter).toBeDefined();
    expect(volumeFilter?.filter).toEqual(`volume=1.500`);
  });

  test('ignore invalid audio volume filter', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        audioVolume: -100,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const volumeFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof AudioVolumeFilter,
    );

    expect(volumeFilter).toBeUndefined();
  });

  test('add loudnorm filter when loudnormConfig is set', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        loudnormConfig: { i: -24, lra: 7, tp: -2 },
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeDefined();
    expect(loudnormFilter?.filter).toEqual(
      'loudnorm=I=-24:LRA=7:TP=-2,aresample=48000',
    );
  });

  test('add loudnorm filter with custom offset gain', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        loudnormConfig: { i: -16, lra: 11, tp: -1, offsetGain: 3 },
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeDefined();
    expect(loudnormFilter?.filter).toEqual(
      'loudnorm=I=-16:LRA=11:TP=-1:offset=3,aresample=48000',
    );
  });

  test('use custom sample rate in loudnorm filter when audioSampleRate is set', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        audioSampleRate: 44.1,
        loudnormConfig: { i: -24, lra: 7, tp: -2 },
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeDefined();
    expect(loudnormFilter?.filter).toEqual(
      'loudnorm=I=-24:LRA=7:TP=-2,aresample=44100',
    );
  });

  test('do not add loudnorm filter when audio encoder is copy', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioEncoder: 'copy',
        loudnormConfig: { i: -24, lra: 7, tp: -2 },
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeUndefined();
  });

  test.each([
    { desc: 'i too low', config: { i: -70.1, lra: 7, tp: -2 } },
    { desc: 'i too high', config: { i: -4.9, lra: 7, tp: -2 } },
    { desc: 'lra too low', config: { i: -24, lra: 0.9, tp: -2 } },
    { desc: 'lra too high', config: { i: -24, lra: 50.1, tp: -2 } },
    { desc: 'tp too low', config: { i: -24, lra: 7, tp: -9.1 } },
    { desc: 'tp too high', config: { i: -24, lra: 7, tp: 0.1 } },
  ])('do not add loudnorm filter when $desc', ({ config }) => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        loudnormConfig: config,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeUndefined();
  });

  test.each([
    { desc: 'i at lower bound', config: { i: -70, lra: 7, tp: -2 } },
    { desc: 'i at upper bound', config: { i: -5, lra: 7, tp: -2 } },
    { desc: 'lra at lower bound', config: { i: -24, lra: 1, tp: -2 } },
    { desc: 'lra at upper bound', config: { i: -24, lra: 50, tp: -2 } },
    { desc: 'tp at lower bound', config: { i: -24, lra: 7, tp: -9 } },
    { desc: 'tp at upper bound', config: { i: -24, lra: 7, tp: 0 } },
  ])('add loudnorm filter when $desc', ({ config }) => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
        loudnormConfig: config,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeDefined();
  });

  test('do not add loudnorm filter when loudnormConfig is not set', () => {
    const audio = AudioInputSource.withStream(
      new FileStreamSource('/path/to/song.flac'),
      AudioStream.create({
        channels: 2,
        codec: 'flac',
        index: 0,
      }),
      AudioState.create({
        audioBitrate: 192,
        audioBufferSize: 192 * 2,
        audioChannels: 2,
      }),
    );

    const pipeline = new NoopPipelineBuilder(
      video,
      audio,
      null,
      null,
      null,
      EmptyFfmpegCapabilities,
    );

    const result = pipeline.build(state, frameState, DefaultPipelineOptions);

    const loudnormFilter = result.inputs.audioInput?.filterSteps.find(
      (step) => step instanceof LoudnormFilter,
    );

    expect(loudnormFilter).toBeUndefined();
  });

  /**
   * Input-throttle policy.
   *
   * `realtime` and "do not attach an input throttle" are different questions, and the
   * producer needs the second answered independently of the first. These tests assert on
   * the GENERATED ARGUMENTS, not on a log line or a state flag, because the failure this
   * guards against was precisely a flag that looked right while the command line still
   * carried `-readrate`.
   */
  describe('input throttling policy', () => {
    const framed = (
      overrides: Partial<ConstructorParameters<typeof FrameState>[0]>,
    ) =>
      new FrameState({
        isAnamorphic: false,
        paddedSize: FrameSize.FHD,
        scaledSize: FrameSize.FHD,
        ...overrides,
      });

    /**
     * Fresh input sources for every build, deliberately.
     *
     * `build()` MUTATES the input sources by appending options to them. Reusing one pair
     * across builds leaks the previous build's options into the next, which made an
     * earlier version of these tests fail while the implementation was correct: the
     * first build attached `-readrate`, and every later build inherited it.
     */
    const freshInputs = () => ({
      audio: AudioInputSource.withStream(
        new FileStreamSource('/path/to/song.flac'),
        AudioStream.create({ channels: 2, codec: 'flac', index: 0 }),
        AudioState.create({
          audioBitrate: 192,
          audioBufferSize: 192 * 2,
          audioChannels: 2,
          audioVolume: 100,
        }),
      ),
      video: VideoInputSource.withStream(
        new FileStreamSource('/path/to/video.mkv'),
        VideoStream.create({
          codec: 'h264',
          displayAspectRatio: '16:9',
          frameSize: FrameSize.withDimensions(1920, 900),
          index: 0,
          pixelFormat: new PixelFormatYuv420P(),
          providedSampleAspectRatio: null,
        }),
      ),
    });

    const buildWith = (
      overrides: Partial<ConstructorParameters<typeof FrameState>[0]>,
    ) => {
      const { video: v, audio: a } = freshInputs();
      return new NoopPipelineBuilder(
        v,
        a,
        null,
        null,
        null,
        EmptyFfmpegCapabilities,
      ).build(state, framed(overrides), DefaultPipelineOptions);
    };

    /** Every input argument, both streams, as FFmpeg would receive them. */
    const inputArgs = (result: ReturnType<typeof buildWith>) => [
      ...(result.inputs.videoInput?.getInputOptions() ?? []),
      ...(result.inputs.audioInput?.getInputOptions() ?? []),
    ];

    test('a realtime pipeline is throttled, exactly as before this change', () => {
      expect(inputArgs(buildWith({ realtime: true }))).toContain('-readrate');
    });

    test('the producer policy omits the throttle entirely, even at realtime', () => {
      const args = inputArgs(
        buildWith({ realtime: true, suppressInputThrottle: true }),
      );
      expect(args).not.toContain('-readrate');
      expect(args.filter((arg) => arg.includes('readrate'))).toEqual([]);
    });

    test('the policy is off by default, so unrelated callers are unaffected', () => {
      // No `suppressInputThrottle` supplied at all: FrameState default must be false, so
      // a realtime pipeline keeps the same command line it had before this change.
      const args = inputArgs(buildWith({ realtime: true }));
      expect(args).toContain('-readrate');
    });

    test('a non-realtime pipeline stays unpaced, with or without the policy', () => {
      expect(inputArgs(buildWith({ realtime: false }))).not.toContain(
        '-readrate',
      );
      expect(
        inputArgs(buildWith({ realtime: false, suppressInputThrottle: true })),
      ).not.toContain('-readrate');
    });

    // Stage 1 source receipt. Without `-copyts` a non-zero `-ss` leaves the
    // invocation's stats reporting the input position RELATIVE to the seek
    // landing, so nothing in the invocation can attest where in the source the
    // item came from. Measured on a real item: adding it left the produced
    // stream unchanged (same media PTS and segment boundaries; only the
    // wall-clock anchor moved by a constant per run) and made the stats report
    // the absolute source position - including detecting a seek that landed on
    // an earlier keyframe.
    const buildWithOffset = (ptsOffset: number) => {
      const { video: v, audio: a } = freshInputs();
      const withOffset = FfmpegState.create({
        version: {
          versionString: 'n7.0.2-15-g0458a86656-20240904',
          majorVersion: 7,
          minorVersion: 0,
          patchVersion: 2,
          isUnknown: false,
        },
      });
      withOffset.ptsOffset = ptsOffset;
      return new NoopPipelineBuilder(
        v,
        a,
        null,
        null,
        null,
        EmptyFfmpegCapabilities,
      ).build(
        withOffset,
        // `videoTrackTimescale` is REQUIRED by the offset branch and defaults to
        // null, so the branch is skipped without it - which is why nothing
        // covered it until now.
        framed({ videoTrackTimescale: 90_000 }),
        DefaultPipelineOptions,
      );
    };

    test('a non-zero output offset copies input timestamps, so the basis can be attested', () => {
      expect(inputArgs(buildWithOffset(90_000))).toContain('-copyts');
    });

    test('no output offset means no timestamp copying, leaving those invocations unchanged', () => {
      // Roughly 6% of logged invocations carry no offset. Copying timestamps
      // there would let pre-seek source positions into the published timeline -
      // unmeasured, and unnecessary, since those report no seek basis at all.
      expect(inputArgs(buildWithOffset(0))).not.toContain('-copyts');
    });

    test('the option is added once even when another path already added it', () => {
      const args = inputArgs(buildWithOffset(90_000));
      expect(args.filter((arg) => arg === '-copyts')).toHaveLength(1);
    });
  });
});
