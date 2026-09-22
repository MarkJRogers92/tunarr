const HLS_MIME_TYPE = 'application/vnd.apple.mpegurl';

export function supportsNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType(HLS_MIME_TYPE) !== '';
}

export async function attemptVideoPlayback(
  video: HTMLVideoElement,
): Promise<'playing' | 'muted' | 'blocked'> {
  try {
    await video.play();
    return 'playing';
  } catch {
    const wasMuted = video.muted;
    video.muted = true;

    try {
      await video.play();
      return 'muted';
    } catch {
      video.muted = wasMuted;
      return 'blocked';
    }
  }
}
