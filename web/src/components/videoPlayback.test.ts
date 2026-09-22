import { describe, expect, test, vi } from 'vitest';
import { attemptVideoPlayback, supportsNativeHls } from './videoPlayback.ts';

describe('video playback helpers', () => {
  test('falls back to muted autoplay when audible autoplay is rejected', async () => {
    const video = {
      muted: false,
      play: vi
        .fn()
        .mockRejectedValueOnce(new Error('autoplay blocked'))
        .mockResolvedValueOnce(undefined),
    } as unknown as HTMLVideoElement;

    await expect(attemptVideoPlayback(video)).resolves.toBe('muted');
    expect(video.muted).toBe(true);
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  test('reports when the browser blocks both audible and muted playback', async () => {
    const video = {
      muted: false,
      play: vi.fn().mockRejectedValue(new Error('playback blocked')),
    } as unknown as HTMLVideoElement;

    await expect(attemptVideoPlayback(video)).resolves.toBe('blocked');
    expect(video.muted).toBe(false);
    expect(video.play).toHaveBeenCalledTimes(2);
  });

  test('recognizes Safari native HLS support', () => {
    const video = {
      canPlayType: vi.fn().mockReturnValue('maybe'),
    } as unknown as HTMLVideoElement;

    expect(supportsNativeHls(video)).toBe(true);
  });
});
