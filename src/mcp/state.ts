import { validateRepoPath } from "../security/paths.js";
import type { SessionObservation } from "../opencode/events.js";
import { deriveOperationalState, inactiveForMs, stalledThresholdMs } from "../state/derive.js";
import type {
  BridgeSession,
  InterventionRecord,
  OpencodeMessage,
  OpencodeStateReport,
  OperationalState,
  RawOpenCodeState,
  SessionAvailability,
  ToolResult
} from "../types.js";
import { safeTool } from "./results.js";
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
    notes: options.notes ?? []
  };
}

function isRepoAllowlistError(message: string): boolean {
  return message.includes("outside allowed roots");
}

/**
 * Build the operational state report for one bridge session.
 * Every field is either observed or null/[]: nothing is inferred beyond the signals below
 * (session status, event stream observation, recent messages, pending interventions).
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
    try {
      await client.getSession(session.opencodeSessionId);
    } catch (error) {
      const message = errorText(error);
      const missing = /failed:\s*404/.test(message);
      return unresolved(session, {
        authorized: true,
        availability: missing ? "session-not-found" : "server-unreachable",
        lastError: missing ? `opencode session not found: ${session.opencodeSessionId}` : message
      });
    }

    const observer = ctx.events?.ensure({
      baseUrl: managed.baseUrl,
      username: managed.username,
      password: managed.password
    });

    const [statuses, permissions, questions, messages] = await Promise.all([
      client.getSessionStatus().catch((error: unknown) => {
        notes.push(`session status unavailable: ${errorText(error, 200)}`);
        return null;
      }),
      client.listPermissions().catch((error: unknown) => {
        notes.push(`pending permissions unavailable: ${errorText(error, 200)}`);
        return null;
      }),
      client.listQuestions().catch((error: unknown) => {
        notes.push(`pending questions unavailable: ${errorText(error, 200)}`);
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
    const lastError =
      observerErrorAt !== null && (messageFailure === null || observerErrorAt >= messageFailure.at)
        ? observerError
        : messageFailure?.text ?? null;
    const lastErrorAt =
      messageFailure === null ? observerErrorAt : observerErrorAt !== null && observerErrorAt >= messageFailure.at ? observerErrorAt : messageFailure.at;

    const now = Date.now();
    const rawState = rawStateOf(statuses?.[ownSessionId]);
    const state: OperationalState = deriveOperationalState({
      now,
      rawState,
      pendingPermissions: ownPermissions.length,
      pendingQuestions: ownQuestions.length,
      lastActivityAt,
      lastErrorAt,
      stalledMs: stalledThresholdMs(ctx.config.stalledMs)
    });

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
        permissions: ownPermissions as unknown as InterventionRecord[],
        questions: ownQuestions as unknown as InterventionRecord[]
      },
      lastError,
      execution: {
        startedAt: busy && newestUserAt !== null ? new Date(newestUserAt).toISOString() : null,
        lastEventAt: observation?.lastEventAt ? new Date(observation.lastEventAt).toISOString() : null
      },
      notes
    };
  });
}
