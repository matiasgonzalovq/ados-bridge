import { validateRepoPath } from "../security/paths.js";
import type { EventObserverRegistry } from "../opencode/events.js";
import type { OpencodeProcessManager } from "../opencode/process.js";
import type { StateStore } from "../state/store.js";
import type { BridgeConfig, BridgeSession } from "../types.js";

export type RegisterContext = {
  config: BridgeConfig;
  processManager: OpencodeProcessManager;
  state: StateStore;
  /** Optional: live event observation (GET /event). Absent in minimal/unit-test contexts. */
  events?: EventObserverRegistry;
};

/**
 * Load a bridge session and re-validate its repository against the CURRENT allowed roots.
 * Deny by default: a session created while other roots were allowed can never bypass
 * the allowlist in force today, and a repo that disappeared is unusable.
 */
export async function requireSession(ctx: RegisterContext, bridgeSessionId: string): Promise<BridgeSession> {
  const stored = await ctx.state.getSession(bridgeSessionId);
  const repoPath = await validateRepoPath(stored.repoPath, ctx.config.allowedRoots);
  return { ...stored, repoPath };
}
