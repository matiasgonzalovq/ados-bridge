import { destructiveCheckpoint, type DestructiveCheckpoint } from "../security/checkpoints.js";
import type { InterventionRecord, ToolResult } from "../types.js";
import { checkpointResult, safeTool, toolResult } from "./results.js";
import { requireSession, type RegisterContext } from "./session.js";

export type InterventionsResult = {
  session: { bridgeSessionId: string; opencodeSessionId: string };
  permissions: InterventionRecord[];
  questions: InterventionRecord[];
};

/**
 * Pending permissions and questions for one bridge session.
 * OpenCode's list endpoints are server-wide, so results are filtered by session id.
 * Polling works even when the bridge connected to the event stream late.
 */
export async function listInterventions(
  ctx: RegisterContext,
  bridgeSessionId: string
): Promise<ToolResult<InterventionsResult | { ok: false; error: string }>> {
  return await safeTool(async () => {
    const bridge = await requireSession(ctx, bridgeSessionId);
    const managed = await ctx.processManager.ensure(bridge.repoPath);
    const client = ctx.processManager.clientFor(managed);
    const [permissions, questions] = await Promise.all([client.listPermissions(), client.listQuestions()]);
    const own = (item: { sessionID?: string }) => item.sessionID === bridge.opencodeSessionId;
    return {
      session: { bridgeSessionId: bridge.bridgeSessionId, opencodeSessionId: bridge.opencodeSessionId },
      permissions: permissions.filter(own) as unknown as InterventionRecord[],
      questions: questions.filter(own) as unknown as InterventionRecord[]
    };
  });
}

export type InterventionPartition = {
  /** Records that can still change the session (safely counted as waiting-human). */
  actionable: InterventionRecord[];
  /** Records OpenCode can no longer act on; excluded from waiting-human. */
  stale: InterventionRecord[];
  /** Non-fatal observation problems (a stale check that could not be completed). */
  notes: string[];
};

type MessageLookup = {
  getMessageIfExists(sessionId: string, messageID: string): Promise<unknown>;
};

function owningMessageId(record: InterventionRecord): string | null {
  const tool = record.tool;
  if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return null;
  const messageID = (tool as { messageID?: unknown }).messageID;
  return typeof messageID === "string" && messageID.length > 0 ? messageID : null;
}

function recordId(record: InterventionRecord): string {
  return typeof record.id === "string" && record.id.length > 0 ? record.id : "unknown";
}

/**
 * True only when the owning message itself carries a completion timestamp.
 * OpenCode stamps `assistantMessage.time.completed` in `SessionProcessor.cleanup()`,
 * which runs both on normal completion and on abort (where tool parts are closed with
 * "Tool execution aborted"), so a completed owning message means the call the record
 * belongs to is already over.
 */
function owningMessageCompleted(message: unknown): boolean {
  if (typeof message !== "object" || message === null) return false;
  const info = (message as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return false;
  const time = (info as { time?: unknown }).time;
  if (typeof time !== "object" || time === null) return false;
  return typeof (time as { completed?: unknown }).completed === "number";
}

/**
 * Split OpenCode's pending permission/question records into actionable and stale ones.
 *
 * OpenCode keeps a record in `GET /permission` / `GET /question` while the ask is awaited,
 * and an aborted message does not always clear it, so the raw list alone can outlive the
 * work it belongs to. A record whose owning message (`tool.messageID`, stamped by every
 * `ctx.ask`/`question.ask` call) already completed can no longer gate that tool call and
 * must not force waiting-human. Everything else - records without an owning message, a
 * message OpenCode no longer returns, or a lookup that failed - stays actionable, so a
 * genuine human request is never suppressed.
 */
export async function reconcileInterventions(
  client: MessageLookup,
  opencodeSessionId: string,
  kind: "permission" | "question",
  records: InterventionRecord[]
): Promise<InterventionPartition> {
  const partition: InterventionPartition = { actionable: [], stale: [], notes: [] };
  const outcomes = await Promise.all(
    records.map(async (record) => {
      const messageID = owningMessageId(record);
      if (messageID === null) return { record, messageID, stale: false, failed: false };
      try {
        const message = await client.getMessageIfExists(opencodeSessionId, messageID);
        return { record, messageID, stale: owningMessageCompleted(message), failed: false };
      } catch (error) {
        return { record, messageID, stale: false, failed: true, error };
      }
    })
  );
  for (const outcome of outcomes) {
    if (outcome.stale) {
      partition.stale.push(outcome.record);
      partition.notes.push(
        `stale ${kind} ${recordId(outcome.record)} ignored: owning message ${outcome.messageID} already completed`
      );
      continue;
    }
    partition.actionable.push(outcome.record);
    if (outcome.failed) {
      const message = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
      partition.notes.push(`stale check unavailable for ${kind} ${recordId(outcome.record)}: ${message}`);
    }
  }
  return partition;
}

export type AnswerQuestionInput = {
  bridgeSessionId: string;
  questionId: string;
  /** One entry per question in the pending request, each holding the selected labels. */
  answers: string[][];
  confirmCheckpoint?: boolean;
};

export type AnswerQuestionResult = {
  ok: boolean;
  questionId: string;
  answers: string[][];
  answered: boolean;
};

/**
 * Answer a pending question. Requires an explicit human confirmation
 * (`confirmCheckpoint=true`) whenever checkpoints are enabled: questions are only ever
 * answered deliberately, never invented by the model.
 */
export async function answerQuestion(
  ctx: RegisterContext,
  input: AnswerQuestionInput
): Promise<ToolResult<AnswerQuestionResult | { ok: false; error: string } | DestructiveCheckpoint>> {
  const gate = destructiveCheckpoint({
    enabled: ctx.config.checkpoints,
    confirmed: input.confirmCheckpoint ?? false,
    tool: "opencode_answer_question",
    action: "answer a pending opencode question",
    target: input.questionId
  });
  if (gate) return checkpointResult(gate);

  return await safeTool(async () => {
    if (!Array.isArray(input.answers) || input.answers.length === 0) {
      throw new Error("answers must contain one entry per question (array of selected labels)");
    }
    for (const entry of input.answers) {
      if (!Array.isArray(entry) || entry.some((label) => typeof label !== "string" || label.length === 0)) {
        throw new Error("each answer must be a non-empty array of option labels");
      }
    }
    const bridge = await requireSession(ctx, input.bridgeSessionId);
    const managed = await ctx.processManager.ensure(bridge.repoPath);
    const client = ctx.processManager.clientFor(managed);
    const answered = await client.answerQuestion(input.questionId, input.answers);
    return { ok: true, questionId: input.questionId, answers: input.answers, answered: Boolean(answered) };
  });
}
