import { mkdtemp, mkdir, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listProjects, validateRepoPath } from "../src/security/paths.js";

describe("path security", () => {
  it("allows paths inside allowed roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const repo = join(root, "repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await expect(validateRepoPath(repo, [root])).resolves.toBe(await realpath(repo));
  });

  it("allows a repo under any of multiple allowed roots", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "bridge-root-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "bridge-root-b-"));
    const repo = join(rootB, "repo");
    await mkdir(repo, { recursive: true });
    await expect(validateRepoPath(repo, [rootA, rootB])).resolves.toBe(await realpath(repo));
  });

  it("rejects paths outside allowed roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    await expect(validateRepoPath(outside, [root])).rejects.toThrow(/outside allowed roots/);
  });

  it("rejects an absolute path outside the roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const outside = "/etc";
    await expect(validateRepoPath(outside, [root])).rejects.toThrow(/outside allowed roots/);
  });

  it("rejects prefix-colliding sibling directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    const sibling = `${root}-evil`;
    await mkdir(sibling, { recursive: true });
    await expect(validateRepoPath(sibling, [root])).rejects.toThrow(/outside allowed roots/);
  });

  it("rejects a path that escapes through its ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const escaping = join(root, "missing", "..", "..", "bridge-never-exists");
    await expect(validateRepoPath(escaping, [root])).rejects.toThrow();
  });

  it("rejects a symlink whose target resolves outside the roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const outside = await mkdtemp(join(tmpdir(), "bridge-outside-"));
    const link = join(root, "link");
    await symlink(outside, link);
    await expect(validateRepoPath(link, [root])).rejects.toThrow(/outside allowed roots/);
  });

  it("rejects a stale session repo that no longer exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    const stale = join(root, "deleted-repo");
    await expect(validateRepoPath(stale, [root])).rejects.toThrow();
  });

  it("finds git projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-root-"));
    await mkdir(join(root, "a", ".git"), { recursive: true });
    const projects = await listProjects([root], 2);
    expect(projects.map((p) => p.name)).toContain("a");
  });
});
