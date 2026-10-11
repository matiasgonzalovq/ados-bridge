import { validateRepoPath } from "../security/paths.js";
import type { SessionObservation } from "../opencode/events.js";
import { deriveOperationalState, inactiveForMs, stalledThresholdMs } from "../state/derive.js";
import type {
  BridgeSession,
  CompletionEvidence,
  InterventionRecord,
  OpencodeMessage,
  OpencodeStateReport,
  OperationalState,
  RawOpenCodeState,
  SessionAvailability,
  ToolResult
} from "../types.js";
import { safeTool } from "./results.js";
import { reconcileInterventions } from "./interventions.js";
import type { RegisterContext } from "./session.js";

const MESSAGE_SAMPLE = 10;
const RAW_STATES: ReadonlySet<string> = new Set(["idle", "busy", "retry"]);

type MessageError = { at: number; text: string };

function errorText(error: unknown, limit = 500): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function timeOf(info: Record<string, unknown>): number | null {
  const time = info.time as Record<string, unknown> | undefined;
  const completed = typeof time?.completed === "number" ? time.completed : null;
  const created = typeof time?.created === "number" ? time.created : null;
  return completed ?? created;
}

function messageErrorOf(messages: OpencodeMessage[]): MessageError | null {
  let newest: MessageError | null = null;
  for (const message of messages) {
    const info = message.info;
    const error = info.error as Record<string, unknown> | undefined;
    if (!error) continue;
    const at = timeOf(info);
    if (at === null) continue;
    const name = typeof error.name === "string" ? error.name : undefined;
    const raw = typeof error.message === "string" ? error.message : JSON.stringify(error);
    const text = errorText(`${name ?? "error"}${raw ? `: ${raw}` : ""}`);
    if (!newest || at >= newest.at) newest = { at, text };
  }
  return newest;
}

function rawStateOf(status: Record<string, unknown> | undefined): RawOpenCodeState {
  const type = status?.type;
  return typeof type === "string" && RAW_STATES.has(type) ? (type as RawOpenCodeState) : null;
}

function unresolved(
  session: BridgeSession,
  options: { authorized: boolean; availability: SessionAvailability; lastError: string | null; notes?: string[] }
): OpencodeStateReport {
  return {
    project: { repoPath: session.repoPath, authorized: options.authorized },
    session: { bridgeSessionId: session.bridgeSessionId, opencodeSessionId: session.opencodeSessionId },
    state: "error",
    availability: options.availability,
    rawOpenCodeState: null,
    lastActivityAt: null,
    inactiveForMs: null,
    currentOperation: null,
    lastOperation: null,
    pendingInterventions: { permissions: [], questions: [] },
    lastError: options.lastError,
    execution: { startedAt: null, lastEventAt: null },
    notes: options.notes ?? [],
    // No observation completed: nothing here is safe to proceed on.
    observationComplete: false,
    completionEvidence: "not-applicable"
  };
}

function isRepoAllowlistError(message: string): boolean {
  return message.includes("outside allowed roots");
}

/** Terminal outcomes stamped by opencode itself (v2 `Session.Info`). */
const TERMINAL_OUTCOMES: ReadonlySet<string> = new Set(["succeeded", "failed", "interrupted"]);

/**
 * Server-stamped completion evidence from a session payload, reused from the
 * existence check so no extra request is needed. v1 payloads lack these
 * fields and yield null (unknown, never a claim in either direction).
 */
function sessionCompletionOf(value: unknown): { outcome?: string; idleAt?: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: { outcome?: string; idleAt?: number } = {};
  if (typeof record.outcome === "string" && TERMINAL_OUTCOMES.has(record.outcome)) {
    result.outcome = record.outcome;
  }
  const time = record.time;
  if (typeof time === "object" && time !== null && !Array.isArray(time)) {
    const idle = (time as Record<string, unknown>).idle;
    if (typeof idle === "number" && Number.isFinite(idle)) result.idleAt = idle;
  }
  return result;
}

/**
 * Build the operational state report for one bridge session.
 * Every field is either observed or null/[]: nothing is inferred beyond the signals below
 * (session status, event stream observation, recent messages, pending interventions).
 *
 * Unknown-vs-empty contract: a failed intervention read (permissions/questions)
 * is recorded in `notes` as explicitly NOT a confirmed zero and contributes no
 * pending count. Counts — and therefore `waiting-human` — come only from
 * confirmed records. Completion is likewise never claimed from mere absence:
 * `idle` means "no evidence of work", while server-stamped terminal evidence
 * (`outcome`, `time.idle`, reused from the existence check at no extra cost)
 * is reported verbatim in `notes` (and as `lastError` for failed outcomes when
 * no newer error signal exists).
 */
