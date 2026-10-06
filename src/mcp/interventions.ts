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
