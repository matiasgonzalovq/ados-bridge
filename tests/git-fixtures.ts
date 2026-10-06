import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  return stdout;
}

export async function makeGitRepo(name: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `f2-${name}-`));
  await git(dir, ["init", "-q", "-b", "main", "."]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "user.name", "Test"]);
  return dir;
}

export async function commitAll(dir: string, message: string): Promise<void> {
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", message]);
}

/** Returns a comma-separated read-only snapshot of the repo so tests can assert no mutation. */
export async function repoSnapshot(dir: string): Promise<string> {
  const status = await git(dir, ["status", "--porcelain=v2", "-z", "--branch"]);
  const index = await git(dir, ["ls-files", "-s"]);
  const stash = await git(dir, ["stash", "list"]);
  return [status, index, stash].join("\n---\n");
}