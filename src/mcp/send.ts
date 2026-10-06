import { randomUUID } from "node:crypto";
import type { JsonValue, ToolResult } from "../types.js";
import { safeTool } from "./results.js";
import { requireSession, type RegisterContext } from "./session.js";

export type SendPromptInput = {
  bridgeSessionId: string;
  text: string;
  async?: boolean;
  providerID?: string;
  modelID?: string;
  agent?: string;
  system?: string;
  noReply?: boolean;
  /**
   * Stable idempotency key. Callers that retry after an ambiguous failure MUST reuse it:
   * opencode 1.18.30 dedupes prompt/message creation on this id (verified live), and the
   * bridge additionally checks whether the message already exists before sending.
   */
  messageID?: string;
};

export type SendPromptResult = {
  ok: boolean;
  accepted: boolean;
  duplicate: boolean;
  messageID: string;
  async: boolean;
  response: JsonValue;
  /** Post-send StateStore touch. Its failure never changes the send outcome (F0 decision). */
  stateTouch: { ok: boolean; error: string | null };
};

/** OpenCode requires message ids matching `^msg`; make caller ids deterministic and safe. */
export function normalizeMessageId(candidate: string): string {
  const cleaned = candidate.trim().replace(/[^A-Za-z0-9_-]/g, "");
  if (cleaned.length === 0) {
    throw new Error("messageID must contain at least one alphanumeric, '_' or '-' character");
  }
  return cleaned.startsWith("msg") ? cleaned : `msg_${cleaned}`;
}

export function newMessageId(): string {
  return `msg_${randomUUID().replace(/-/g, "")}`;
}

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

function touchErrorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * Send a prompt with idempotency and non-fatal state bookkeeping.
 * Never retries the POST: an ambiguous failure is reported to the caller, who decides
 * whether to resend with the same messageID.
 */
export async function sendPrompt(
  ctx: RegisterContext,
  input: SendPromptInput
): Promise<ToolResult<SendPromptResult | { ok: false; error: string }>> {
  return await safeTool(async (): Promise<SendPromptResult> => {
    const bridge = await requireSession(ctx, input.bridgeSessionId);
    const managed = await ctx.processManager.ensure(bridge.repoPath);
    const client = ctx.processManager.clientFor(managed);
    const async = input.async ?? true;

    const requestedId = input.messageID ? normalizeMessageId(input.messageID) : null;
    const messageID = requestedId ?? newMessageId();

    const noteActivity = () => {
      const observer = ctx.events?.get(managed.baseUrl);
      observer?.noteActivity(bridge.opencodeSessionId);
    };

    if (requestedId) {
      const existing = await client.getMessageIfExists(bridge.opencodeSessionId, requestedId);
      if (existing) {
        noteActivity();
        return {
          ok: true,
          accepted: true,
          duplicate: true,
          messageID: requestedId,
          async,
          response: json(existing),
          stateTouch: { ok: true, error: null }
        };
      }
    }

    const response = await client.sendMessage({
      sessionId: bridge.opencodeSessionId,
      text: input.text,
      async,
      providerID: input.providerID,
      modelID: input.modelID,
      agent: input.agent,
      system: input.system,
      noReply: input.noReply,
      messageID
    });
    noteActivity();

    // The prompt is accepted here: a secondary state touch must not turn into "send failed".
    let stateTouch: SendPromptResult["stateTouch"] = { ok: true, error: null };
    try {
      await ctx.state.updateSession(input.bridgeSessionId, {});
    } catch (error) {
      const message = touchErrorText(error);
      stateTouch = { ok: false, error: message };
      console.warn(`[bridge] state store touch failed after accepted send (session ${bridge.bridgeSessionId}): ${message}`);
    }

    return {
      ok: true,
      accepted: true,
      duplicate: false,
      messageID,
      async,
      response: json(response ?? null),
      stateTouch
    };
  });
}
