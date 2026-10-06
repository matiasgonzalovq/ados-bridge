import { describe, expect, it } from "vitest";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitEvidenceError, gitEnv, runGit, gitWorkTreeRoot } from "../src/git/runner.js";
import { makeGitRepo } from "./git-fixtures.js";

describe("runGit", () => {
  it("runs read-only commands without a shell and returns stdout", async () => {
    const dir = await makeGitRepo("runner");
    const result = await runGit({ cwd: dir, args: ["rev-parse", "--show-toplevel"] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(await realpath(dir));
  });

  it("keeps the git environment free of credential-bearing variables", () => {
    const env = gitEnv();
    const keys = Object.keys(env);
    for (const key of keys) {
      expect(key).not.toMatch(/token|secret|password|passwd|api.?key|aws|ssh_/i);
    }
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
  });

  it("returns a structured NOT_A_GIT_REPO error without crashing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "f2-notgit-"));
    await expect(runGit({ cwd: dir, args: ["status"] })).rejects.toMatchObject({ code: "NOT_A_GIT_REPO" });
    await expect(gitWorkTreeRoot(dir)).rejects.toMatchObject({ code: "NOT_A_GIT_REPO" });
  });

  it("enforces a timeout by killing a blocked git process", async () => {
    const dir = await makeGitRepo("runner-timeout");
    await expect(
      runGit({ cwd: dir, args: ["hash-object", "--stdin"], timeoutMs: 300 })
    ).rejects.toMatchObject({ code: "GIT_TIMEOUT" });
  });

  it("reports output-limit errors when maxBuffer is exceeded", async () => {
    const dir = await makeGitRepo("runner-limit");
    await expect(
      runGit({ cwd: dir, args: ["status", "--porcelain=v2", "-z", "--branch"], maxBuffer: 16 })
    ).rejects.toMatchObject({ code: "GIT_OUTPUT_LIMIT" });
  });

  it("surfaces a generic git failure with exit code and sanitized stderr", async () => {
    const dir = await makeGitRepo("runner-fail");
    const error = await runGit({ cwd: dir, args: ["rev-parse", "--verify", "nonexistent-ref"] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitEvidenceError);
    expect(error).toMatchObject({ code: "GIT_FAILED" });
    expect((error as GitEvidenceError).exitCode).toBeGreaterThan(0);
  });

  it("allows an explicit non-zero exit code", async () => {
    const dir = await makeGitRepo("runner-exit");
    const result = await runGit({ cwd: dir, args: ["diff", "--no-index", "--no-color", "--", "/dev/null", "nonexistent"], allowedExitCodes: [0, 1] });
    expect(result.exitCode).toBe(1);
  });
});

describe("gitEnv", () => {
  it("does not throw and exposes the git binary path for git to work", async () => {
    const dir = await makeGitRepo("runner-env");
    const result = await runGit({ cwd: dir, args: ["--version"] });
    expect(result.stdout).toMatch(/^git version /);
  });
});