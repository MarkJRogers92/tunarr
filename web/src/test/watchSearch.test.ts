import { describe, expect, test } from 'vitest';
import { watchPageSearchSchema } from '@/routes/channels_/$channelId/watch.tsx';

describe('watch page search parameters', () => {
  test('autoplays when the watch URL has no autoplay override', () => {
    expect(watchPageSearchSchema.parse({}).noAutoPlay).toBe(false);
  });

  test('preserves explicit true and false autoplay overrides', () => {
    expect(watchPageSearchSchema.parse({ noAutoPlay: 'true' }).noAutoPlay).toBe(
      true,
    );
    expect(watchPageSearchSchema.parse({ noAutoPlay: 'false' }).noAutoPlay).toBe(
      false,
    );
  });

  test('fails closed to autoplay for an invalid override', () => {
    expect(watchPageSearchSchema.parse({ noAutoPlay: 'invalid' }).noAutoPlay).toBe(
      false,
    );
  });
});
