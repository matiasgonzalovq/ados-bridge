export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type BridgeConfig = {
  host: string;
  port: number;
  autoPort: boolean;
  allowedHosts: string[];
  allowedRoots: string[];
  bridgeToken?: string;
  /** Destructive-tool checkpoints (stop/abort/permission/answer_question). Default: on. Operational safety only. */
  checkpoints: boolean;
  /**
   * Milliseconds without observed activity while OpenCode still reports busy before a
   * session is reported as "stalled". Default: 120000 (2 minutes).
   */
  stalledMs?: number;
  opencodeBaseUrl?: string;
  opencodeBin: string;
  opencodeHost: string;
  opencodePortStart: number;
  opencodeUsername: string;
  opencodePassword?: string;
  stateDir: string;
  tunnel: "none" | "cloudflare" | "tailscale";
  tailscaleBin: string;
  cloudflaredBin: string;
  configPath?: string;
};

export type BridgeSession = {
  bridgeSessionId: string;
  opencodeSessionId: string;
  repoPath: string;
  baseUrl: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
};

/** Derived operational state of a bridge session (see src/state/derive.ts for the rules). */
export type OperationalState = "idle" | "busy" | "waiting-human" | "stalled" | "error";

/**
 * How well the bridge could resolve the session right now.
 * ready: everything answered. repo-not-authorized: deny (no server contact).
 * stale-repo: authorized path no longer exists on disk.
 * server-unreachable / session-not-found: opencode could not confirm the session.
 */
export type SessionAvailability =
  | "ready"
  | "repo-not-authorized"
  | "stale-repo"
  | "server-unreachable"
  | "session-not-found";

export type RawOpenCodeState = "idle" | "busy" | "retry" | null;

export type OperationRef = { type: string; at: string } | null;

/** Opencode intervention payload, passed through as reported by OpenCode (never reshaped). */
export type InterventionRecord = { [key: string]: JsonValue };

/**
 * Machine-readable completion evidence for an `idle` report (CP1.49-B guard).
 * - `corroborated-success`: server-stamped terminal `outcome: succeeded` (v2 only).
 * - `corroborated-failure`: server-stamped `outcome: failed|interrupted` (v2 only).
 * - `uncorroborated`: idle with no terminal evidence. Every v1 idle is
 *   uncorroborated by construction: a v1 idle must NEVER be reported as a
 *   completed execution.
 * - `not-applicable`: the state is not `idle` (busy/stalled/waiting-human/error).
 */
export type CompletionEvidence =
  | "corroborated-success"
  | "corroborated-failure"
  | "uncorroborated"
  | "not-applicable";

export type OpencodeStateReport = {
  project: { repoPath: string; authorized: boolean };
  session: { bridgeSessionId: string; opencodeSessionId: string };
  state: OperationalState;
  availability: SessionAvailability;
  rawOpenCodeState: RawOpenCodeState;
  lastActivityAt: string | null;
  inactiveForMs: number | null;
  currentOperation: OperationRef;
  lastOperation: OperationRef;
  pendingInterventions: { permissions: InterventionRecord[]; questions: InterventionRecord[] };
  lastError: string | null;
  execution: { startedAt: string | null; lastEventAt: string | null };
  /** Non-fatal observation problems (e.g. a list endpoint that could not be reached). */
  notes: string[];
  /**
   * Safety guard for automated consumers. True only when every observation
   * layer (status, permissions, questions, messages) returned confirmed data.
   * When false, `idle`/`ready` must NOT be treated as safe-to-proceed: keep
   * polling or escalate to a human instead of continuing execution, declaring
   * the task complete, answering interventions, or starting dependent work.
   * The event stream is auxiliary and does not affect this flag.
   */
  observationComplete: boolean;
  /** Whether an `idle` state rests on server-stamped terminal evidence. */
  completionEvidence: CompletionEvidence;
};

export type OpencodeMessagePart = {
  id?: string;
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type OpencodeMessage = {
  info: Record<string, unknown>;
  parts: OpencodeMessagePart[];
};

export type OpencodeSession = Record<string, unknown> & {
  id?: string;
  title?: string;
};

export type OpencodeDiff = Record<string, unknown> & {
  path?: string;
  oldPath?: string;
  newPath?: string;
  status?: string;
  diff?: string;
  patch?: string;
};

export type OpencodeStatus = Record<string, unknown>;

export type ToolResult<T extends JsonValue = JsonValue> = {
  structuredContent: T;
  content: Array<{ type: "text"; text: string }>;
  /** MCP error marker so clients can distinguish failed/blocked calls from successes. */
  isError?: boolean;
};
