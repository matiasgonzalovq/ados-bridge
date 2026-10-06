import type { JsonValue, ToolResult } from "../types.js";

export function toolResult<T extends JsonValue>(
  structuredContent: T,
  options?: { isError?: boolean }
): ToolResult<T> {
  return {
    ...(options?.isError ? { isError: true } : {}),
    structuredContent,
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }]
  };
}

export function errorResult(message: string): ToolResult<{ ok: false; error: string }> {
  return toolResult({ ok: false, error: message }, { isError: true });
}

/** Blocked destructive call: not executed, requires an explicit confirmCheckpoint=true retry. */
export function checkpointResult<T extends JsonValue>(payload: T): ToolResult<T> {
  return toolResult(payload, { isError: true });
}

export async function safeTool<T extends JsonValue>(fn: () => Promise<T>): Promise<ToolResult<T | { ok: false; error: string }>> {
  try {
    return toolResult(await fn());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(message);
  }
}

export function extractTextParts(messages: unknown[], maxChars = 6000): string {
  const raw = JSON.stringify(messages, null, 2);
  if (raw.length <= maxChars) return raw;
  return `${raw.slice(0, maxChars)}\n... truncated ${raw.length - maxChars} chars`;
}
