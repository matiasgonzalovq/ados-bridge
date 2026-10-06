import type { OpencodeDiff, OpencodeMessage, OpencodeSession, OpencodeStatus } from "../types.js";

export type OpencodeClientOptions = {
  baseUrl: string;
  username?: string;
  password?: string;
  fetchImpl?: typeof fetch;
};

export type SendMessageInput = {
  sessionId: string;
  text: string;
  providerID?: string;
  modelID?: string;
  agent?: string;
  system?: string;
  noReply?: boolean;
  tools?: Record<string, boolean>;
  async?: boolean;
  /**
   * Stable client message id (OpenCode `messageID`, pattern `^msg`). OpenCode 1.18.30
   * treats it as an idempotency key: resending the same id does not create a second prompt.
   */
  messageID?: string;
};

/**
 * Public permission responses accepted by the bridge's MCP surface.
 * `allow`/`deny` are the original bridge names; `reject` is OpenCode's own name for a refusal
 * and is accepted as an alias so newer clients can speak OpenCode's vocabulary directly.
 */
export const PERMISSION_RESPONSES = ["allow", "deny", "once", "always", "reject"] as const;

export type PermissionResponse = (typeof PERMISSION_RESPONSES)[number];

/**
 * The only values OpenCode accepts in `POST /session/:id/permissions/:permissionID`
 * (`PermissionV1.Reply = ["once", "always", "reject"]` in @opencode-ai/schema v1.18.30).
 * Anything else is rejected upstream with HTTP 400.
 */
export type OpencodePermissionReply = "once" | "always" | "reject";

const OPENCODE_REPLIES: Record<PermissionResponse, OpencodePermissionReply> = {
  allow: "once",
  deny: "reject",
  once: "once",
  always: "always",
  reject: "reject"
};

/**
 * Translate a public bridge response into OpenCode's wire value.
 * Never widens a grant: `deny`/`reject` refuse the call, `allow`/`once` grant exactly one
 * use, and only an explicit `always` remembers the grant. An unrecognised value fails closed
 * to `reject`, so a bad input can never become a permission grant.
 */
export function toOpencodePermissionReply(response: PermissionResponse): OpencodePermissionReply {
  return OPENCODE_REPLIES[response] ?? "reject";
}

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID?: string; callID?: string };
};

export type QuestionOption = { label: string; description?: string };

export type QuestionInfo = {
  question: string;
  header?: string;
  options?: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID?: string; callID?: string };
};

const MAX_READ_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 50;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isTransientNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

export class OpencodeClient {
  private readonly baseUrl: string;
  private readonly username?: string;
  private readonly password?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpencodeClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.username = options.username;
    this.password = options.password;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get url(): string {
    return this.baseUrl;
  }

