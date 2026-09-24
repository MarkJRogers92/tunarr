import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import type { ReadableFfmpegSettings } from '@/db/interfaces/ISettingsDB.js';
import { FfmpegProcess } from './FfmpegProcess.ts';

const FFMPEG = process.env.TUNARR_TEST_FFMPEG ?? '/opt/homebrew/bin/ffmpeg';
const available = existsSync(FFMPEG);

const settings = {
  ffmpegExecutablePath: FFMPEG,
  enableFileLogging: false,
  enableLogging: false,
  logLevel: 'warning',
} as unknown as ReadableFfmpegSettings;

const temporary: string[] = [];
afterEach(async () => {
  delete process.env.TUNARR_AUTOPILOT_RECEIPT;
  await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test.skipIf(!available)(
  'records the invocation and its mux-pre stats when capture is enabled',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tunarr-receipt-'));
    temporary.push(dir);
    const clip = join(dir, 'clip.mkv');
    execFileSync(FFMPEG, [
      '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1',
      '-c:v', 'libx264', '-y', clip,
    ]);

    process.env.TUNARR_AUTOPILOT_RECEIPT = dir;
    const output = join(dir, 'out.ts');
    const process_ = new FfmpegProcess(
      settings,
      'receipt-test',
      [
        '-hide_banner', '-nostdin', '-y', '-ss', '0', '-i', clip,
        '-map', '0:v:0', '-an', '-c:v', 'libx264',
        '-f', 'mpegts', output,
      ],
      dir,
    );

    await new Promise<void>((resolve) => {
      process_.once('exit', () => resolve());
      process_.start();
    });

    // The completion record is written asynchronously after the exit event.
    const receipt = join(dir, 'receipt.jsonl');
    const deadline = Date.now() + 5000;
    let lines: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      try {
        lines = (await readFile(receipt, 'utf-8'))
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        if (lines.some((line) => line.kind === 'completion')) break;
      } catch {
        // not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    const invocation = lines.find((line) => line.kind === 'invocation');
    const completion = lines.find((line) => line.kind === 'completion');
    expect(invocation).toMatchObject({ sourceId: clip, requestedOffsetMs: 0, mode: 'transcode' });
    expect(typeof invocation!.pid).toBe('number');
    expect(completion).toMatchObject({ exitCode: 0 });
    // Real per-video-packet stats were captured for the one-frame-ish clip.
    expect(completion!.statsRows as number).toBeGreaterThan(0);
  },
  30_000,
);
