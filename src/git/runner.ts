import { execFile } from "node:child_process";

/**
 * Read-only Git execution for bridge Git evidence.
 *
 * Every command is spawned with execFile (never shell=true) using an explicit argument
 * array, a hard timeout, bounded output, and a minimal environment that omits any
 * credential-bearing variables (tokens, passwords, SSH agent, etc.). GIT_OPTIONAL_LOCKS=0
 * prevents git from even touching optional index/lock files, which is part of the
 * read-only guarantee.
 */

export type GitErrorCode =
  | "NOT_A_GIT_REPO"
  | "GIT_TIMEOUT"
  | "GIT_OUTPUT_LIMIT"
  | "GIT_FAILED"
  | "GIT_UNAVAILABLE"
  | "PATH_ESCAPE";

export type GitEvidenceErrorDetails = {
  exitCode?: number | null;
  stderr?: string | null;
};

export class GitEvidenceError extends Error {
  readonly code: GitErrorCode;
  readonly exitCode: number | null;
  readonly stderr: string | null;

  constructor(code: GitErrorCode, message: string, details: GitEvidenceErrorDetails = {}) {
    super(`${code}: ${message}`);
    this.name = "GitEvidenceError";
    this.code = code;
    this.exitCode = details.exitCode ?? null;
    this.stderr = details.stderr ?? null;
  }
}

export type GitRunInput = {
  /** Directory git runs in (must already be validated as an authorized repo path). */
  cwd: string;
  /** Explicit argument list, never a shell string. */
  args: string[];
  timeoutMs?: number;
  maxBuffer?: number;
  /** Exit codes treated as success (e.g. 1 for `git diff --no-index`). */
  allowedExitCodes?: number[];
};

export type GitRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export const GIT_TIMEOUT_MS = 10_000;
export const GIT_MAX_BUFFER = 8 * 1024 * 1024;
export const GIT_STDERR_REPORT_LIMIT = 400;

/** Minimal environment: PATH/HOME for git to work, locale pinned, no credentials. */
export function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C",
    LC_ALL: "C",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_CONFIG_NOSYSTEM: "1"
  };
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function runGit(input: GitRunInput): Promise<GitRunResult> {
  const { cwd, args } = input;
  const timeoutMs = input.timeoutMs ?? GIT_TIMEOUT_MS;
  const maxBuffer = input.maxBuffer ?? GIT_MAX_BUFFER;
  const allowedExitCodes = input.allowedExitCodes ?? [0];

  return new Promise<GitRunResult>((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      {
        cwd,
        env: gitEnv(),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer,
        killSignal: "SIGKILL",
        shell: false,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        const out = String(stdout ?? "");
        const err = String(stderr ?? "");

        if (!error) {
          resolve({ stdout: out, stderr: err, exitCode: 0 });
          return;
        }

        const anyErr = error as NodeJS.ErrnoException & {
          code?: number | string;
          exitCode?: number | null;
          killed?: boolean;
          signal?: string;
        };

        if (anyErr.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new GitEvidenceError("GIT_OUTPUT_LIMIT", "git output exceeded the configured limit", { stderr: truncate(err, GIT_STDERR_REPORT_LIMIT) }));
          return;
        }
        if (anyErr.killed && anyErr.signal) {
          reject(new GitEvidenceError("GIT_TIMEOUT", `git did not finish within ${timeoutMs}ms and was killed`, { exitCode: null, stderr: truncate(err, GIT_STDERR_REPORT_LIMIT) }));
          return;
        }
        if (anyErr.code === "ENOENT") {
          reject(new GitEvidenceError("GIT_UNAVAILABLE", "the git executable could not be found", { exitCode: null }));
          return;
        }

        const exitCode = typeof anyErr.code === "number" ? anyErr.code : anyErr.exitCode ?? null;
        if (/not a git repository/i.test(err)) {
          reject(new GitEvidenceError("NOT_A_GIT_REPO", "not a git repository", { exitCode, stderr: truncate(err, GIT_STDERR_REPORT_LIMIT) }));
          return;
        }
        if (exitCode !== null && allowedExitCodes.includes(exitCode)) {
          resolve({ stdout: out, stderr: err, exitCode });
          return;
        }

        reject(new GitEvidenceError("GIT_FAILED", "git command failed", { exitCode, stderr: truncate(err, GIT_STDERR_REPORT_LIMIT) }));
      }
    );
  });
}

/** Resolve and validate the work-tree root; throws NOT_A_GIT_REPO otherwise. */
export async function gitWorkTreeRoot(cwd: string): Promise<string> {
  const result = await runGit({ cwd, args: ["rev-parse", "--show-toplevel"] });
  return result.stdout.trim();
}