import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { BridgeSession } from "../types.js";

type StateFile = {
  sessions: BridgeSession[];
};

const MAX_WRITE_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 25;
const TRANSIENT_CODES = new Set(["EBUSY", "EMFILE", "ENFILE", "EAGAIN", "ENOSPC"]);

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error && "code" in error
    ? (error as { code?: string }).code
    : undefined;
}

function isTransient(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && TRANSIENT_CODES.has(code);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StateStore {
  private readonly file: string;
  private lastPayload?: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly stateDir: string) {
    this.file = join(stateDir, "sessions.json");
  }

  /** Serialize read-modify-write cycles in-process so concurrent calls cannot drop or duplicate rows. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async listSessions(): Promise<BridgeSession[]> {
    return this.locked(async () => (await this.read()).sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  async createSession(input: Omit<BridgeSession, "bridgeSessionId" | "createdAt" | "updatedAt">): Promise<BridgeSession> {
    return this.locked(async () => {
      const now = new Date().toISOString();
      const session: BridgeSession = {
        ...input,
        bridgeSessionId: randomUUID(),
        createdAt: now,
        updatedAt: now
      };
      const state = await this.read();
      state.sessions.push(session);
      await this.write(state);
      return session;
    });
  }

  async getSession(bridgeSessionId: string): Promise<BridgeSession> {
    return this.locked(async () => {
      const session = (await this.read()).sessions.find((item) => item.bridgeSessionId === bridgeSessionId);
      if (!session) throw new Error(`Unknown bridge session: ${bridgeSessionId}`);
      return session;
    });
  }

  async updateSession(bridgeSessionId: string, patch: Partial<Omit<BridgeSession, "bridgeSessionId" | "createdAt">>): Promise<BridgeSession> {
    return this.locked(async () => {
      const state = await this.read();
      const index = state.sessions.findIndex((item) => item.bridgeSessionId === bridgeSessionId);
      if (index < 0) throw new Error(`Unknown bridge session: ${bridgeSessionId}`);
      const existing = state.sessions[index];
      if (!existing) throw new Error(`Unknown bridge session: ${bridgeSessionId}`);
      const updated: BridgeSession = {
        bridgeSessionId: existing.bridgeSessionId,
        createdAt: existing.createdAt,
        opencodeSessionId: patch.opencodeSessionId ?? existing.opencodeSessionId,
        repoPath: patch.repoPath ?? existing.repoPath,
        baseUrl: patch.baseUrl ?? existing.baseUrl,
        title: patch.title ?? existing.title,
        updatedAt: new Date().toISOString()
      };
      state.sessions[index] = updated;
      await this.write(state);
      return updated;
    });
  }

  private async read(): Promise<StateFile> {
    await mkdir(this.stateDir, { recursive: true });
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw) as StateFile;
      return { sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [] };
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { sessions: [] };
      if (error instanceof SyntaxError) {
        throw new Error(
          `State file is not valid JSON: ${this.file}. Refusing to overwrite it; repair or remove the file manually.`
        );
      }
      throw error;
    }
  }

  /**
   * Single atomic write (temp file + rename) with bounded retries on transient fs errors.
   * Identical payloads are never rewritten, so retries can never duplicate state on disk.
   */
  private async write(state: StateFile): Promise<void> {
    const payload = JSON.stringify(state, null, 2) + "\n";
    if (payload === this.lastPayload) return;
    await mkdir(this.stateDir, { recursive: true });

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      const tempPath = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
        await rename(tempPath, this.file);
        this.lastPayload = payload;
        return;
      } catch (error) {
        lastError = error;
        await unlink(tempPath).catch(() => undefined);
        if (!isTransient(error) || attempt === MAX_WRITE_ATTEMPTS) break;
        await delay(RETRY_BASE_DELAY_MS * attempt);
      }
    }
    throw lastError;
  }
}