export async function buildReport(
  ctx: RegisterContext,
  bridgeSessionId: string
): Promise<ToolResult<OpencodeStateReport | { ok: false; error: string }>> {
  return await safeTool(async () => {
    const stored = await ctx.state.getSession(bridgeSessionId);

    let repoPath: string;
    try {
      repoPath = await validateRepoPath(stored.repoPath, ctx.config.allowedRoots);
    } catch (error) {
      const message = errorText(error);
      // Deny by default: never contact opencode for a repo we cannot confirm as allowed,
      // and never claim authorization for a path we could not validate at all.
      const outsideAllowed = isRepoAllowlistError(message);
      return unresolved(stored, {
        authorized: false,
        availability: outsideAllowed ? "repo-not-authorized" : "stale-repo",
        lastError: message
      });
    }

    const session: BridgeSession = { ...stored, repoPath };
    const notes: string[] = [];

    let managed;
    try {
      managed = await ctx.processManager.ensure(repoPath);
    } catch (error) {
      return unresolved(session, {
        authorized: true,
        availability: "server-unreachable",
        lastError: `opencode server unavailable: ${errorText(error)}`
      });
    }

    const client = ctx.processManager.clientFor(managed);
    // The payload is kept: on v2 it carries server-stamped completion evidence
    // (`outcome`, `time.idle`) reused below at no extra request cost.
    let sessionInfo: unknown;
    try {
      sessionInfo = await client.getSession(session.opencodeSessionId);
    } catch (error) {
      const message = errorText(error);
      const missing = /failed:\s*404/.test(message);
      return unresolved(session, {
        authorized: true,
        availability: missing ? "session-not-found" : "server-unreachable",
        lastError: missing ? `opencode session not found: ${session.opencodeSessionId}` : message
      });
    }
    const completion = sessionCompletionOf(sessionInfo);
    if (completion.outcome !== undefined) {
      notes.push(`completion corroborated: opencode outcome=${completion.outcome}`);
    }
    if (completion.idleAt !== undefined) {
      notes.push(`session idle since ${new Date(completion.idleAt).toISOString()} (server-reported)`);
    }

    const observer = ctx.events?.ensure({
      baseUrl: managed.baseUrl,
      username: managed.username,
      password: managed.password
    });

    // Tri-state reads: a failure yields null (unknown), which contributes no
    // pending count. The note states explicitly that zero is NOT confirmed, so
    // an unknown query can never be mistaken for a confirmed empty list.
    const [statuses, permissions, questions, messages] = await Promise.all([
      client.getSessionStatus().catch((error: unknown) => {
        notes.push(`session status unavailable: ${errorText(error, 200)}`);
        return null;
      }),
      client.listPermissions(session.opencodeSessionId).catch((error: unknown) => {
        notes.push(`pending permissions unknown (zero NOT confirmed): ${errorText(error, 200)}`);
        return null;
      }),
      client.listQuestions(session.opencodeSessionId).catch((error: unknown) => {
        notes.push(`pending questions unknown (zero NOT confirmed): ${errorText(error, 200)}`);
        return null;
      }),
      client.getMessages(session.opencodeSessionId, MESSAGE_SAMPLE).catch((error: unknown) => {
        notes.push(`recent messages unavailable: ${errorText(error, 200)}`);
        return null;
      })
    ]);

    const ownSessionId = session.opencodeSessionId;
    const ownPermissions = (permissions ?? []).filter((item) => item.sessionID === ownSessionId);
    const ownQuestions = (questions ?? []).filter((item) => item.sessionID === ownSessionId);

    // OpenCode can keep listing a permission/question whose owning message is already
    // completed (e.g. after opencode_abort). Reconcile before deriving state so a stale
    // record never forces waiting-human, while every record we cannot prove obsolete
    // stays counted as a real pending human request.
    const [permissionPartition, questionPartition] = await Promise.all([
      reconcileInterventions(client, ownSessionId, "permission", ownPermissions as unknown as InterventionRecord[]),
      reconcileInterventions(client, ownSessionId, "question", ownQuestions as unknown as InterventionRecord[])
    ]);
    notes.push(...permissionPartition.notes, ...questionPartition.notes);

    const recent = messages ?? [];
    const observation: SessionObservation | null = observer?.snapshot(ownSessionId) ?? null;

    const messageTimes = recent.map((message) => timeOf(message.info)).filter((value): value is number => value !== null);
    const newestMessageAt = messageTimes.length > 0 ? Math.max(...messageTimes) : null;
    const lastActivityCandidates = [observation?.lastActivityAt ?? null, newestMessageAt].filter(
      (value): value is number => value !== null
    );
    const lastActivityAt = lastActivityCandidates.length > 0 ? Math.max(...lastActivityCandidates) : null;

    const messageFailure = messageErrorOf(recent);
    const observerErrorAt = observation?.lastErrorAt ?? null;
    const observerError = observation?.lastError ?? null;
    // Server-stamped terminal failure is the lowest-priority error source: it
    // is always reported, but never overrides a newer, more specific signal.
    // Its time is the server-reported idle timestamp when present; without one
    // it is displayed in `lastError` without driving state (no date invented).
    const outcomeFailureText =
      completion.outcome === "failed" || completion.outcome === "interrupted"
        ? `opencode reported outcome: ${completion.outcome}`
        : null;
    const outcomeFailureAt = outcomeFailureText !== null ? (completion.idleAt ?? null) : null;
    const lastError =
      observerErrorAt !== null && (messageFailure === null || observerErrorAt >= messageFailure.at)
        ? observerError
        : (messageFailure?.text ?? outcomeFailureText);
    const lastErrorAt =
      messageFailure === null
        ? (observerErrorAt ?? outcomeFailureAt)
        : observerErrorAt !== null && observerErrorAt >= messageFailure.at
          ? observerErrorAt
          : messageFailure.at;

    const now = Date.now();
    const rawState = rawStateOf(statuses?.[ownSessionId]);
    const state: OperationalState = deriveOperationalState({
      now,
      rawState,
      pendingPermissions: permissionPartition.actionable.length,
      pendingQuestions: questionPartition.actionable.length,
      lastActivityAt,
      lastErrorAt,
      stalledMs: stalledThresholdMs(ctx.config.stalledMs)
    });

    // Safety guard (CP1.49-B): complete only when every layer answered.
    const observationComplete =
      statuses !== null && permissions !== null && questions !== null && messages !== null;
    const completionEvidence: CompletionEvidence =
      state !== "idle"
        ? "not-applicable"
        : completion.outcome === "succeeded"
          ? "corroborated-success"
          : completion.outcome === "failed" || completion.outcome === "interrupted"
            ? "corroborated-failure"
            : "uncorroborated";

    const busy = rawState === "busy" || rawState === "retry";
    let newestUserAt: number | null = null;
    for (const message of recent) {
      if (message.info.role !== "user") continue;
      const at = timeOf(message.info);
      if (at !== null && (newestUserAt === null || at > newestUserAt)) newestUserAt = at;
    }

    return {
      project: { repoPath: session.repoPath, authorized: true },
      session: { bridgeSessionId: session.bridgeSessionId, opencodeSessionId: ownSessionId },
      state,
      availability: "ready",
      rawOpenCodeState: rawState,
      lastActivityAt: lastActivityAt === null ? null : new Date(lastActivityAt).toISOString(),
      inactiveForMs: inactiveForMs(now, lastActivityAt),
      currentOperation:
        busy && observation?.current
          ? { type: observation.current.type, at: new Date(observation.current.at).toISOString() }
          : null,
      lastOperation: observation?.lastCompletion
        ? { type: observation.lastCompletion.type, at: new Date(observation.lastCompletion.at).toISOString() }
        : null,
      pendingInterventions: {
        permissions: permissionPartition.actionable,
        questions: questionPartition.actionable
      },
      lastError,
      execution: {
        startedAt: busy && newestUserAt !== null ? new Date(newestUserAt).toISOString() : null,
        lastEventAt: observation?.lastEventAt ? new Date(observation.lastEventAt).toISOString() : null
      },
      observationComplete,
      completionEvidence,
      notes
    };
  });
}

/**
 * The single choke point for automated completion claims (CP1.49-B guard).
 *
 * Returns true ONLY for `idle` reports with complete observation and
 * server-stamped `outcome: succeeded`. Every other combination — incomplete
 * observation, uncorroborated or failed idle, any non-idle state — must keep
 * polling or escalate to a human. In particular this never authorizes, on its
 * own: continuing an execution, declaring a task complete, answering an
 * intervention, or starting work that depends on the previous result.
 * Automated consumers must call this instead of parsing `notes[]` text.
 */
export function isCompletionSafe(
  report: Pick<OpencodeStateReport, "state" | "observationComplete" | "completionEvidence">
): boolean {
  return (
    report.state === "idle" && report.observationComplete && report.completionEvidence === "corroborated-success"
  );
}
