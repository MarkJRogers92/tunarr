import { Trans } from '@lingui/react/macro';
import { Route } from '@/routes/channels_/$channelId/watch.tsx';
import { PlayArrow, Replay } from '@mui/icons-material';
import { Alert, Box } from '@mui/material';
import Button from '@mui/material/Button';
import { useBlocker, useLocation } from '@tanstack/react-router';
import Hls, { type ErrorData, type Events } from 'hls.js';
import { isError, isNil } from 'lodash-es';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChannelTranscodeConfig } from '../hooks/settingsHooks.ts';
import { useHls } from '../hooks/useHls.ts';
import { useSettings } from '../store/settings/selectors.ts';
import {
  attemptVideoPlayback,
  supportsNativeHls,
} from './videoPlayback.ts';

type VideoProps = {
  channelId: string;
};

export default function Video({ channelId }: VideoProps) {
  const { backendUri } = useSettings();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const { hls, resetHls } = useHls();
  const hlsSupported = useMemo(() => Hls.isSupported(), []);
  const nativeHlsSupported = useMemo(() => {
    if (typeof document === 'undefined') {
      return false;
    }
    return supportsNativeHls(document.createElement('video'));
  }, []);
  const [loadedStream, setLoadedStream] = useState<boolean | Error>(false);
  const { data: transcodeConfig } = useChannelTranscodeConfig(channelId);
  const { noAutoPlay } = Route.useSearch();
  const [manuallyStarted, setManuallyStarted] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const autoRetryAttempted = useRef(false);
  const location = useLocation();

  const autoPlayEnabled = !noAutoPlay;

  const canLoadStream = useMemo(() => {
    const initialized =
      !isNil(videoRef.current) && (!isNil(hls) || nativeHlsSupported);
    const alreadedLoadedOrError = isError(loadedStream) || loadedStream;
    const validSettings =
      !isNil(transcodeConfig) && !['ac3'].includes(transcodeConfig.audioFormat);
    return initialized && !alreadedLoadedOrError && validSettings;
  }, [hls, loadedStream, nativeHlsSupported, transcodeConfig]);

  const [isBlocked, setIsBlocked] = useState(false);

  const blocker = useBlocker({
    condition: isBlocked,
  });

  useEffect(() => {
    setIsBlocked(true);
  }, [location]);

  // Unload HLS when navigating away
  useEffect(() => {
    if (blocker.status === 'blocked') {
      if (videoRef.current) {
        videoRef.current.pause();
      }
      if (hls) {
        hls.detachMedia();
        hls.destroy();
      }
      blocker.proceed();
    }
  }, [blocker, hls, videoRef]);

  const startVideoPlayback = useCallback(async () => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const result = await attemptVideoPlayback(video);
    setPlaybackBlocked(result === 'blocked');
  }, []);

  const retryStream = useCallback(() => {
    if (autoRetryAttempted.current) {
      return;
    }

    autoRetryAttempted.current = true;
    resetHls();
    setLoadedStream(false);
  }, [resetHls]);

  const reloadStream = useCallback(() => {
    autoRetryAttempted.current = false;
    setPlaybackBlocked(false);
    setManuallyStarted(true);
    retryStream();
  }, [retryStream]);

  useEffect(() => {
    if (!hls) {
      return;
    }

    const handleManifestParsed = () => {
      autoRetryAttempted.current = false;
      void startVideoPlayback();
    };

    const handleHlsError = (_event: Events.ERROR, data: ErrorData) => {
      if (!data.fatal) {
        return;
      }

      retryStream();
    };

    hls.on(Hls.Events.MANIFEST_PARSED, handleManifestParsed);
    hls.on(Hls.Events.ERROR, handleHlsError);

    return () => {
      hls.off(Hls.Events.MANIFEST_PARSED, handleManifestParsed);
      hls.off(Hls.Events.ERROR, handleHlsError);
    };
  }, [hls, retryStream, startVideoPlayback]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const handleVideoError = () => {
      retryStream();
    };

    video.addEventListener('error', handleVideoError);
    return () => {
      video.removeEventListener('error', handleVideoError);
    };
  }, [retryStream]);

  useEffect(() => {
    const video = videoRef.current;
    if (
      !(autoPlayEnabled || manuallyStarted) ||
      !video ||
      !canLoadStream
    ) {
      return;
    }

    setPlaybackBlocked(false);
    setLoadedStream(true);

    const streamUrl = `${backendUri}/stream/channels/${channelId}.m3u8`;
    if (hls) {
      hls.loadSource(streamUrl);
      hls.attachMedia(video);
      return;
    }

    if (nativeHlsSupported) {
      const handleCanPlay = () => {
        void startVideoPlayback();
      };

      video.addEventListener('canplay', handleCanPlay, { once: true });
      video.src = streamUrl;
      video.load();

      return () => {
        video.removeEventListener('canplay', handleCanPlay);
      };
    }
  }, [
    autoPlayEnabled,
    backendUri,
    canLoadStream,
    channelId,
    hls,
    manuallyStarted,
    nativeHlsSupported,
    startVideoPlayback,
  ]);

  useEffect(() => {
    resetHls();
    setLoadedStream(false);
    setManuallyStarted(false);
    autoRetryAttempted.current = false;
  }, [channelId, resetHls]);

  const renderVideo = () => {
    if (!hlsSupported && !nativeHlsSupported) {
      return (
        <Alert severity="error" sx={{ my: 2 }}>
          <Trans>HLS not supported in this browser!</Trans>
        </Alert>
      );
    }

    if (!isNil(transcodeConfig) && transcodeConfig.audioFormat === 'ac3') {
      return (
        <Alert severity="warning" sx={{ my: 2 }}>
          <Trans>
            Tunarr is currently configured to use the AC3 audio encoder. This
            audio format is not supported by browsers. The resultant stream
            will likely not have audio or will not play at all.
          </Trans>
        </Alert>
      );
    }

    return (
      <Box sx={{ mb: 2 }}>
        <Box sx={{ width: '100%' }}>
          <video
            style={{ width: '100%' }}
            controls
            autoPlay
            playsInline
            ref={videoRef}
          />
        </Box>
        {playbackBlocked && (
          <Alert severity="info" sx={{ mt: 1 }}>
            <Trans>Click Play to start this stream in your browser.</Trans>
          </Alert>
        )}
        <Button
          variant="contained"
          onClick={() => reloadStream()}
          startIcon={loadedStream ? <Replay /> : <PlayArrow />}
        >
          {loadedStream ? <Trans>Reload Stream</Trans> : <Trans>Load Stream</Trans>}
        </Button>
      </Box>
    );
  };

  return <Box>{renderVideo()}</Box>;
}
