import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeGitDiff, opencodeGitStatus } from "../src/mcp/git.js";
import type { GitStatusReport } from "../src/git/status.js";
import { makeContext, makeFakeClient } from "./fakes.js";
import { commitAll, git, makeGitRepo, repoSnapshot } from "./git-fixtures.js";

async function statusOf(ctx: unknown, bridgeSessionId: string): Promise<GitStatusReport> {
  const result = await opencodeGitStatus(ctx as never, { bridgeSessionId });
  return result.structuredContent as GitStatusReport;
}

describe("opencode_git_status", () => {
  it("reports a clean repository", async () => {
    const repo = await makeGitRepo("clean");
    await writeFile(join(repo, "a.txt"), "a\n");
    await commitAll(repo, "init");
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const report = await statusOf(ctx, bridge.bridgeSessionId);

    expect(report.clean).toBe(true);
    expect(report.branch).toBe("main");
    expect(report.head).toMatch(/^[0-9a-f]{40}$/);
    expect(report.upstream).toBeNull();
    expect(report.ahead).toBeNull();
    expect(report.behind).toBeNull();
    expect(report.staged).toEqual([]);
    expect(report.modified).toEqual([]);
    expect(report.untracked).toEqual([]);
    expect(report.deleted).toEqual([]);
    expect(report.renamed).toEqual([]);
    expect(report.conflicted).toEqual([]);
    expect(report.commitPending).toBe(false);
    expect(report.pushPending).toBe(false);
    expect(report.repoPath).toBe(await realpath(repo));
  });

  it("reports unstaged modifications", async () => {
    const repo = await makeGitRepo("modified");
    await writeFile(join(repo, "a.txt"), "a\n");
    await commitAll(repo, "init");
    await writeFile(join(repo, "a.txt"), "a\nb\n");
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const report = await statusOf(ctx, bridge.bridgeSessionId);

    expect(report.clean).toBe(false);
    expect(report.modified).toEqual(["a.txt"]);
    expect(report.staged).toEqual([]);
    expect(report.commitPending).toBe(true);
  });

  it("reports staged changes", async () => {
    const repo = await makeGitRepo("staged");
    await writeFile(join(repo, "a.txt"), "a\n");
    await commitAll(repo, "init");
    await writeFile(join(repo, "a.txt"), "changed\n");
    await git(repo, ["add", "a.txt"]);
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const report = await statusOf(ctx, bridge.bridgeSessionId);

    expect(report.staged).toEqual(["a.txt"]);
    expect(report.modified).toEqual([]);
  });

  it("reports a new untracked file (archivo.txt)", async () => {
    const repo = await makeGitRepo("untracked");
    await writeFile(join(repo, "tracked.txt"), "ok\n");
    await commitAll(repo, "init");
    await writeFile(join(repo, "archivo.txt"), "hello untracked\n");
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const report = await statusOf(ctx, bridge.bridgeSessionId);

    expect(report.untracked).toEqual(["archivo.txt"]);
    expect(report.staged).toEqual([]);
    expect(report.modified).toEqual([]);
  });

  it("reports deletions", async () => {
    const repo = await makeGitRepo("deleted");
    await writeFile(join(repo, "a.txt"), "a\n");
    await writeFile(join(repo, "b.txt"), "b\n");
    await commitAll(repo, "init");
    await rm(join(repo, "b.txt"));
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const report = await statusOf(ctx, bridge.bridgeSessionId);

    expect(report.deleted).toEqual(["b.txt"]);
    expect(report.staged).toEqual([]);
  });

  it("reports renames", async () => {
    const repo = await makeGitRepo("renamed");
    await writeFile(join(repo, "old.txt"), "content\n");
    await commitAll(repo, "init");
    await git(repo, ["mv", "old.txt", "new.txt"]);
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const report = await statusOf(ctx, bridge.bridgeSessionId);

    expect(report.renamed).toEqual([{ from: "old.txt", to: "new.txt" }]);
    expect(report.staged).toEqual(["new.txt"]);
  });

  it("reports staged and unstaged changes on the same file", async () => {
    const repo = await makeGitRepo("combo");
    await writeFile(join(repo, "a.txt"), "line1\n");
    await commitAll(repo, "init");
    await writeFile(join(repo, "a.txt"), "line1\nline2\n");
    await git(repo, ["add", "a.txt"]);
    await writeFile(join(repo, "a.txt"), "line1\nline2\nline3\n");
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const report = await statusOf(ctx, bridge.bridgeSessionId);

    expect(report.staged).toEqual(["a.txt"]);
    expect(report.modified).toEqual(["a.txt"]);
  });

  it("reports ahead/behind and pushPending when an upstream exists", async () => {
    const origin = await makeGitRepo("origin");
    await writeFile(join(origin, "a.txt"), "a\n");
    await commitAll(origin, "init");
    const local = join(tmpdir(), `f2-clone-${Date.now()}`);
    await git(tmpdir(), ["clone", "-q", origin, local]);
    await git(local, ["config", "user.email", "test@example.com"]);
    await git(local, ["config", "user.name", "Test"]);
    await writeFile(join(local, "b.txt"), "b\n");
    await commitAll(local, "local commit");

    const { ctx, seed } = await makeContext({ allowedRoots: [local], client: makeFakeClient() });
    const bridge = await seed(local);
    const report = await statusOf(ctx, bridge.bridgeSessionId);

    expect(report.upstream).toBeTruthy();
    expect(report.ahead).toBeGreaterThan(0);
    expect(report.behind).toBe(0);
    expect(report.pushPending).toBe(true);
  });

  it("denies a session whose repo is outside the allowed roots", async () => {
    const allowed = await makeGitRepo("allowed");
    const outside = await makeGitRepo("outside");
    const { ctx, seed } = await makeContext({ allowedRoots: [allowed], client: makeFakeClient() });
    const bridge = await seed(outside);

    const result = await opencodeGitStatus(ctx as never, { bridgeSessionId: bridge.bridgeSessionId });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("outside allowed roots");
  });

  it("denies a stale session whose repo path no longer exists", async () => {
    const repo = await makeGitRepo("stale");
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const gone = join(repo, "gone-dir");
    const bridge = await seed(gone);

    const result = await opencodeGitStatus(ctx as never, { bridgeSessionId: bridge.bridgeSessionId });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toMatch(/ENOENT|no such file/i);
  });

  it("returns a structured error for an authorized non-git directory", async () => {
    const nonGit = await mkdtemp(join(tmpdir(), "f2-nongitdir-"));
    const { ctx, seed } = await makeContext({ allowedRoots: [nonGit], client: makeFakeClient() });
    const bridge = await seed(nonGit);

    const result = await opencodeGitStatus(ctx as never, { bridgeSessionId: bridge.bridgeSessionId });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("NOT_A_GIT_REPO");
  });
});

