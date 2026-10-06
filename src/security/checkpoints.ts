import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isInside } from "./paths.js";

export type DestructiveCheckpointRequest = {
  enabled: boolean;
  confirmed: boolean;
  tool: string;
  action: string;
  target?: string;
};

export type DestructiveCheckpoint = {
  ok: false;
  checkpoint: "destructive";
  requiresConfirmation: true;
  tool: string;
  action: string;
  target: string;
  message: string;
};

/**
 * Destructive gate (default-on): returns a checkpoint payload when the caller has not
 * explicitly confirmed, otherwise null so execution can continue.
 */
export function destructiveCheckpoint(request: DestructiveCheckpointRequest): DestructiveCheckpoint | null {
  if (!request.enabled || request.confirmed) return null;
  const target = request.target && request.target.length > 0 ? request.target : "all targets";
  return {
    ok: false,
    checkpoint: "destructive",
    requiresConfirmation: true,
    tool: request.tool,
    action: request.action,
    target,
    message:
      `Destructive checkpoint for ${request.tool}: ${request.action} (target: ${target}). ` +
      "Re-send the same call with confirmCheckpoint=true to proceed."
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}

function escapeError(inputPath: string): Error {
  return new Error(`Read blocked: ${inputPath} resolves outside the repository`);
}

function assertReadablePath(inputPath: string): void {
  if (inputPath.includes("\0")) throw new Error("Invalid path: contains NUL byte");
  if (inputPath.trim().length === 0) throw new Error("Invalid path: empty");
}

/**
 * Resolve a path through the nearest existing ancestor (following symlinks), keeping
 * the not-yet-existing suffix intact. Comparing this leaf against a realpath root
 * avoids false rejects (/var vs /private/var) and false accepts (symlinked escapes
 * behind a missing leaf).
 */
async function realLeaf(target: string): Promise<string> {
  let current = resolve(target);
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = await realpath(current);
      return resolve(real, relative(current, target));
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(target);
      current = parent;
    }
  }
  throw new Error(`Cannot resolve path: ${target}`);
}

/**
 * Resolve an absolute path for reading, rejecting anything that escapes repoPath.
 * Symlinks are followed before the containment check, and non-existent leaves are
 * validated through their nearest existing ancestor.
 */
export async function resolveInsideRepo(repoPath: string, inputPath: string): Promise<string> {
  assertReadablePath(inputPath);
  const root = await realpath(repoPath);
  const candidate = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  const leaf = await realLeaf(candidate);
  if (!isInside(root, leaf)) throw escapeError(inputPath);
  return leaf;
}

/** Keep only entries whose absolute/relative resolution stays inside repoPath. */
export async function filterInsideRepo(repoPath: string, entries: readonly string[]): Promise<string[]> {
  const root = await realpath(repoPath).catch(() => resolve(repoPath));
  const kept: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) continue;
    const candidate = isAbsolute(entry) ? resolve(entry) : resolve(root, entry);
    const leaf = await realLeaf(candidate).catch(() => null);
    if (leaf && isInside(root, leaf)) kept.push(entry);
  }
  return kept;
}
