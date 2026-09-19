import {
  PixelFormatUnknown,
  type PixelFormat,
} from '@/ffmpeg/builder/format/PixelFormat.js';
import type { FrameSize } from '@/ffmpeg/builder/types.js';
import { FrameDataLocation } from '@/ffmpeg/builder/types.js';
import type { DataProps, Nullable } from '@/types/util.js';
import { isEqual, merge } from 'lodash-es';
import type { MarkOptional } from 'ts-essentials';
import type { VideoFormat } from '../constants.ts';
import { ColorFormat } from '../format/ColorFormat.ts';

type FrameStateFields = DataProps<FrameState>;

// Some fields are always required...
const DefaultFrameState: Omit<
  FrameStateFields,
  'scaledSize' | 'paddedSize' | 'isAnamorphic'
> = {
  realtime: false,
  suppressInputThrottle: false,
  videoFormat: 'h264',
  videoPreset: null,
  videoProfile: null,
  frameRate: null,
  videoTrackTimescale: null,
  videoBitrate: null,
  videoBufferSize: null,
  frameDataLocation: FrameDataLocation.Unknown,
  deinterlace: false,
  pixelFormat: null,
  bitDepth: 8,
  colorFormat: ColorFormat.unknown,
  forceSoftwareOverlay: false,
  infiniteLoop: false,
};

export type FrameStateOpts = MarkOptional<
  FrameStateFields,
  keyof typeof DefaultFrameState
>;

export class FrameState {
  scaledSize!: FrameSize;
  paddedSize!: FrameSize;
  croppedSize?: FrameSize;
  isAnamorphic!: boolean;
  realtime!: boolean;
  /**
   * Explicit producer policy, separate from `realtime`.
   *
   * `realtime` answers "hold this pipeline to wall clock". This answers "do not attach
   * an input throttle at all". They are different questions, and conflating them meant
   * the only way to get unpaced production was to answer the realtime question "no" on
   * behalf of every consumer of that boolean. When this is true the input throttle is
   * omitted regardless of `realtime`; when false, behaviour is exactly as before.
   */
  suppressInputThrottle!: boolean;
  videoFormat!: VideoFormat;
  videoPreset!: Nullable<string>;
  videoProfile!: Nullable<string>;
  frameRate!: Nullable<number>;
  videoTrackTimescale!: Nullable<number>;
  videoBitrate!: Nullable<number>;
  videoBufferSize!: Nullable<number>;
  frameDataLocation!: FrameDataLocation;
  deinterlace!: boolean;
  pixelFormat!: Nullable<PixelFormat>;
  colorFormat!: Nullable<ColorFormat>;
  infiniteLoop: boolean = false;

  forceSoftwareOverlay = false;

  constructor(fields: FrameStateOpts) {
    merge(this, DefaultFrameState, fields);
  }

  get bitDepth() {
    return this.pixelFormat?.bitDepth ?? 8;
  }

  update(fields: Partial<FrameStateFields>) {
    return new FrameState({ ...this, ...fields });
  }

  updateFrameLocation(location: FrameDataLocation) {
    if (this.frameDataLocation !== location) {
      return this.update({ frameDataLocation: location });
    }

    return this;
  }

  pixelFormatOrUnknown() {
    return this.pixelFormat ?? PixelFormatUnknown(this.bitDepth);
  }

  equals(other: FrameState): boolean {
    return this === other || isEqual(this, other);
  }
}