describe("opencode_git_diff", () => {
  it("includes evidence for an untracked file without git add", async () => {
    const repo = await makeGitRepo("diff-untracked");
    await writeFile(join(repo, "tracked.txt"), "ok\n");
    await commitAll(repo, "init");
    await writeFile(join(repo, "archivo.txt"), "untracked content line\n");
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const before = await repoSnapshot(repo);
    const result = await opencodeGitDiff(ctx as never, { bridgeSessionId: bridge.bridgeSessionId });
    const after = await repoSnapshot(repo);

    const report = result.structuredContent as { untracked: Array<{ path: string; patch: string | null; note: string | null }>; totals: { untracked: number } };
    expect(result.isError).toBeUndefined();
    expect(report.untracked.some((entry) => entry.path === "archivo.txt")).toBe(true);
    const entry = report.untracked.find((item) => item.path === "archivo.txt");
    expect(entry?.patch).toContain("untracked content line");
    expect(entry?.note).toBeNull();
    expect(report.totals.untracked).toBeGreaterThan(0);

    // Read-only guarantee: index, working tree and stash are untouched, file stays untracked.
    expect(after).toBe(before);
    const ls = await git(repo, ["ls-files", "--others", "--exclude-standard"]);
    expect(ls.trim()).toBe("archivo.txt");
  });

  it("includes unstaged and staged diffs and keeps the repo read-only", async () => {
    const repo = await makeGitRepo("diff-both");
    await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
    await commitAll(repo, "init");

    await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\nfour\n"); // unstaged
    await writeFile(join(repo, "b.txt"), "staged file\n");
    await git(repo, ["add", "b.txt"]); // staged new file

    const before = await repoSnapshot(repo);
    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);
    const result = await opencodeGitDiff(ctx as never, { bridgeSessionId: bridge.bridgeSessionId });
    const after = await repoSnapshot(repo);

    expect(result.isError).toBeUndefined();
    const report = result.structuredContent as {
      unstaged: Array<{ path: string; patch: string }>;
      staged: Array<{ path: string; patch: string }>;
    };
    expect(report.unstaged.some((file) => file.path === "a.txt")).toBe(true);
    expect(report.staged.some((file) => file.path === "b.txt")).toBe(true);
    expect(after).toBe(before);
  });

  it("does not follow a symlink that escapes the repo", async () => {
    const repo = await makeGitRepo("diff-symlink");
    await writeFile(join(repo, "tracked.txt"), "ok\n");
    await commitAll(repo, "init");
    const outside = await mkdtemp(join(tmpdir(), "f2-secret-"));
    const secretPath = join(outside, "secret.txt");
    await writeFile(secretPath, "TOP SECRET\n");
    const link = join(repo, "leak.txt");
    await symlink(secretPath, link);

    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);
    const result = await opencodeGitDiff(ctx as never, { bridgeSessionId: bridge.bridgeSessionId });

    const report = result.structuredContent as {
      untracked: Array<{ path: string; note: string | null; patch: string | null }>;
    };
    const entry = report.untracked.find((item) => item.path === "leak.txt");
    expect(entry).toBeTruthy();
    expect(["path-escape", "symlink-not-followed"]).toContain(entry?.note);
    expect(JSON.stringify(result.structuredContent)).not.toContain("TOP SECRET");
  });

  it("keeps the repository read-only across status + diff", async () => {
    const repo = await makeGitRepo("diff-readonly");
    await writeFile(join(repo, "a.txt"), "a\n");
    await commitAll(repo, "init");
    await writeFile(join(repo, "a.txt"), "a\nb\n");
    await writeFile(join(repo, "u.txt"), "untracked\n");

    const { ctx, seed } = await makeContext({ allowedRoots: [repo], client: makeFakeClient() });
    const bridge = await seed(repo);

    const before = await repoSnapshot(repo);
    await opencodeGitStatus(ctx as never, { bridgeSessionId: bridge.bridgeSessionId });
    await opencodeGitDiff(ctx as never, { bridgeSessionId: bridge.bridgeSessionId });
    const after = await repoSnapshot(repo);

    expect(after).toBe(before);
  });
});