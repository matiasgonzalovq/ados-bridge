import { runGit } from "./runner.js";

/**
 * Machine-readable Git status evidence for a validated repo path.
 *
 * Parses `git status --porcelain=v2 -z --branch` (verified against git 2.55). Records are
 * NUL-terminated. This module only *reads*: it never stages, commits, or otherwise mutates
 * the repository. GIT_OPTIONAL_LOCKS=0 is set by the runner so git does not even take
 * optional index locks.
 */

export type GitRename = { from: string; to: string };

export type GitStatusReport = {
  repoPath: string;
  gitRoot: string;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  clean: boolean;
  staged: string[];
  modified: string[];
  untracked: string[];
  deleted: string[];
  renamed: GitRename[];
  conflicted: string[];
  commitPending: boolean;
  pushPending: boolean;
};

export const MAX_STATUS_ENTRIES = 5_000;

type XY = { index: string; worktree: string };

function splitXY(xy: string): XY {
  return { index: xy[0] ?? ".", worktree: xy[1] ?? "." };
}

function classify(xy: XY, path: string, out: {
  staged: Set<string>;
  modified: Set<string>;
  deleted: Set<string>;
  conflicted: string[];
}) {
  // 'u' records are unmerged (conflicts) handled by the caller; here we only get '1'/'2'.
  if (xy.index !== ".") out.staged.add(path);
  if (xy.worktree === "D") out.deleted.add(path);
  else if (xy.worktree !== ".") out.modified.add(path);
}

export function parsePorcelainV2(stdout: string): Omit<GitStatusReport, "repoPath" | "gitRoot" | "clean" | "commitPending" | "pushPending"> {
  const staged = new Set<string>();
  const modified = new Set<string>();
  const deleted = new Set<string>();
  const untracked: string[] = [];
  const renamed: GitRename[] = [];
  const conflicted: string[] = [];

  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let entries = 0;

  const tokens = stdout.split("\0");
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token) continue;

    if (token.startsWith("# branch.oid ")) {
      const value = token.slice("# branch.oid ".length);
      head = value === "(initial)" || value === "(no branch)" ? null : value || null;
    } else if (token.startsWith("# branch.head ")) {
      const value = token.slice("# branch.head ".length);
      branch = value === "(detached)" ? null : value || null;
    } else if (token.startsWith("# branch.upstream ")) {
      upstream = token.slice("# branch.upstream ".length) || null;
    } else if (token.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(token.slice("# branch.ab ".length));
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
    } else if (token.startsWith("1 ")) {
      if (entries >= MAX_STATUS_ENTRIES) continue;
      entries += 1;
      const fields = token.split(" ");
      const xy = splitXY(fields[1] ?? ".");
      const path = fields.slice(8).join(" ");
      classify(xy, path, { staged, modified, deleted, conflicted });
    } else if (token.startsWith("2 ")) {
      if (entries >= MAX_STATUS_ENTRIES) continue;
      entries += 1;
      const fields = token.split(" ");
      const xy = splitXY(fields[1] ?? ".");
      const path = fields.slice(9).join(" ");
      const origPath = tokens[i + 1] ?? "";
      if (origPath !== "") i += 1;
      if (xy.index === "R" || xy.index === "C") renamed.push({ from: origPath, to: path });
      classify(xy, path, { staged, modified, deleted, conflicted });
    } else if (token.startsWith("u ")) {
      if (entries >= MAX_STATUS_ENTRIES) continue;
      entries += 1;
      const fields = token.split(" ");
      conflicted.push(fields.slice(2).join(" "));
    } else if (token.startsWith("? ")) {
      if (entries >= MAX_STATUS_ENTRIES) continue;
      entries += 1;
      untracked.push(token.slice(2));
    }
    // "! " (ignored) entries are ignored; we never request --ignored.
  }

  const sortUnique = (set: Set<string>) => [...set].sort();

  return {
    branch,
    head,
    upstream,
    ahead,
    behind,
    staged: sortUnique(staged),
    modified: sortUnique(modified),
    untracked: [...untracked].sort(),
    deleted: sortUnique(deleted),
    renamed: [...renamed].sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)),
    conflicted: [...conflicted].sort()
  };
}

export async function readGitStatus(repoPath: string): Promise<GitStatusReport> {
  const gitRoot = (await runGit({ cwd: repoPath, args: ["rev-parse", "--show-toplevel"] })).stdout.trim();
  const result = await runGit({
    cwd: repoPath,
    args: ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all"]
  });

  const parsed = parsePorcelainV2(result.stdout);
  const hasPending =
    parsed.staged.length > 0 ||
    parsed.modified.length > 0 ||
    parsed.untracked.length > 0 ||
    parsed.deleted.length > 0 ||
    parsed.renamed.length > 0 ||
    parsed.conflicted.length > 0;

  return {
    repoPath,
    gitRoot,
    ...parsed,
    clean: !hasPending,
    commitPending: hasPending,
    pushPending: parsed.ahead !== null && parsed.ahead > 0
  };
}