  private headers(extra?: HeadersInit): HeadersInit {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...(extra as Record<string, string> | undefined)
    };
    if (this.password) {
      const user = this.username ?? "opencode";
      const token = Buffer.from(`${user}:${this.password}`).toString("base64");
      headers.Authorization = `Basic ${token}`;
    }
    return headers;
  }

  private async request<T>(path: string, init: RequestInit = {}, options: { allowNotFound?: boolean } = {}): Promise<T> {
    const method = (init.method ?? "GET").toUpperCase();
    // Bounded resilience: only idempotent reads are retried, so retries can never
    // duplicate prompts, permission answers, or any other state-changing write.
    const retryable = IDEMPOTENT_METHODS.has(method);
    const attempts = retryable ? MAX_READ_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: this.headers(init.headers)
        });
      } catch (error) {
        if (!retryable || attempt === attempts || !isTransientNetworkError(error)) throw error;
        await delay(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      if (!res.ok) {
        if (options.allowNotFound && res.status === 404) return null as T;
        const canRetry = retryable && isRetryableStatus(res.status) && attempt < attempts;
        if (!canRetry) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `opencode ${method} ${path} failed: ${res.status} ${res.statusText}${body ? ` - ${body}` : ""}`
          );
        }
        await res.text().catch(() => "");
        await delay(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new Error(
          `opencode ${method} ${path} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    throw new Error(`opencode ${method} ${path} failed after ${attempts} attempts`);
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    return await this.request<{ healthy: boolean; version?: string }>("/global/health");
  }

  async listSessions(): Promise<OpencodeSession[]> {
    return await this.request<OpencodeSession[]>("/session");
  }

  async createSession(title?: string, parentID?: string): Promise<OpencodeSession> {
    return await this.request<OpencodeSession>("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, parentID })
    });
  }

  async getSession(sessionId: string): Promise<OpencodeSession> {
    return await this.request<OpencodeSession>(`/session/${encodeURIComponent(sessionId)}`);
  }

  async getSessionStatus(): Promise<Record<string, OpencodeStatus>> {
    return await this.request<Record<string, OpencodeStatus>>("/session/status");
  }

  async abortSession(sessionId: string): Promise<boolean> {
    return await this.request<boolean>(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
  }

  async getTodo(sessionId: string): Promise<unknown[]> {
    return await this.request<unknown[]>(`/session/${encodeURIComponent(sessionId)}/todo`);
  }

  async getMessages(sessionId: string, limit?: number): Promise<OpencodeMessage[]> {
    const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    return await this.request<OpencodeMessage[]>(`/session/${encodeURIComponent(sessionId)}/message${query}`);
  }

  async sendMessage(input: SendMessageInput): Promise<OpencodeMessage | undefined> {
    const body = this.messageBody(input);
    const path = input.async ? `/session/${encodeURIComponent(input.sessionId)}/prompt_async` : `/session/${encodeURIComponent(input.sessionId)}/message`;
    return await this.request<OpencodeMessage | undefined>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  /** Fetch a single message by id; returns null when OpenCode has no such message (404). */
  async getMessageIfExists(sessionId: string, messageID: string): Promise<OpencodeMessage | null> {
    return await this.request<OpencodeMessage | null>(
      `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageID)}`,
      {},
      { allowNotFound: true }
    );
  }

  /** Pending permission requests across sessions on this opencode server (GET /permission). */
  async listPermissions(): Promise<PermissionRequest[]> {
    return await this.request<PermissionRequest[]>("/permission");
  }

  /** Pending question requests across sessions on this opencode server (GET /question). */
  async listQuestions(): Promise<QuestionRequest[]> {
    return await this.request<QuestionRequest[]>("/question");
  }

  /** Answer a pending question (POST /question/{requestID}/reply). Returns true on success. */
  async answerQuestion(requestID: string, answers: string[][]): Promise<boolean> {
    return await this.request<boolean>(`/question/${encodeURIComponent(requestID)}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers })
    });
  }

  /** Reject a pending question without answering (POST /question/{requestID}/reject). */
  async rejectQuestion(requestID: string): Promise<boolean> {
    return await this.request<boolean>(`/question/${encodeURIComponent(requestID)}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({})
    });
  }

  async runCommand(sessionId: string, command: string, args?: string, agent?: string, modelID?: string): Promise<OpencodeMessage> {
    return await this.request<OpencodeMessage>(`/session/${encodeURIComponent(sessionId)}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, arguments: args ?? "", agent, model: modelID ? { modelID } : undefined })
    });
  }

  async getDiff(sessionId: string, messageID?: string): Promise<OpencodeDiff[]> {
    const query = messageID ? `?messageID=${encodeURIComponent(messageID)}` : "";
    return await this.request<OpencodeDiff[]>(`/session/${encodeURIComponent(sessionId)}/diff${query}`);
  }

  /**
   * Answer a pending permission request. The public `response` is translated to OpenCode's
   * wire vocabulary (`once | always | reject`) before the POST: OpenCode 1.18.30 answers
   * HTTP 400 to the legacy public names (`deny` is refused with
   * `expects "once" | "always" | "reject"`), so `deny` is sent upstream as `reject`.
   */
  async respondPermission(sessionId: string, permissionId: string, response: PermissionResponse, remember = false): Promise<boolean> {
    const reply = toOpencodePermissionReply(response);
    return await this.request<boolean>(`/session/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response: reply, remember })
    });
  }

  async readFile(path: string): Promise<unknown> {
    return await this.request<unknown>(`/file/content?path=${encodeURIComponent(path)}`);
  }

  async findFiles(query: string, limit = 50, directory?: string): Promise<string[]> {
    const params = new URLSearchParams({ query, limit: String(limit) });
    if (directory) params.set("directory", directory);
    return await this.request<string[]>(`/find/file?${params.toString()}`);
  }

  async fileStatus(): Promise<unknown[]> {
    return await this.request<unknown[]>("/file/status");
  }

  async vcs(): Promise<unknown> {
    return await this.request<unknown>("/vcs");
  }

  async listAgents(): Promise<unknown[]> {
    return await this.request<unknown[]>("/agent");
  }

  async listCommands(): Promise<unknown[]> {
    return await this.request<unknown[]>("/command");
  }

  async listProviders(): Promise<unknown> {
    return await this.request<unknown>("/provider");
  }

  async getProviderAuthMethods(): Promise<unknown> {
    return await this.request<unknown>("/provider/auth");
  }

  async getConfigProviders(): Promise<unknown> {
    return await this.request<unknown>("/config/providers");
  }

  private messageBody(input: SendMessageInput): Record<string, unknown> {
    const model = input.providerID || input.modelID ? { providerID: input.providerID, modelID: input.modelID } : undefined;
    return {
      messageID: input.messageID,
      model,
      agent: input.agent,
      noReply: input.noReply,
      system: input.system,
      tools: input.tools,
      parts: [{ type: "text", text: input.text }]
    };
  }
}
