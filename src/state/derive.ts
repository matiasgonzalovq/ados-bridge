/**
 * Operational state derivation for a bridge session.
 *
 * OpenCode's raw status alone is not trustworthy: a session waiting for a human answer
 * (question/permission) or a session stuck in busy both report "busy". We therefore
 * combine several signals and derive one of five states.
 *
 * Priority (highest first):
 *   1. pending permission or question        -> waiting-human
 *   2. newest signal is a real error         -> error
 *   3. busy + activity within the threshold  -> busy
 *   4. busy + no activity for the threshold  -> stalled
 *   5. otherwise                             -> idle
 */

import type { OperationalState, RawOpenCodeState } from "../types.js";

export const DEFAULT_STALLED_MS = 120_000;
export const MIN_STALLED_MS = 5_000;

export type StateDerivationInput = {
  /** Current time in epoch milliseconds. */
  now: number;
  /** Raw state from GET /session/status (`null` when the session is absent, which means idle). */
  rawState: RawOpenCodeState;
  pendingPermissions: number;
  pendingQuestions: number;
  /** Epoch ms of the most recent observed activity (event or message). Null when nothing was observed. */
  lastActivityAt: number | null;
  /** Epoch ms of the newest error signal. Null when there is none. */
  lastErrorAt: number | null;
  /** How long a busy session may stay silent before it is reported as stalled. */
  stalledMs?: number;
};

export function stalledThresholdMs(configured?: number): number {
  if (typeof configured !== "number" || !Number.isFinite(configured)) return DEFAULT_STALLED_MS;
  return Math.max(MIN_STALLED_MS, Math.floor(configured));
}

export function deriveOperationalState(input: StateDerivationInput): OperationalState {
  if (input.pendingPermissions > 0 || input.pendingQuestions > 0) return "waiting-human";

  // An error wins only while it is the newest signal; any later activity clears it.
  if (input.lastErrorAt !== null && (input.lastActivityAt === null || input.lastErrorAt >= input.lastActivityAt)) {
    return "error";
  }

  const busy = input.rawState === "busy" || input.rawState === "retry";
  if (!busy) return "idle";

  // Busy with no observed activity at all: no evidence of recent work, so do not falsely
  // report "busy" as active operation.  Treat as stalled so the UI can surface that
  // the session is stuck waiting for a human or has effectively completed.
  if (input.lastActivityAt != null && input.rawState !== null && (input.rawState === "busy" || input.rawState === "retry")) {
    const diff = input.now - input.lastActivityAt;
    // If there IS an activity timestamp but it's already beyond the stalled threshold,
    // report stalled immediately without needing lastActivityAt to be null.
    if (diff >= stalledThresholdMs(input.stalledMs)) return "stalled";
  }
  // When lastActivityAt is null (no observed activity) and rawState is busy/retry,
  // we still want to avoid falsely reporting "busy" as active work — treat as stalled.
  if (input.lastActivityAt == null && (input.rawState === "busy" || input.rawState === "retry")) return "stalled";

  const threshold = stalledThresholdMs(input.stalledMs);
  // At this point lastActivityAt is guaranteed non-null because the null cases
  // were already handled by the early returns above.
  return input.now - input.lastActivityAt! >= threshold ? "stalled" : "busy";
}

export function inactiveForMs(now: number, lastActivityAt: number | null): number | null {
  if (lastActivityAt === null) return null;
  return Math.max(0, now - lastActivityAt);
}
