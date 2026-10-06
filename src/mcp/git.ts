import type { GitStatusReport } from "../git/status.js";
import { readGitStatus } from "../git/status.js";
import type { GitDiffReport } from "../git/diff.js";
import { readGitDiff } from "../git/diff.js";
import type { ToolResult } from "../types.js";
import { safeTool } from "./results.js";
import { requireSession, type RegisterContext } from "./session.js";

/**
 * MCP handlers for read-only Git evidence.
 *
 * Both tools re-validate the bridge session (and thus the current allowed roots) through
 * requireSession before running any Git command. Git is only ever executed inside the
 * authorized repoPath returned by that validation; there is no way to pass an arbitrary cwd,
 * path, or git command from the MCP layer.
 */

export type GitStatusInput = { bridgeSessionId: string };

export async function opencodeGitStatus(
  ctx: RegisterContext,
  input: GitStatusInput
): Promise<ToolResult<GitStatusReport | { ok: false; error: string }>> {
  return await safeTool(async () => {
    const bridge = await requireSession(ctx, input.bridgeSessionId);
    return await readGitStatus(bridge.repoPath);
  });
}

export type GitDiffInput = { bridgeSessionId: string };

export async function opencodeGitDiff(
  ctx: RegisterContext,
  input: GitDiffInput
): Promise<ToolResult<GitDiffReport | { ok: false; error: string }>> {
  return await safeTool(async () => {
    const bridge = await requireSession(ctx, input.bridgeSessionId);
    return await readGitDiff(bridge.repoPath);
  });
}