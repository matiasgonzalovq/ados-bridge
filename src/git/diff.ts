import { join } from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";
import { isInside } from "../security/paths.js";
import { runGit, GitEvidenceError } from "./runner.js";
import { readGitStatus } from "./status.js";

/**
 * Read-only Git diff evidence for a validated repo path.
 *
 * Includes unstaged changes (`git diff`), staged changes (`git diff --cached`) and untracked
 * files. Untracked files are detected with `git ls-files --others --exclude-standard` and their
 * evidence is produced with `git diff --no-index -- /dev/null <path>`, which never touches the
 * index or working tree. No `git add`, commit, stash, reset or restore is ever run.
 *
 * Containment: untracked files are resolved to their real path and only read when they stay
 * strictly inside the work-tree root. Symlinks are never followed.
 */

export type GitDiffFile = {
  path: string;
  patch: string;
  binary: boolean;
  truncated: boolean;
};

export type GitUntrackedEvidence = {
  path: string;
  size: number;
  binary: boolean;
  truncated: boolean;
  patch: string | null;
  note: string | null;
};

export type GitDiffReport = {
  repoPath: string;
  gitRoot: string;
  branch: string | null;
  head: string | null;
  unstaged: GitDiffFile[];
  staged: GitDiffFile[];
  untracked: GitUntrackedEvidence[];
  totals: { unstaged: number; staged: number; untracked: number; truncated: boolean };
  notes: string[];
};

export const MAX_DIFF_FILES = 200;
export const MAX_PATCH_CHARS = 100_000;
export const MAX_TOTAL_PATCH_CHARS = 1_500_000;
export const MAX_UNTRACKED_FILES = 200;
export const MAX_UNTRACKED_BYTES = 512 * 1024;

const DIFF_ARGS = ["diff", "--no-color", "--no-ext-diff", "-U3"];

function pathFromBlock(block: string): string | null {
  // Prefer `+++ b/<path>`; fall back to `--- a/<path>` for deletions.
  const plus = /^\+\+\+ (?:[ab]\/)?(.+)$/m.exec(block);
  if (plus && plus[1] !== undefined) {
    const value = plus[1];
    if (value !== "/dev/null") return unquotePath(value);
  }
  const minus = /^--- (?:[ab]\/)?(.+)$/m.exec(block);
  if (minus && minus[1] !== undefined && minus[1] !== "/dev/null") return unquotePath(minus[1]);
  return null;
}

function unquotePath(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function splitBlocks(output: string): string[] {
  return output.split(/(?=^diff --git )/m).filter((block) => block.startsWith("diff --git "));
}

function isBinaryBlock(block: string): boolean {
  return /Binary files .* differ/.test(block) || /GIT binary patch/.test(block);
}

function collectDiffFiles(output: string, notes: string[]): GitDiffFile[] {
  const files: GitDiffFile[] = [];
  let totalChars = 0;
  for (const block of splitBlocks(output)) {
    if (files.length >= MAX_DIFF_FILES) {
      notes.push(`diff truncated: exceeded ${MAX_DIFF_FILES} files`);
      break;
    }
    const path = pathFromBlock(block);
    if (path === null) {
      notes.push("diff truncated: could not parse a change block");
      continue;
    }
    totalChars += block.length;
    const overTotal = totalChars > MAX_TOTAL_PATCH_CHARS;
    const truncated = block.length > MAX_PATCH_CHARS || overTotal;
    files.push({
      path,
      patch: truncated ? block.slice(0, MAX_PATCH_CHARS) : block,
      binary: isBinaryBlock(block),
      truncated
    });
    if (overTotal) {
      notes.push("diff truncated: total patch size exceeded");
      break;
    }
  }
  return files;
}

export async function readGitDiff(repoPath: string): Promise<GitDiffReport> {
  const notes: string[] = [];
  const rootResult = await runGit({ cwd: repoPath, args: ["rev-parse", "--show-toplevel"] });
  const gitRoot = rootResult.stdout.trim();

  const status = await readGitStatus(repoPath);

  const [unstagedOut, stagedOut] = await Promise.all([
    runGit({ cwd: repoPath, args: [...DIFF_ARGS] }),
    runGit({ cwd: repoPath, args: [...DIFF_ARGS, "--cached"] })
  ]);

  const unstaged = collectDiffFiles(unstagedOut.stdout, notes);
  const staged = collectDiffFiles(stagedOut.stdout, notes);

  const untracked = await collectUntrackedEvidence(gitRoot, notes);

  return {
    repoPath,
    gitRoot,
    branch: status.branch,
    head: status.head,
    unstaged,
    staged,
    untracked,
    totals: {
      unstaged: unstaged.length,
      staged: staged.length,
      untracked: untracked.length,
      truncated: notes.some((note) => note.startsWith("diff truncated"))
    },
    notes
  };
}

async function collectUntrackedEvidence(gitRoot: string, notes: string[]): Promise<GitUntrackedEvidence[]> {
  const listing = await runGit({
    cwd: gitRoot,
    args: ["ls-files", "--others", "--exclude-standard", "--full-name", "-z"]
  });

  const paths = listing.stdout.split("\0").filter(Boolean);
  const evidence: GitUntrackedEvidence[] = [];

  for (const rel of paths) {
    if (evidence.length >= MAX_UNTRACKED_FILES) {
      notes.push(`untracked truncated: exceeded ${MAX_UNTRACKED_FILES} files`);
      break;
    }

    const abs = join(gitRoot, rel);
    let real: string;
    try {
      real = await realpath(abs);
    } catch {
      evidence.push({ path: rel, size: 0, binary: false, truncated: false, patch: null, note: "unreadable" });
      continue;
    }

    // Strict containment: reject symlink/.. escapes that leave the repo.
    if (!isInside(gitRoot, real)) {
      evidence.push({ path: rel, size: 0, binary: false, truncated: false, patch: null, note: "path-escape" });
      continue;
    }

    let info;
    try {
      info = await lstat(abs);
    } catch {
      evidence.push({ path: rel, size: 0, binary: false, truncated: false, patch: null, note: "unreadable" });
      continue;
    }

    if (info.isSymbolicLink()) {
      evidence.push({ path: rel, size: info.size, binary: false, truncated: false, patch: null, note: "symlink-not-followed" });
      continue;
    }
    if (!info.isFile()) {
      evidence.push({ path: rel, size: info.size, binary: false, truncated: false, patch: null, note: "not-regular-file" });
      continue;
    }

    const size = (await stat(abs).catch(() => info)).size;
    if (size > MAX_UNTRACKED_BYTES) {
      evidence.push({ path: rel, size, binary: false, truncated: false, patch: null, note: "too-large" });
      continue;
    }

    let patch = "";
    let binary = false;
    let truncated = false;
    let note: string | null = null;
    try {
      const result = await runGit({
        cwd: gitRoot,
        args: ["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", rel],
        allowedExitCodes: [0, 1],
        maxBuffer: 2 * 1024 * 1024
      });
      patch = result.stdout;
      binary = /Binary files .* differ/.test(patch) || /GIT binary patch/.test(patch);
    } catch (error) {
      if (error instanceof GitEvidenceError && error.code === "GIT_OUTPUT_LIMIT") {
        truncated = true;
        note = "output-limit";
      } else {
        note = error instanceof Error ? error.message : String(error);
      }
    }
    if (patch.length > MAX_PATCH_CHARS) {
      patch = patch.slice(0, MAX_PATCH_CHARS);
      truncated = true;
    }

    evidence.push({ path: rel, size, binary, truncated, patch: patch || null, note });
  }

  return evidence;
}