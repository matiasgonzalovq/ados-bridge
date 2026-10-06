import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { destructiveCheckpoint, filterInsideRepo, resolveInsideRepo } from "../src/security/checkpoints.js";

async function makeRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "bridge-repo-"));
  const repo = join(root, "repo");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "index.ts"), "export {};\n");
  return repo;
}

describe("destructive checkpoints", () => {
  it("blocks destructive calls until confirmCheckpoint=true", () => {
    const gate = destructiveCheckpoint({
      enabled: true,
      confirmed: false,
      tool: "opencode_stop",
      action: "stop managed opencode server(s)",
      target: "all managed servers"
    });
    expect(gate).toMatchObject({ ok: false, checkpoint: "destructive", requiresConfirmation: true });
    expect(gate?.message).toContain("confirmCheckpoint=true");
  });

  it("allows destructive calls with confirmCheckpoint=true", () => {
    expect(
      destructiveCheckpoint({ enabled: true, confirmed: true, tool: "opencode_stop", action: "stop" })
    ).toBeNull();
  });

  it("allows non-sensitive calls when checkpoints are disabled", () => {
    expect(
      destructiveCheckpoint({ enabled: false, confirmed: false, tool: "opencode_stop", action: "stop" })
    ).toBeNull();
  });
});

describe("read containment", () => {
  it("resolves a normal file inside the repository", async () => {
    const repo = await makeRepo();
    const resolved = await resolveInsideRepo(repo, "src/index.ts");
    expect(resolved.endsWith(join("src", "index.ts"))).toBe(true);
  });

  it("rejects ../ traversal", async () => {
    const repo = await makeRepo();
    await expect(resolveInsideRepo(repo, "../../etc/passwd")).rejects.toThrow(/outside the repository/);
  });

  it("rejects an absolute path outside the repository", async () => {
    const repo = await makeRepo();
    await expect(resolveInsideRepo(repo, "/etc/passwd")).rejects.toThrow(/outside the repository/);
  });

  it("rejects a symlink inside the repo pointing outside", async () => {
    const repo = await makeRepo();
    await symlink("/etc/passwd", join(repo, "escape"));
    await expect(resolveInsideRepo(repo, "escape")).rejects.toThrow(/outside the repository/);
  });

  it("rejects a missing leaf whose ancestor escapes the repo", async () => {
    const repo = await makeRepo();
    await expect(resolveInsideRepo(repo, "../outside/new-file.txt")).rejects.toThrow(/outside the repository/);
  });

  it("resolves a missing file whose ancestors stay inside the repo", async () => {
    const repo = await makeRepo();
    const resolved = await resolveInsideRepo(repo, "src/missing.ts");
    expect(resolved.endsWith(join("src", "missing.ts"))).toBe(true);
  });

  it("rejects empty and NUL-byte paths", async () => {
    const repo = await makeRepo();
    await expect(resolveInsideRepo(repo, "  ")).rejects.toThrow(/empty/);
    await expect(resolveInsideRepo(repo, "src/\0evil")).rejects.toThrow(/NUL/);
  });

  it("filters entries that escape the repository", async () => {
    const repo = await makeRepo();
    await symlink("/etc", join(repo, "escape"));
    const kept = await filterInsideRepo(repo, [
      "src/index.ts",
      "../outside/file.ts",
      "/etc/passwd",
      join(repo, "src", "index.ts"),
      "escape/passwd"
    ]);
    expect(kept).toEqual(["src/index.ts", join(repo, "src", "index.ts")]);
  });
});
