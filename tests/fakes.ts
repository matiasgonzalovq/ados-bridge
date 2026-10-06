import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpencodeProcessManager } from "../src/opencode/process.js";
import type { EventObserverRegistry, SessionObservation } from "../src/opencode/events.js";
import { StateStore } from "../src/state/store.js";
import type { RegisterContext } from "../src/mcp/session.js";
import type { BridgeConfig, BridgeSession, OpencodeMessage } from "../src/types.js";

export function makeConfig(allowedRoots: string[], extra: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 8787,
    autoPort: true,
    allowedHosts: ["127.0.0.1", "localhost"],
    allowedRoots,
    bridgeToken: undefined,
    checkpoints: true,
    stalledMs: 120_000,
    opencodeBin: "opencode",
    opencodeHost: "127.0.0.1",
    opencodePortStart: 4096,
    opencodeUsername: "opencode",
    stateDir: "/tmp/state",
    tunnel: "none",
    tailscaleBin: "/usr/bin/tailscale",
    cloudflaredBin: "cloudflared",
    ...extra
  };
}

export const MANAGED = {
  repoPath: "/tmp/repo",
  baseUrl: "http://127.0.0.1:4199",
  username: "opencode",
  password: "pw",
  startedAt: "2026-01-01T00:00:00.000Z"
};

export type FakeClientCalls = {
  sendMessage: Array<Record<string, unknown>>;
  answerQuestion: Array<{ requestID: string; answers: string[][] }>;
};

export type FakeClient = {
  calls: FakeClientCalls;
  getSession: (id: string) => Promise<unknown>;
  getSessionStatus: () => Promise<Record<string, Record<string, unknown>>>;
  listPermissions: () => Promise<unknown[]>;
  listQuestions: () => Promise<unknown[]>;
  getMessages: (sessionId: string, limit?: number) => Promise<OpencodeMessage[]>;
  getMessageIfExists: (sessionId: string, messageID: string) => Promise<unknown>;
  sendMessage: (input: Record<string, unknown>) => Promise<unknown>;
  answerQuestion: (requestID: string, answers: string[][]) => Promise<boolean>;
};

export type FakeFailureKey = "getSessionStatus" | "listPermissions" | "listQuestions" | "getMessages";

export type FakeClientOptions = {
  /** When false, getSession rejects with a 404 (session does not exist on opencode). */
  sessionExists?: boolean;
  statuses?: Record<string, Record<string, unknown>>;
  permissions?: unknown[];
  questions?: unknown[];
  messages?: OpencodeMessage[];
  /** Force specific methods to fail (used to check degradation paths). */
  failures?: Partial<Record<FakeFailureKey, string>>;
  /** Return values per messageID for getMessageIfExists (null = not accepted yet). */
  acceptedMessages?: Record<string, unknown>;
  /** When set, sendMessage rejects with this message (ambiguous POST failure). */
  sendMessageError?: string;
  answerQuestionResult?: boolean;
  answerQuestionError?: string;
};

export function makeFakeClient(options: FakeClientOptions = {}): FakeClient {
  const calls: FakeClientCalls = { sendMessage: [], answerQuestion: [] };
  const fail = (name: FakeFailureKey) => {
    const message = options.failures?.[name];
    if (message) throw new Error(message);
  };
  return {
    calls,
    async getSession(id: string) {
      if (options.sessionExists === false) {
        throw new Error(`opencode GET /session/${id} failed: 404 Not Found - {"name":"SessionNotFoundError"}`);
      }
      return { id, title: "probe" };
    },
    async getSessionStatus() {
      fail("getSessionStatus");
      return options.statuses ?? {};
    },
    async listPermissions() {
      fail("listPermissions");
      return options.permissions ?? [];
    },
    async listQuestions() {
      fail("listQuestions");
      return options.questions ?? [];
    },
    async getMessages() {
      fail("getMessages");
      return options.messages ?? [];
    },
    async getMessageIfExists(_sessionId: string, messageID: string) {
      return (options.acceptedMessages?.[messageID] as never) ?? null;
    },
    async sendMessage(input: Record<string, unknown>) {
      calls.sendMessage.push(input);
      if (options.sendMessageError) throw new Error(options.sendMessageError);
      return { accepted: true };
    },
    async answerQuestion(requestID: string, answers: string[][]) {
      calls.answerQuestion.push({ requestID, answers });
      if (options.answerQuestionError) throw new Error(options.answerQuestionError);
      return options.answerQuestionResult ?? true;
    }
  };
}

export function fakeProcessManager(client: FakeClient, options: { ensureError?: string } = {}) {
  const ensureCalls: string[] = [];
  return {
    ensureCalls,
    async ensure(repoPath: string) {
      ensureCalls.push(repoPath);
      if (options.ensureError) throw new Error(options.ensureError);
      return { ...MANAGED, repoPath };
    },
    clientFor() {
      return client;
    },
    list() {
      return [{ ...MANAGED }];
    },
    async stop() {
      return { stopped: [] };
    }
  } as unknown as OpencodeProcessManager;
}

export function fakeRegistry(observation: SessionObservation | null): EventObserverRegistry {
  const observer = {
    noteActivity: () => undefined,
    snapshot: () => observation
  };
  return {
    ensure: () => observer,
    get: () => observer,
    stop: async () => undefined,
    stopAll: async () => undefined,
    status: () => []
  } as unknown as EventObserverRegistry;
}

export function makeObservation(sessionID: string, patch: Partial<SessionObservation> = {}): SessionObservation {
  return {
    sessionID,
    lastActivityAt: null,
    lastEventAt: null,
    lastError: null,
    lastErrorAt: null,
    current: null,
    lastCompletion: null,
    recent: [],
    ...patch
  };
}

/** Existing temp directory usable as both an allowed root and a session repo path. */
export async function makeTempRepo(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "bridge-repo-"));
}

export async function makeStore(): Promise<{ state: StateStore; dir: string; seed: (repoPath: string) => Promise<BridgeSession> }> {
  const dir = await mkdtemp(join(tmpdir(), "bridge-f1-"));
  const state = new StateStore(dir);
  const seed = (repoPath: string) =>
    state.createSession({ opencodeSessionId: "ses_probe", repoPath, baseUrl: MANAGED.baseUrl });
  return { state, dir, seed };
}

export async function makeContext(options: {
  allowedRoots: string[];
  client?: FakeClient;
  ensureError?: string;
  events?: EventObserverRegistry;
  config?: Partial<BridgeConfig>;
}): Promise<{ ctx: RegisterContext; state: StateStore; client: FakeClient; seed: (repoPath: string) => Promise<BridgeSession> }> {
  const client = options.client ?? makeFakeClient();
  const { state, seed } = await makeStore();
  const ctx: RegisterContext = {
    config: makeConfig(options.allowedRoots, options.config),
    state,
    processManager: fakeProcessManager(client, { ensureError: options.ensureError }),
    events: options.events
  };
  return { ctx, state, client, seed };
}

export function userMessage(id: string, createdAt: number, text = "hi"): OpencodeMessage {
  return { info: { id, role: "user", time: { created: createdAt } }, parts: [{ id: `${id}_p`, type: "text", text }] };
}

export function assistantMessage(id: string, createdAt: number, error?: Record<string, unknown>): OpencodeMessage {
  return {
    info: { id, role: "assistant", time: { created: createdAt }, ...(error ? { error } : {}) },
    parts: []
  };
}
