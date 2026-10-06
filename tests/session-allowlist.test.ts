import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { requireSession, type RegisterContext } from "../src/mcp/tools.js";
import type { OpencodeProcessManager } from "../src/opencode/process.js";
import { StateStore } from "../src/state/store.js";
import type { BridgeConfig, BridgeSession } from "../src/types.js";

function makeConfig(allowedRoots: string[]): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    autoPort: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedRoots,
    bridgeToken: undefined,
    checkpoints: true,
    opencodeBin: "opencode",
    opencodeHost: "127.0.0.1",
    opencodePortStart: 4096,
    opencodeUsername: "opencode",
    stateDir: "/tmp/state",
    tunnel: "none",
    tailscaleBin: "/usr/bin/tailscale",
    cloudflaredBin: "cloudflared"
  };
}

async function makeFixture(allowedRoots: string[]): Promise<{
  ctx: RegisterContext;
  state: StateStore;
  seed: (repoPath: string) => Promise<BridgeSession>;
}> {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-state-"));
  const state = new StateStore(stateDir);
  const ctx: RegisterContext = {
    config: makeConfig(allowedRoots),
    state,
    processManager: {} as OpencodeProcessManager
  };
  const seed = (repoPath: string) =>
    state.createSession({ opencodeSessionId: "ses_1", repoPath, baseUrl: "http://127.0.0.1:4096" });
  return { ctx, state, seed };
}

describe("session allowlist revalidation", () => {
  it("accepts a session whose repo is inside a current allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const { ctx, seed } = await makeFixture([root]);
    const session = await seed(repo);

    const resolved = await requireSession(ctx, session.bridgeSessionId);
    expect(resolved.repoPath).not.toBe(""); // realpath-resolved
    expect(resolved.opencodeSessionId).toBe("ses_1");
  });

  it("denies a session created outside the roots active today", async () => {
    const staleRoot = await mkdtemp(join(tmpdir(), "bridge-stale-"));
    const currentRoot = await mkdtemp(join(tmpdir(), "bridge-current-"));
    const outsideRepo = join(staleRoot, "ados-sandbox");
    await mkdir(outsideRepo, { recursive: true });
    const { ctx, seed } = await makeFixture([currentRoot]);
    const session = await seed(outsideRepo);

    await expect(requireSession(ctx, session.bridgeSessionId)).rejects.toThrow(/outside allowed roots/);
  });

  it("accepts a session under any of multiple active roots", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "bridge-root-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "bridge-root-b-"));
    const repo = join(rootB, "repo");
    await mkdir(repo, { recursive: true });
    const { ctx, seed } = await makeFixture([rootA, rootB]);
    const session = await seed(repo);

    await expect(requireSession(ctx, session.bridgeSessionId)).resolves.toBeDefined();
  });

  it("denies a session whose repo vanished (stale session)", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const { ctx, seed } = await makeFixture([root]);
    const session = await seed(join(root, "deleted-repo"));

    await expect(requireSession(ctx, session.bridgeSessionId)).rejects.toThrow();
  });

  it("denies a prefix-colliding sibling of an allowed root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const sibling = `${root}-evil`;
    await mkdir(sibling, { recursive: true });
    const { ctx, seed } = await makeFixture([root]);
    const session = await seed(sibling);

    await expect(requireSession(ctx, session.bridgeSessionId)).rejects.toThrow(/outside allowed roots/);
  });

  it("rejects unknown session ids", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const { ctx } = await makeFixture([root]);
    await expect(requireSession(ctx, "nope")).rejects.toThrow(/Unknown bridge session/);
  });
});
