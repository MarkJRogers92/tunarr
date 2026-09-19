import type { HlsConfig } from 'hls.js';
import Hls from 'hls.js';
import { useCallback, useState } from 'react';

const hlsSupported = Hls.isSupported();

export const useHls = (userConfig?: Partial<HlsConfig>) => {
  const [hls, setHls] = useState<Hls | null>(null);

  const refreshHls = useCallback(() => {
    if (!hlsSupported) {
      return;
    }

    const newHls = new Hls({
      progressive: true,
      fragLoadingTimeOut: 30000,
      initialLiveManifestSize: 3, // About 10 seconds of playback needed before playing
      enableWorker: true,
      // The runway has to outlast the producer's rest, and it is measured.
      //
      // This was reverted to the hls.js defaults earlier today, on the reasoning that the
      // overnight run used them and they were therefore known-good. That reasoning missed
      // the thing the defaults were being protected by: the producer does not tick
      // steadily. Measured directly on this channel, the SERVED playlist was completely
      // static for 41 seconds - media sequence 231, discontinuity sequence 8, unchanged -
      // and then advanced 33 segments in one step. A viewer's runway is
      // `liveSyncDurationCount` x targetDuration, so at the default 3 x 4s it is 12
      // seconds against a 41 second gap: guaranteed starvation, every time the producer
      // rests. That is the freeze, and it is arithmetic rather than tuning.
      //
      // 45 x 4s = 180s of runway against that 41s gap, ~4x margin. `maxBufferLength` is
      // set above it so the buffer is never the binding limit rather than the runway.
      // This is a START POSITION, not a claim that 180s of media is downloaded - the
      // distinction that made an earlier version of this comment wrong.
      lowLatencyMode: false,
      liveSyncDurationCount: 45,
      maxBufferLength: 300,
      backBufferLength: 30,
      xhrSetup: (xhr) => {
        xhr.setRequestHeader(
          'Access-Control-Allow-Headers',
          'Content-Type, Accept, X-Requested-With',
        );
        xhr.setRequestHeader(
          'Access-Control-Allow-Origin',
          'http://localhost:5173',
        );
      },
      debug: import.meta.env.DEV,
      ...(userConfig ?? {}),
    });

    newHls.on(Hls.Events.MANIFEST_PARSED, function (_, data) {
      console.debug(
        'manifest loaded, found ' + data.levels.length + ' quality level',
      );
    });

    newHls.on(Hls.Events.ERROR, (_, data) => {
      console.error('HLS error', data);
    });

    newHls.on(Hls.Events.MEDIA_ATTACHED, function () {
      console.debug('video and hls.js are now bound together !');
    });

    setHls(newHls);
    return newHls;
  }, [userConfig]);

  const resetHls = useCallback(() => {
    setHls((prev) => {
      prev?.destroy();
      return null;
    });
    return refreshHls();
  }, [refreshHls]);

  return {
    hls,
    resetHls,
  };
};
