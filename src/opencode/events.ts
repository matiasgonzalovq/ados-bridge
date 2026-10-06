/**
 * Observation of the opencode event stream (GET /event, SSE) as served by opencode 1.18.30
 * (verified against the local OpenAPI spec and a live server).
 *
 * Goals for V1: bounded operational state only. No history, no blocking of the bridge,
 * one reader per server, controlled start, reconnect with backoff, full cleanup on stop.
 */

export type ObservedEvent = {
  type: string;
  sessionID?: string;
  at: number;
};

export type SessionObservation = {
  sessionID: string;
  lastActivityAt: number | null;
  lastEventAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  /** Latest session-scoped event observed (what the session looked like doing). */
  current: ObservedEvent | null;
  /** Latest completion marker (session.idle or a status event reporting idle). */
  lastCompletion: ObservedEvent | null;
  recent: ObservedEvent[];
};

export type EventObserverOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
  maxSessions?: number;
  maxRecentPerSession?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  now?: () => number;
};

const DEFAULT_MAX_SESSIONS = 50;
const DEFAULT_MAX_RECENT = 10;
const DEFAULT_RECONNECT_BASE_MS = 500;
const DEFAULT_RECONNECT_MAX_MS = 15_000;
const MAX_ERROR_LENGTH = 500;

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

function extractSessionId(payload: Record<string, unknown>): string | undefined {
  const container = (payload.properties ?? payload.data ?? {}) as Record<string, unknown>;
  if (typeof container.sessionID === "string") return container.sessionID;
  if (typeof payload.sessionID === "string") return payload.sessionID;
  return undefined;
}

function isIdleMarker(type: string, payload: Record<string, unknown>): boolean {
  if (type === "session.idle") return true;
  if (type !== "session.status") return false;
  const container = (payload.properties ?? payload.data ?? {}) as Record<string, unknown>;
  const status = container.status as { type?: unknown } | undefined;
  return status?.type === "idle";
}

export class OpencodeEventObserver {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly username?: string;
  private readonly password?: string;
  private readonly maxSessions: number;
  private readonly maxRecent: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly now: () => number;

  private readonly sessions = new Map<string, SessionObservation>();
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelSleep: (() => void) | null = null;
  private loopPromise: Promise<void> | null = null;
  private started = false;
  private stopped = false;
  private connected = false;

  lastEventAt: number | null = null;
  lastConnectError: string | null = null;
  connections = 0;

  constructor(options: EventObserverOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.username = options.username;
    this.password = options.password;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxRecent = options.maxRecentPerSession ?? DEFAULT_MAX_RECENT;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get isRunning(): boolean {
    return this.started && !this.stopped;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** Idempotent, non-blocking start: the connection loop runs in the background. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.loopPromise = this.runLoop();
  }

  /** Abort the stream, cancel pending reconnects, and await the loop. Safe to call twice. */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.stopped = true;
    this.abortController?.abort();
    this.abortController = null;
    this.cancelSleep?.();
    this.cancelSleep = null;
    await this.loopPromise?.catch(() => undefined);
    this.loopPromise = null;
    this.started = false;
    this.connected = false;
  }

  /** Record local activity (e.g. a prompt the bridge just got accepted) without an event. */
  noteActivity(sessionID: string, at: number = this.now()): void {
    const observation = this.touch(sessionID);
    observation.lastActivityAt = at;
    observation.lastEventAt = at;
    this.lastEventAt = at;
  }

  snapshot(sessionID: string): SessionObservation | null {
    const found = this.sessions.get(sessionID);
    if (!found) return null;
    return { ...found, recent: [...found.recent] };
  }

  observedSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  status(): { baseUrl: string; running: boolean; connected: boolean; lastEventAt: number | null; lastConnectError: string | null; sessions: number } {
    return {
      baseUrl: this.baseUrl,
      running: this.isRunning,
      connected: this.connected,
      lastEventAt: this.lastEventAt,
      lastConnectError: this.lastConnectError,
      sessions: this.sessions.size
    };
  }

  private async runLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      let connectedAt: number | null = null;
      try {
        connectedAt = await this.connectOnce();
        this.lastConnectError = null;
      } catch (error) {
        if (this.stopped) break;
        this.lastConnectError = errorMessage(error);
      } finally {
        this.connected = false;
      }
      if (this.stopped) break;

