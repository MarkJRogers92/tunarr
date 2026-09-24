/**
 * Shadow-only capture of what a real FFmpeg invocation actually did.
 *
 * This is the first half of the trusted source receipt: it records, per
 * invocation, the input it opened, the seek it was given, the transcode mode,
 * the OS process id, and the per-video-packet mux-pre stats FFmpeg produced.
 * It is enabled ONLY through `TUNARR_AUTOPILOT_RECEIPT` (a directory); unset
 * means every function here is inert and the FFmpeg command is byte-identical
 * to before. Nothing here feeds any airing ledger - it writes raw evidence to a
 * JSONL outbox for a later, verified consumer.
 *
 * It deliberately does NOT yet capture closed-segment PTS or the output/mux
 * process-origin correspondence, which the offline mapper
 * (`mapAuthenticatedStatsToClosedSegments`) also requires. Those are the next
 * step; this module exists so the capture path is real and provable first.
 */
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type AutopilotInvocationRecord = {
  kind: "invocation";
  invocationId: string;
  pid: number | null;
  /** The `-i` input the invocation opened (a path or a source URL). */
  sourceId: string | null;
  /** The `-ss` seek the invocation was given, in milliseconds. */
  requestedOffsetMs: number;
  mode: "transcode" | "copy";
  /** The stats output path, or null when only the invocation was recorded. */
  statsFile: string | null;
  args: string[];
  startedAt: string;
};

export type AutopilotCompletionRecord = {
  kind: "completion";
  invocationId: string;
  exitCode: number | null;
  signal: string | null;
  /** Number of stats rows captured; 0 means the stats file was empty/absent. */
  statsRows: number;
  finishedAt: string;
};

export type AutopilotReceiptRecord = AutopilotInvocationRecord | AutopilotCompletionRecord;

/** The receipt directory, or null when capture is disabled. */
export function receiptDirectory(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.TUNARR_AUTOPILOT_RECEIPT;
  return value !== undefined && value.trim() !== "" ? value : null;
}

/**
 * Whether to also inject the mux-pre stats options. Separate from the receipt
 * directory on purpose: recording the invocation alone does NOT touch the FFmpeg
 * command, so it can be deployed and observed with zero risk to playback, and the
 * real output-argument position can be confirmed before any command change.
 */
export function receiptStatsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.TUNARR_AUTOPILOT_RECEIPT_STATS;
  return value !== undefined && value !== "";
}

function parseSeek(value: string): number {
  const ms = /^(-?\d+(?:\.\d+)?)ms$/.exec(value);
  if (ms) return Math.round(Number(ms[1]));
  const seconds = Number(value);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0;
}

/**
 * Reads the invocation's own arguments, which are the authoritative record of
 * what was actually requested (so nothing has to be threaded down from
 * ProgramStream). The first `-i` is the opened input; `-ss` is the seek.
 */
export function parseInvocationArgs(args: readonly string[]): {
  sourceId: string | null;
  requestedOffsetMs: number;
  mode: "transcode" | "copy";
} {
  let sourceId: string | null = null;
  let requestedOffsetMs = 0;
  let mode: "transcode" | "copy" = "transcode";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "-ss" && next !== undefined) {
      requestedOffsetMs = parseSeek(next);
    } else if (arg === "-i" && next !== undefined && sourceId === null) {
      sourceId = next;
    } else if (
      (arg === "-c:v" || arg === "-codec:v" || arg === "-c") &&
      next === "copy"
    ) {
      mode = "copy";
    }
  }
  return { sourceId, requestedOffsetMs, mode };
}

const STATS_FMT = "{n},{pts},{tb},{ptsi},{tbi},{ni},{ti}";

/**
 * The mux-pre stats output options, exactly as validated offline in
 * `ffmpeg-source-probe-20260924/authenticated-replay/run.sh`.
 */
export function statsArgs(statsFile: string): string[] {
  return [
    "-stats_mux_pre:v:0",
    statsFile,
    "-stats_mux_pre_fmt:v:0",
    STATS_FMT,
  ];
}

/**
 * Inserts the stats options immediately before the output, which is the last
 * argument. They are output options, so appending them after the output would
 * place them where FFmpeg ignores or rejects them.
 */
export function insertStatsArgs(args: readonly string[], statsFile: string): string[] {
  if (args.length === 0) return [...args];
  return [...args.slice(0, -1), ...statsArgs(statsFile), args[args.length - 1]!];
}

/** How many non-empty stats rows a captured stats file holds. */
export function countStatsRows(text: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim() !== "").length;
}

let sequence = 0;

/**
 * Allocates the per-invocation paths. A file name is used (not a random temp
 * dir) so the stats file correlates with the invocation id by construction.
 */
export function allocateInvocation(directory: string): {
  invocationId: string;
  statsFile: string;
} {
  sequence += 1;
  const invocationId = `${Date.now()}-${sequence}-${randomUUID().slice(0, 8)}`;
  return { invocationId, statsFile: join(directory, `stats-${invocationId}.txt`) };
}

/** Appends one record to the JSONL outbox. Best-effort: capture never throws into playback. */
export function appendReceipt(directory: string, record: AutopilotReceiptRecord): void {
  try {
    mkdirSync(directory, { recursive: true });
    appendFileSync(join(directory, "receipt.jsonl"), `${JSON.stringify(record)}\n`);
  } catch {
    // A failed capture must never break a playing channel.
  }
}