      // A connection that stayed open is evidence of health: reset the backoff.
      if (connectedAt !== null && this.now() - connectedAt > 5_000) attempt = 0;
      attempt += 1;
      const wait = Math.min(this.reconnectBaseMs * 2 ** Math.min(attempt - 1, 6), this.reconnectMaxMs);
      const slept = await this.sleep(wait);
      if (!slept) break;
    }
  }

  /** One SSE connection; resolves when the stream ends, rejects on setup/stream failures. */
  private async connectOnce(): Promise<number> {
    const controller = new AbortController();
    this.abortController = controller;
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (this.password) {
      const user = this.username ?? "opencode";
      headers.Authorization = `Basic ${Buffer.from(`${user}:${this.password}`).toString("base64")}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}/event`, { headers, signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`event stream unavailable: ${response.status} ${response.statusText}`);
    }

    const connectedAt = this.now();
    this.connected = true;
    this.connections += 1;
    this.lastConnectError = null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? "";
        for (const part of parts) this.consumeBlock(part);
        // Tolerate servers that separate events with a single newline.
        if (buffer.includes("\n")) {
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) this.consumeLine(line);
        }
      }
    } finally {
      this.connected = false;
      controller.abort();
      this.abortController = null;
      reader.releaseLock?.();
    }
    return connectedAt;
  }

  private consumeBlock(block: string): void {
    for (const line of block.split(/\r?\n/)) this.consumeLine(line);
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const payload = trimmed.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return;
    }
    if (parsed && typeof parsed === "object") this.record(parsed as Record<string, unknown>);
  }

  private record(payload: Record<string, unknown>): void {
    const type = payload.type;
    if (typeof type !== "string" || type.length === 0) return;
    const at = this.now();
    this.lastEventAt = at;

    const sessionID = extractSessionId(payload);
    if (!sessionID) return; // server-level events (heartbeats, plugins) never imply session activity

    const observation = this.touch(sessionID);
    const event: ObservedEvent = { type, sessionID, at };
    observation.lastActivityAt = at;
    observation.lastEventAt = at;
    observation.current = event;
    observation.recent.unshift(event);
    if (observation.recent.length > this.maxRecent) observation.recent.length = this.maxRecent;

    if (type === "session.error") {
      const container = (payload.properties ?? payload.data ?? {}) as Record<string, unknown>;
      observation.lastError = extractErrorMessage(container.error) ?? errorMessage(JSON.stringify(container).slice(0, MAX_ERROR_LENGTH));
      observation.lastErrorAt = at;
    }

    if (isIdleMarker(type, payload)) observation.lastCompletion = event;
  }

  private touch(sessionID: string): SessionObservation {
    const existing = this.sessions.get(sessionID);
    if (existing) {
      // Re-insert so LRU eviction removes least recently used sessions first.
      this.sessions.delete(sessionID);
      this.sessions.set(sessionID, existing);
      return existing;
    }
    const created: SessionObservation = {
      sessionID,
      lastActivityAt: null,
      lastEventAt: null,
      lastError: null,
      lastErrorAt: null,
      current: null,
      lastCompletion: null,
      recent: []
    };
    this.sessions.set(sessionID, created);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
    return created;
  }

  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (this.stopped) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        this.reconnectTimer = null;
        this.cancelSleep = null;
        resolve(true);
      }, ms);
      this.reconnectTimer = timer;
      this.cancelSleep = () => {
        clearTimeout(timer);
        this.reconnectTimer = null;
        this.cancelSleep = null;
        resolve(false);
      };
    });
  }
}

function extractErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name : undefined;
  const message =
    typeof record.message === "string"
      ? record.message
      : typeof record.data === "object" && record.data && "message" in record.data
        ? String((record.data as Record<string, unknown>).message)
        : null;
  if (!message && !name) return null;
  const text = `${name ?? "error"}${message ? `: ${message}` : ""}`;
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH)}…` : text;
}

export type ObserverTarget = { baseUrl: string; username?: string; password?: string };

/**
 * One observer per opencode server, started lazily the first time something is observed.
 * Observers are stopped when their server stops (or when the bridge shuts down).
 */
export class EventObserverRegistry {
  private readonly observers = new Map<string, OpencodeEventObserver>();

  constructor(
    private readonly defaults: {
      fetchImpl?: typeof fetch;
      reconnectBaseMs?: number;
      reconnectMaxMs?: number;
      now?: () => number;
    } = {}
  ) {}

  ensure(target: ObserverTarget): OpencodeEventObserver {
    const key = target.baseUrl.replace(/\/$/, "");
    const existing = this.observers.get(key);
    if (existing) {
      if (!existing.isRunning) existing.start();
      return existing;
    }
    const created = new OpencodeEventObserver({
      baseUrl: key,
      username: target.username,
      password: target.password,
      fetchImpl: this.defaults.fetchImpl,
      reconnectBaseMs: this.defaults.reconnectBaseMs,
      reconnectMaxMs: this.defaults.reconnectMaxMs,
      now: this.defaults.now
    });
    this.observers.set(key, created);
    created.start();
    return created;
  }

  get(baseUrl: string): OpencodeEventObserver | undefined {
    return this.observers.get(baseUrl.replace(/\/$/, ""));
  }

  async stop(baseUrl: string): Promise<void> {
    const key = baseUrl.replace(/\/$/, "");
    const observer = this.observers.get(key);
    if (!observer) return;
    this.observers.delete(key);
    await observer.stop();
  }

  async stopAll(): Promise<void> {
    const all = [...this.observers.values()];
    this.observers.clear();
    await Promise.all(all.map((observer) => observer.stop()));
  }

  status(): ReturnType<OpencodeEventObserver["status"]>[] {
    return [...this.observers.values()].map((observer) => observer.status());
  }
}
