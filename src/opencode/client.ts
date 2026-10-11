import type { OpencodeDiff, OpencodeMessage, OpencodeMessagePart, OpencodeSession, OpencodeStatus } from "../types.js";
import { isDeepStrictEqual } from "node:util";

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
 * Ambiguous send outcome: the transport failed (network fault, timeout, 5xx)
 * or a conflict could not be reconciled, so it is unknowable whether the
 * prompt was accepted. Never a license to resend blindly: callers must
 * reconcile with the SAME message id via getMessages/getMessageIfExists
 * first. The original failure text is always embedded in `message`.
 */
export class IndeterminateSendError extends Error {
  readonly promptMessageID?: string;
  constructor(messageID: string | undefined, causeText: string) {
    super(
      `opencode send indeterminate for message ${messageID ?? "(unknown id)"}: ` +
        `the prompt may have been accepted; reconcile with the same message id ` +
        `via getMessages/getMessageIfExists before resending (cause: ${causeText})`
    );
    this.name = "IndeterminateSendError";
    this.promptMessageID = messageID;
  }
}

/**
 * The prompt was already accepted under this id (verified by reading the
 * message back after an id conflict). Carries the accepted message so callers
 * can report a duplicate without a second POST.
 */
export class DuplicatePromptError extends Error {
  readonly promptMessageID: string;
  readonly existing: OpencodeMessage;
  constructor(messageID: string, existing: OpencodeMessage) {
    super(`opencode send duplicate: message ${messageID} was already accepted`);
    this.name = "DuplicatePromptError";
    this.promptMessageID = messageID;
    this.existing = existing;
  }
}

export class IndeterminateInterventionError extends Error {
  constructor(kind: "answer" | "reject" | "permission", id: string, causeText: string) {
    super(
      `opencode ${kind} indeterminate for ${id}: the intervention may already be resolved; ` +
        `re-read the session-scoped pending interventions before any retry (cause: ${causeText})`
    );
    this.name = "IndeterminateInterventionError";
  }
}

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

/**
 * Translate a public bridge answer to OpenCode v2's reply vocabulary
 * (`Permission.Reply = once | always | reject`, verified against the v2 OpenAPI).
 * `allow` grants one call (`once`); `allow`/`once` with `remember`, or a plain
 * `always`, grants persistently (`always`); `deny`/`reject` refuse (`reject`).
 * Anything unrecognised fails closed to `reject` — an unknown input can only
 * ever refuse, never grant. A `deny` combined with `remember: true` has no v2
 * equivalent (the reply body carries no remember flag): the refusal is kept
 * and the flag is dropped, documented at `respondPermission`.
 */
export function toV2PermissionDecision(response: PermissionResponse, remember = false): "once" | "always" | "reject" {
  switch (response) {
    case "always":
      return "always";
    case "deny":
    case "reject":
      return "reject";
    case "allow":
    case "once":
      return remember ? "always" : "once";
    default:
      return "reject";
  }
}

export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission?: string;
  patterns?: string[];
  metadata?: Record<string, unknown>;
  always?: string[];
  tool?: { messageID?: string; callID?: string };
  /**
   * OpenCode v2 passthrough fields (`Permission.Request`). `source.messageID`
   * is additionally normalized into `tool.messageID` (the bridge's internal
   * linkage read by intervention reconciliation) when it identifies a tool
   * call; `source.id` is intentionally NOT mapped to `callID` (unverified).
   */
  action?: string;
  resources?: string[];
  save?: string[];
  message?: string;
  source?: { type?: string; messageID?: string; id?: string };
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
  questions?: QuestionInfo[];
  tool?: { messageID?: string; callID?: string };
  /**
   * OpenCode v2 passthrough fields (`Form.Info`, verified live on 2.0.20).
   * Forms are carried verbatim — never translated into `questions[]`: field
   * types, keys and answer constraints have no faithful v1 equivalent, and an
   * invented translation could make a later human answer land on the wrong
   * field or value. Consumers only need `id`/`sessionID` (filtering, counting,
   * passthrough display); a future reply path must use `fields`/`metadata`
   * directly against `POST .../form/:id/reply { answer: {...} }`.
   */
  title?: string;
  fields?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

export type FormAnswerValue = string | number | boolean | string[];
export type FormAnswer = Record<string, FormAnswerValue>;

export type QuestionMutationResult = {
  applied: boolean;
  alreadyResolved: boolean;
  resolution?: "answered" | "cancelled";
};

export type OpencodeHealth = { healthy: boolean; version?: string };

/**
 * v1 contract: `GET /global/health` answers JSON `{ healthy: boolean, version?: string }`.
 * Anything else (HTML, malformed JSON, unexpected shape) is NOT a v1 success and
 * falls through to the v2 availability probe below.
 */
function isV1HealthPayload(value: unknown): value is { healthy: boolean; version?: unknown } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.healthy === "boolean";
}

/**
 * v2 contract: `GET /api/project` (authenticated) answers a JSON array of
 * Project objects (`{ id: string, canonical, time, sandboxes, ... }`).
 * An empty array is a valid healthy answer (server up + auth ok, no known projects).
 * Every non-empty entry must at least carry a non-empty string `id`; anything else
 * (HTML, malformed JSON, scalar, object, entries without id) is rejected.
 */
function isValidProjectList(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      !Array.isArray(item) &&
      typeof (item as Record<string, unknown>).id === "string" &&
      ((item as Record<string, unknown>).id as string).length > 0
  );
}
/**
 * Session id contract shared by OpenCode 1.x (direct object) and 2.x
 * (`{ data: {...} }` envelope): a non-empty string starting with `ses_`.
 * Anything else (missing, non-string, wrong prefix) is rejected.
 */
const SESSION_ID_PATTERN = /^ses_/;

function extractSessionId(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "ID", "sessionID"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && SESSION_ID_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Normalize a create-session response to the inner session object.
 * Accepts the v1 direct shape (`{ id, ... }`, incl. `ID`/`sessionID` aliases)
 * and the v2 wrapped shape (`{ data: { id, title, ... } }`).
 * Returns null when no strictly valid session id is present.
 */
function normalizeSessionResponse(value: unknown): OpencodeSession | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (extractSessionId(record)) return value as OpencodeSession;
  const data = record.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data) && extractSessionId(data)) {
    return data as OpencodeSession;
  }
  return null;
}

/**
 * Unpack a v2 active-session payload (`{ data: { ses_id: { type: "running" } } }`)
 * to the bridge's `{ ses_id: { type: "busy" } }` status map. Only confirmed
 * running sessions are mapped; absent sessions are omitted (never idle).
 * Anything else (non-object envelope, non-object `data`, non-`ses_` keys,
 * non-running entries) throws instead of populating a false state.
 */
function unpackActiveSessions(value: unknown): Record<string, OpencodeStatus> {
  const route = "/api/session/active";
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`opencode GET ${route} returned unexpected response (expected JSON { data: {...} })`);
  }
  const data = (value as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error(`opencode GET ${route} returned unexpected response (expected JSON { data: {...} })`);
  }
  const statuses: Record<string, OpencodeStatus> = {};
  for (const [id, entry] of Object.entries(data as Record<string, unknown>)) {
    if (!SESSION_ID_PATTERN.test(id)) {
      throw new Error(`opencode GET ${route} returned unexpected response (invalid session id ${id})`);
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`opencode GET ${route} returned unexpected response (invalid entry for ${id})`);
    }
    if ((entry as Record<string, unknown>).type !== "running") {
      throw new Error(`opencode GET ${route} returned unexpected response (unknown state for ${id})`);
    }
    statuses[id] = { type: "busy" };
  }
  return statuses;
}

/**
 * Unpack a session-list response to a validated array.
 * Accepts the v1 direct shape (JSON array) and the v2 wrapped shape
 * (`{ data: [...], cursor? }`) on either route. Every entry must carry a
 * strictly valid `ses_` id; anything else throws instead of flowing
 * silently to callers. Entries from other projects/directories are returned
 * as-is: callers match by id against bridge-managed sessions (never merged).
 */
function unpackSessionList(value: unknown, route: string): OpencodeSession[] {
  let raw: unknown = value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    raw = (value as Record<string, unknown>).data;
  }
  if (!Array.isArray(raw)) {
    throw new Error(`opencode GET ${route} returned unexpected response (expected JSON array of sessions)`);
  }
  for (const item of raw) {
    if (!extractSessionId(item)) {
      throw new Error(`opencode GET ${route} returned unexpected response (session without valid id)`);
    }
  }
  return raw as OpencodeSession[];
}

/**
 * HTTP 405 from `POST /session` (confirmed on OpenCode 2.0.20): the routing
 * layer refused the method, so the action was not executed and no session
 * exists. Unlike 5xx/auth/network failures, this is unambiguous — falling
 * back to a single `POST /api/session` cannot duplicate anything.
 */
function isMethodNotAllowedError(error: unknown): boolean {
  return error instanceof Error && /failed: 405\b/.test(error.message);
}

function isInvalidJsonError(error: unknown): boolean {
  return error instanceof Error && /returned invalid JSON/.test(error.message);
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /failed: 404\b/.test(error.message);
}

function isConflictError(error: unknown): boolean {
  return error instanceof Error && /failed: 409\b/.test(error.message);
}

/**
 * Ambiguous transport outcome for a POST: the request may have reached the
 * server (network fault, abort/timeout, 408, 5xx). Anything else carrying an
 * HTTP status (400/401/403/404/…) was definitively answered.
 */
function isAmbiguousSendError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError") {
    return true;
  }
  return error instanceof Error && /failed: (408|5\d\d)\b/.test(error.message);
}

function sendErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasNotFoundTag(error: unknown, tag: "MessageNotFound" | "SessionNotFound"): boolean {
  return error instanceof Error && new RegExp(tag).test(error.message);
}

/**
 * Normalize one OpenCode v2 permission request (`Permission.Request`) to the
 * bridge's internal record. Strict: `id` must be a non-empty string and
 * `sessionID` must equal the requested session — a foreign record is rejected,
 * never mixed in. `source.messageID` (tool calls) becomes `tool.messageID`;
 * known optional fields pass through only when well-typed, unknown fields are
 * ignored, malformed known fields are rejected.
 */
function normalizeV2Permission(item: unknown, route: string, sessionId: string): PermissionRequest {
  const fail = (detail: string): Error =>
    new Error(`opencode GET ${route} returned unexpected response (${detail})`);
  if (typeof item !== "object" || item === null || Array.isArray(item)) throw fail("entry is not an object");
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) throw fail("entry without valid id");
  if (record.sessionID !== sessionId) throw fail(`entry for another session (expected ${sessionId})`);
  const out: PermissionRequest = { id: record.id, sessionID: sessionId };
  if (typeof record.action === "string") out.action = record.action;
  if (record.resources !== undefined) {
    if (!Array.isArray(record.resources) || !record.resources.every((r) => typeof r === "string")) {
      throw fail("entry with invalid resources");
    }
    out.resources = [...(record.resources as string[])];
  }
  if (record.save !== undefined) {
    if (!Array.isArray(record.save) || !record.save.every((r) => typeof r === "string")) {
      throw fail("entry with invalid save");
    }
    out.save = [...(record.save as string[])];
  }
  if (typeof record.message === "string") out.message = record.message;
  if (record.metadata !== undefined) {
    if (typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata)) {
      throw fail("entry with invalid metadata");
    }
    out.metadata = { ...(record.metadata as Record<string, unknown>) };
  }
  const source = record.source;
  if (source !== undefined) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) throw fail("entry with invalid source");
    const src = source as Record<string, unknown>;
    const normalized: NonNullable<PermissionRequest["source"]> = {};
    if (typeof src.type === "string") normalized.type = src.type;
    if (typeof src.messageID === "string") normalized.messageID = src.messageID;
    if (typeof src.id === "string") normalized.id = src.id;
    out.source = normalized;
    if (src.type === "tool" && typeof src.messageID === "string" && src.messageID.length > 0) {
      out.tool = { messageID: src.messageID };
    }
  }
  return out;
}

/**
 * Normalize one OpenCode v2 form (`Form.Info`) to the bridge's internal
 * question record. Strict: `id` must be a non-empty string, `sessionID` must
 * equal the requested session (a foreign form is rejected, never mixed in),
 * `title` must be a string and `fields` an array of objects (field internals
 * pass through verbatim and unverified). `metadata` passes through when it is
 * a plain object. No `questions[]`/`tool` linkage is synthesized: v2 forms
 * carry neither, so reconciliation treats them as actionable until answered
 * or cancelled (fail-open toward the human, never suppressed).
 */
function normalizeV2Form(item: unknown, route: string, sessionId: string): QuestionRequest {
  const fail = (detail: string): Error =>
    new Error(`opencode GET ${route} returned unexpected response (${detail})`);
  if (typeof item !== "object" || item === null || Array.isArray(item)) throw fail("entry is not an object");
  const record = item as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) throw fail("entry without valid id");
  if (record.sessionID !== sessionId) throw fail(`entry for another session (expected ${sessionId})`);
  if (typeof record.title !== "string") throw fail("entry without valid title");
  if (!Array.isArray(record.fields)) throw fail("entry without valid fields");
  const fields: Array<Record<string, unknown>> = [];
  for (const field of record.fields) {
    if (typeof field !== "object" || field === null || Array.isArray(field)) {
      throw fail("entry with invalid field");
    }
    fields.push({ ...(field as Record<string, unknown>) });
  }
  const out: QuestionRequest = { id: record.id, sessionID: sessionId, title: record.title, fields };
  if (record.metadata !== undefined) {
    if (typeof record.metadata !== "object" || record.metadata === null || Array.isArray(record.metadata)) {
      throw fail("entry with invalid metadata");
    }
    out.metadata = { ...(record.metadata as Record<string, unknown>) };
  }
  return out;
}

/**
 * Unpack a v2 session-scoped form listing (`{ data: [...] }`).
 * The envelope is mandatory; an empty array is a confirmed zero.
 */
function unpackV2Forms(value: unknown, route: string, sessionId: string): QuestionRequest[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`opencode GET ${route} returned unexpected response (expected JSON { data: [...] })`);
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new Error(`opencode GET ${route} returned unexpected response (expected JSON { data: [...] })`);
  }
  return data.map((item) => normalizeV2Form(item, route, sessionId));
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formFieldActive(field: Record<string, unknown>, answer: FormAnswer): boolean {
  if (field.when === undefined) return true;
  if (!Array.isArray(field.when)) throw new Error(`invalid when constraint for form field: ${String(field.key)}`);
  return field.when.every((raw) => {
    if (!plainObject(raw) || typeof raw.key !== "string" || (raw.op !== "eq" && raw.op !== "neq")) {
      throw new Error(`invalid when constraint for form field: ${String(field.key)}`);
    }
    const actual = answer[raw.key];
    if (actual === undefined) return false;
    const hit = Array.isArray(actual) ? actual.some((item) => item === raw.value) : actual === raw.value;
    return raw.op === "eq" ? hit : !hit;
  });
}

function formOptions(field: Record<string, unknown>): string[] | null {
  if (field.options === undefined) return null;
  if (!Array.isArray(field.options)) throw new Error(`invalid options for form field: ${String(field.key)}`);
  const values: string[] = [];
  for (const option of field.options) {
    if (!plainObject(option) || typeof option.value !== "string") {
      throw new Error(`invalid options for form field: ${String(field.key)}`);
    }
    values.push(option.value);
  }
  return values;
}

/** Mirror OpenCode 2.0.20 Form.validateAnswer without coercing user data. */
export function validateV2FormAnswer(fields: Array<Record<string, unknown>>, answer: FormAnswer): void {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const field of fields) {
    if (typeof field.key !== "string" || field.key.length === 0 || typeof field.type !== "string") {
      throw new Error("form contains a field without a valid key/type");
    }
    if (byKey.has(field.key)) throw new Error(`form contains duplicate field key: ${field.key}`);
    byKey.set(field.key, field);
  }
  for (const key of Object.keys(answer)) {
    if (!byKey.has(key)) throw new Error(`unknown form field: ${key}`);
  }
  for (const field of fields) {
    const key = field.key as string;
    const value = answer[key];
    if (field.type === "external") {
      if (value !== true) throw new Error(`external form field must be acknowledged: ${key}`);
      continue;
    }
    const active = formFieldActive(field, answer);
    if (value === undefined) {
      if (field.required === true && active) throw new Error(`missing required form field: ${key}`);
      continue;
    }
    if (!active) throw new Error(`form field is not active: ${key}`);
    if (field.type === "string") {
      if (typeof value !== "string") throw new Error(`expected string for form field: ${key}`);
      if (field.required === true && value.length === 0) throw new Error(`missing required form field: ${key}`);
      if (typeof field.minLength === "number" && value.length < field.minLength) throw new Error(`form field is too short: ${key}`);
      if (typeof field.maxLength === "number" && value.length > field.maxLength) throw new Error(`form field is too long: ${key}`);
      if (typeof field.pattern === "string") {
        let matches = false;
        try { matches = new RegExp(field.pattern).test(value); } catch { throw new Error(`form field has invalid pattern: ${key}`); }
        if (!matches) throw new Error(`form field does not match pattern: ${key}`);
      }
      if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`expected email for form field: ${key}`);
      if (field.format === "uri" && !URL.canParse(value)) throw new Error(`expected URI for form field: ${key}`);
      if (field.format === "date") {
        const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : null;
        if (date === null || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error(`expected date for form field: ${key}`);
      }
      if (field.format === "date-time" && Number.isNaN(new Date(value).getTime())) throw new Error(`expected date-time for form field: ${key}`);
      const options = formOptions(field);
      if (options !== null && field.custom !== true && !options.includes(value)) throw new Error(`invalid option for form field: ${key}`);
      continue;
    }
    if (field.type === "number" || field.type === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`expected number for form field: ${key}`);
      if (field.type === "integer" && !Number.isInteger(value)) throw new Error(`expected integer for form field: ${key}`);
      if (typeof field.minimum === "number" && value < field.minimum) throw new Error(`form field is too small: ${key}`);
      if (typeof field.maximum === "number" && value > field.maximum) throw new Error(`form field is too large: ${key}`);
      continue;
    }
    if (field.type === "boolean") {
      if (typeof value !== "boolean") throw new Error(`expected boolean for form field: ${key}`);
      continue;
    }
    if (field.type === "multiselect") {
      if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`expected string array for form field: ${key}`);
      if (field.required === true && value.length === 0) throw new Error(`missing required form field: ${key}`);
      if (typeof field.minItems === "number" && value.length < field.minItems) throw new Error(`too few selections for form field: ${key}`);
      if (typeof field.maxItems === "number" && value.length > field.maxItems) throw new Error(`too many selections for form field: ${key}`);
      const options = formOptions(field) ?? [];
      if (field.custom !== true && value.some((item) => !options.includes(item))) throw new Error(`invalid option for form field: ${key}`);
      continue;
    }
    throw new Error(`unsupported form field type for ${key}: ${String(field.type)}`);
  }
}

function sameAnswer(left: unknown, right: FormAnswer): boolean {
  return plainObject(left) && isDeepStrictEqual(left, right);
}

/**
 * Unpack a v2 session-scoped permission listing (`{ data: [...] }`).
 * The envelope is mandatory; an empty array is a confirmed zero.
 */
function unpackV2Permissions(value: unknown, route: string, sessionId: string): PermissionRequest[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`opencode GET ${route} returned unexpected response (expected JSON { data: [...] })`);
  }
  const data = (value as Record<string, unknown>).data;
  if (!Array.isArray(data)) {
    throw new Error(`opencode GET ${route} returned unexpected response (expected JSON { data: [...] })`);
  }
  return data.map((item) => normalizeV2Permission(item, route, sessionId));
}

/**
 * v2 message id contract (`Session.Message.ID`): a string starting with `msg_`.
 */
const MESSAGE_ID_PATTERN = /^msg_/;

function unexpectedMessage(route: string, detail: string): Error {
  return new Error(`opencode GET ${route} returned unexpected response (${detail})`);
}

/**
 * Normalize one OpenCode v2 message (`Session.Message.*`: flat `{ id, time,
 * text?, content?, type, ... }`, observed live on 2.0.20) to the bridge's
 * internal `{ info, parts }` contract read by `state.ts`/`interventions.ts`.
 *
 * Mapping (nothing invented):
 * - `info.id` ← v2 `id` (strict `^msg_`, else rejected).
 * - `info.role` ← v2 `type` verbatim (`user`/`assistant`/…): the server's own
 *   discriminator. Consumers only compare against `"user"`.
 * - `info.time` ← `{ created, completed? }` (numbers only), preserving the
 *   `completed ?? created` reads in `state.ts` and the completion check in
 *   `interventions.ts`.
 * - `info.error` ← v2 `error` only when it carries a string `message`
 *   (`name` ← v2 `type` when present; `state.ts` defaults a missing name).
 *   Absent otherwise: no error is ever synthesized.
 * - `info.metadata`/`agent`/`model`/`sessionID` ← passed through when present.
 * - `parts` ← assistant `content[]` (`text`/`reasoning` → `{type,text}`;
 *   `tool` → `{type:"tool",id?,name?,state?}`), else a single text part from
 *   string `text`, else `[]` (e.g. idle/compaction): content is never invented.
 */
function normalizeV2Message(item: unknown, route: string): OpencodeMessage {
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    throw unexpectedMessage(route, "message is not an object");
  }
  const record = item as Record<string, unknown>;
  const fail = (detail: string): Error => unexpectedMessage(route, detail);

  const id = record.id;
  if (typeof id !== "string" || !MESSAGE_ID_PATTERN.test(id)) throw fail("message without valid id");
  const time = record.time;
  if (typeof time !== "object" || time === null || Array.isArray(time)) throw fail("message without valid time");
  const times = time as Record<string, unknown>;
  if (typeof times.created !== "number") throw fail("message without valid time");
  const type = record.type;
  if (typeof type !== "string" || type.length === 0) throw fail("message without valid type");

  const info: Record<string, unknown> = {
    id,
    role: type,
    time: {
      created: times.created,
      ...(typeof times.completed === "number" ? { completed: times.completed } : {})
    }
  };
  const error = record.error;
  if (typeof error === "object" && error !== null && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") {
      const name = (error as Record<string, unknown>).type;
      info.error = { ...(typeof name === "string" ? { name } : {}), message };
    }
  }
  for (const key of ["metadata", "agent", "model", "sessionID"] as const) {
    const value = record[key];
    if (value !== undefined) info[key] = value;
  }

  const parts: OpencodeMessagePart[] = [];
  const content = record.content;
  if (content !== undefined) {
    if (!Array.isArray(content)) throw fail("message with invalid content");
    for (const entry of content) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw fail("message with invalid content");
      const part = entry as Record<string, unknown>;
      if (part.type === "text" || part.type === "reasoning") {
        if (typeof part.text !== "string") throw fail("message with invalid content");
        parts.push({ type: part.type, text: part.text });
      } else if (part.type === "tool") {
        const toolPart: OpencodeMessagePart = { type: "tool" };
        if (typeof part.id === "string") toolPart.id = part.id;
        if (typeof part.name === "string") toolPart.name = part.name;
        if (part.state !== undefined) toolPart.state = part.state;
        parts.push(toolPart);
      } else {
        throw fail("message with invalid content");
      }
    }
  } else if (typeof record.text === "string") {
    parts.push({ type: "text", text: record.text });
  }
  return { info, parts };
}

/**
 * Unpack a v2 message-list payload (`{ data: [...], cursor? }`) to normalized
 * messages. An empty `data` array is valid (no messages yet).
 */
function unpackV2MessageList(value: unknown, route: string): OpencodeMessage[] {
  const raw =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).data
      : undefined;
  if (!Array.isArray(raw)) throw unexpectedMessage(route, "expected JSON { data: [...] }");
  return raw.map((item) => normalizeV2Message(item, route));
}

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

  /**
   * Health detection compatible with OpenCode 1.x and 2.x.
   *
   * - v1: `GET /global/health` must answer JSON `{ healthy: boolean, version? }`.
   *   A well-formed v1 answer is authoritative (healthy true/false respected as-is).
   * - v2: `GET /global/health` answers HTTP 200 HTML and `/api/global/health` is 404,
   *   so on any v1 transport/protocol/shape failure fall back to `GET /api/project`
   *   as an authenticated availability probe. It must answer a JSON array of
   *   Project objects (empty array accepted); HTML, malformed JSON, HTTP 401/403,
   *   or unexpected shapes throw and are never reported as healthy.
   *
   * Auth (Basic), bounded GET retries, and throw-on-failure semantics are preserved
   * via `request()`; `OpencodeProcessManager.isHealthy()` keeps mapping to
   * `result.healthy === true`.
   */
  async health(): Promise<OpencodeHealth> {
    try {
      const v1 = await this.request<unknown>("/global/health");
      if (isV1HealthPayload(v1)) {
        if (v1.healthy === true) {
          return { healthy: true, version: typeof v1.version === "string" ? v1.version : undefined };
        }
        return typeof v1.version === "string" ? { healthy: false, version: v1.version } : { healthy: false };
      }
      // Well-formed HTTP+JSON but unexpected shape: not v1, try the v2 probe.
    } catch {
      // Transport error, non-2xx (incl. 401/403/404), invalid JSON/HTML: try v2 probe.
    }

    // v2 availability probe only: never returns project data, only health.
    const projects = await this.request<unknown>("/api/project");
    if (!isValidProjectList(projects)) {
      throw new Error("opencode GET /api/project returned unexpected response (expected JSON array of projects)");
    }
    return { healthy: true };
  }

  /**
   * Session listing compatible with OpenCode 1.x and 2.x. Both are idempotent
   * GETs, so the v2 route is a safe fallback (bounded retries preserved).
   *
   * - v1: `GET /session` answers a JSON array directly; a valid array is
   *   returned unchanged (v1 behavior preserved, including empty lists).
   * - v2: v1 paths serve the SPA (HTTP 200 HTML → invalid JSON) or 404, so on
   *   either signal fall back once to `GET /api/session`, which answers
   *   `{ data: [...], cursor? }` (first page; cursor pagination beyond that is
   *   out of scope). The envelope is unwrapped and every entry must carry a
   *   strictly valid `ses_` id. Auth failures (401/403), 5xx, network errors
   *   and valid-JSON-but-unexpected shapes throw without a fallback attempt.
   */
  async listSessions(): Promise<OpencodeSession[]> {
    let v1: unknown;
    try {
      v1 = await this.request<unknown>("/session", {}, { allowNotFound: true });
    } catch (error) {
      if (!isInvalidJsonError(error)) throw error;
      v1 = null;
    }
    if (v1 === null) {
      return unpackSessionList(await this.request<unknown>("/api/session"), "/api/session");
    }
    return unpackSessionList(v1, "/session");
  }

  /**
   * Session creation compatible with OpenCode 1.x and 2.x.
   *
   * - v1: `POST /session` answers the session object directly.
   * - v2: `POST /session` is gone (404, or 405 Method Not Allowed as confirmed
   *   on 2.0.20, or HTML from the web app) and
   *   `POST /api/session` answers `{ data: { id: "ses_...", title, ... } }`,
   *   which is unwrapped to the inner session object before returning.
   *
   * No-duplicate rule: POSTs are never retried (`request()` uses a single
   * attempt for non-idempotent methods) and the v2 route is tried at most
   * once, only when v1 clearly created nothing (HTTP 404, HTTP 405, or 2xx
   * HTML that cannot be a session). Any other v1 outcome — HTTP error
   * (401/403/5xx), network failure, or 2xx JSON without a strictly valid
   * `ses_` id — throws immediately without a second POST, so a fallback can
   * never orphan or duplicate a session created by the first call. The same
   * strict id check applies to the v2 answer; HTML, malformed JSON and
   * unexpected shapes throw.
   */
  async createSession(title?: string, parentID?: string): Promise<OpencodeSession> {
    const body = JSON.stringify({ title, parentID });
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    };

    let v1: unknown;
    try {
      // allowNotFound maps a missing v1 route to null (no session created).
      v1 = await this.request<unknown>("/session", init, { allowNotFound: true });
    } catch (error) {
      // 2xx HTML (web-app fallback) parses as invalid JSON, and HTTP 405
      // (method refused: confirmed v2.0.20 answer to POST /session) both prove
      // no session was created. Anything else may be ambiguous: fail closed.
      if (!isInvalidJsonError(error) && !isMethodNotAllowedError(error)) throw error;
      v1 = null;
    }
    if (v1 === null) {
      // v1 route missing (404), method refused (405), or HTML: nothing was
      // created, safe to try the v2 route exactly once.
      const v2 = await this.request<unknown>("/api/session", init);
      const session = normalizeSessionResponse(v2);
      if (!session) {
        throw new Error("opencode POST /api/session returned unexpected response (missing valid session id)");
      }
      return session;
    }
    // Any other v1 answer (incl. 204/empty) must carry a valid id; a second
    // POST is forbidden here so a created session can never be duplicated.
    const session = normalizeSessionResponse(v1);
    if (!session) {
      throw new Error("opencode POST /session returned unexpected response (missing valid session id)");
    }
    return session;
  }

  /**
   * Single-session read compatible with OpenCode 1.x and 2.x.
   *
   * - v1: `GET /session/:id` answers the session object directly.
   * - v2: the v1 path serves HTML (or 404), so on either signal fall back to
   *   `GET /api/session/:id`, which answers `{ data: Session.Info }`.
   *   The envelope is unwrapped; the inner object must carry a strictly valid
   *   `ses_` id that equals the requested id (a different id is rejected so a
   *   foreign session can never be mistaken for the managed one).
   *
   * HTTP 404 on both routes throws `failed: 404`, preserving the
   * session-not-found semantics relied on by `src/mcp/state.ts`. Auth
   * failures, 5xx, network errors and unexpected shapes throw as-is.
   */
  async getSession(sessionId: string): Promise<OpencodeSession> {
    const encoded = encodeURIComponent(sessionId);
    let v1: unknown;
    try {
      v1 = await this.request<unknown>(`/session/${encoded}`, {}, { allowNotFound: true });
    } catch (error) {
      if (!isInvalidJsonError(error)) throw error;
      v1 = null;
    }
    if (v1 === null) {
      return this.checkedSession(await this.request<unknown>(`/api/session/${encoded}`), `/api/session/:id`, sessionId);
    }
    return this.checkedSession(v1, "/session/:id", sessionId);
  }

  /** Normalize one session payload and require its id to match the request. */
  private checkedSession(value: unknown, route: string, sessionId: string): OpencodeSession {
    const session = normalizeSessionResponse(value);
    const found = session ? extractSessionId(session) : null;
    if (!session || found !== sessionId) {
      throw new Error(`opencode GET ${route} returned unexpected response (missing session ${sessionId})`);
    }
    return session;
  }

  /**
   * Server-wide session liveness compatible with OpenCode 1.x and 2.x.
   *
   * - v1: `GET /session/status` answers `{ ses_id: { type: "idle"|"busy"|"retry", ... } }`
   *   directly; a valid v1 answer is returned unchanged.
   * - v2: the v1 path serves the SPA (HTTP 200 HTML → invalid JSON) or 404, so on
   *   either signal fall back once to `GET /api/session/active`, which answers
   *   `{ data: { ses_id: { type: "running" } } }` (idle sessions are absent).
   *
   * No-false-completion rule: only ids confirmed present in `active` with
   * `type: "running"` are mapped (to `{ type: "busy" }`, the confirmed-running
   * translation). Absent ids are simply omitted — never synthesized as idle:
   * corroborating every session would mean querying foreign sessions, and the
   * pre-existing consumer contract already defines absence as unknown/idle
   * exactly as in v1 (`state.ts` → `rawState null` → idle; `tools.ts` → null).
   * Auth failures, 5xx, network errors and valid-JSON-but-unexpected shapes
   * throw without a fallback attempt. There is deliberately no call to
   * `/api/session/status`: v2 reads it as a session id and answers 400.
   */
  async getSessionStatus(): Promise<Record<string, OpencodeStatus>> {
    let v1: unknown;
    try {
      v1 = await this.request<unknown>("/session/status", {}, { allowNotFound: true });
    } catch (error) {
      if (!isInvalidJsonError(error)) throw error;
      v1 = null;
    }
    if (v1 === null) {
      return unpackActiveSessions(await this.request<unknown>("/api/session/active"));
    }
    return v1 as Record<string, OpencodeStatus>;
  }

  /**
   * Interrupt a running session, compatible with OpenCode 1.x and 2.x. POSTs
   * are never retried; at most two POSTs happen and only on different routes.
   *
   * - v1: `POST /session/:id/abort` answers a boolean; returned unchanged.
   * - v2: the v1 path answers 405 (or HTML), so on either signal post once to
   *   `POST /api/session/:id/interrupt`, which answers `{ interrupted }`.
   *   `interrupted: false` is returned as-is (nothing was interrupted — never
   *   presented as an effective interruption). A v1 404 names a missing
   *   session on both generations and never falls back; 401/403/5xx, network
   *   faults and unexpected shapes throw without a second POST.
   */
  async abortSession(sessionId: string): Promise<boolean> {
    const encoded = encodeURIComponent(sessionId);
    try {
      return await this.request<boolean>(`/session/${encoded}/abort`, { method: "POST" });
    } catch (error) {
      if (!isMethodNotAllowedError(error) && !isInvalidJsonError(error)) throw error;
    }
    const receipt = await this.request<unknown>(`/api/session/${encoded}/interrupt`, { method: "POST" });
    const raw =
      typeof receipt === "object" && receipt !== null && !Array.isArray(receipt) && "data" in receipt
        ? (receipt as Record<string, unknown>).data
        : receipt;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("opencode POST /api/session/:id/interrupt returned unexpected response (expected { interrupted })");
    }
    const interrupted = (raw as Record<string, unknown>).interrupted;
    if (typeof interrupted !== "boolean") {
      throw new Error("opencode POST /api/session/:id/interrupt returned unexpected response (expected { interrupted })");
    }
    return interrupted;
  }

  async getTodo(sessionId: string): Promise<unknown[]> {
    return await this.request<unknown[]>(`/session/${encodeURIComponent(sessionId)}/todo`);
  }

  /**
   * Message listing compatible with OpenCode 1.x and 2.x. Both are idempotent
   * GETs, so the v2 route is a safe fallback (bounded retries preserved,
   * `limit` forwarded to both).
   *
   * - v1: `GET /session/:id/message` answers `{ info, parts }[]` directly; a
   *   valid v1 answer is returned byte-for-byte (behavior preserved).
   * - v2: the v1 path serves the SPA (HTTP 200 HTML → invalid JSON) or 404,
   *   so on either signal fall back once to `GET /api/session/:id/message`,
   *   which answers `{ data: [...], cursor? }` (first page). Items are
   *   validated and normalized via `normalizeV2Message`. Auth failures,
   *   5xx, network errors and valid-JSON-but-unexpected shapes throw without
   *   a fallback attempt.
   */
  async getMessages(sessionId: string, limit?: number): Promise<OpencodeMessage[]> {
    const query = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
    const encoded = encodeURIComponent(sessionId);
    let v1: unknown;
    try {
      v1 = await this.request<unknown>(`/session/${encoded}/message${query}`, {}, { allowNotFound: true });
    } catch (error) {
      if (!isInvalidJsonError(error)) throw error;
      v1 = null;
    }
    if (v1 === null) {
      return unpackV2MessageList(
        await this.request<unknown>(`/api/session/${encoded}/message${query}`),
        "/api/session/:id/message"
      );
    }
    return v1 as OpencodeMessage[];
  }

  /**
   * Send a prompt compatible with OpenCode 1.x and 2.x. POSTs are never
   * retried and the v2 route is posted at most once, so no path here can
   * duplicate a prompt by itself.
   *
   * - v1: `POST /session/:id/message` (sync, returns the message) or
   *   `.../prompt_async` (204, accepted). Any v1 success is returned unchanged.
   * - v2: v1 write paths answer 405 (or HTML), so on either signal — and only
   *   then — translate once to `POST /api/session/:id/prompt`. A v1 404 means
   *   the session is missing (on both generations) and never falls back.
   *
   * v2 option policy: `messageID`→`id` verbatim and textual parts only. Every
   * other v1 option (`model`, `agent`, `system`, `tools`, `noReply: true`,
   * `async: false`) has no verified prompt equivalent and throws an explicit
   * incompatible-option error instead of being silently dropped; persistent
   * session configuration is never touched. The v2 answer `{ data: Inbox }`
   * is an acceptance receipt: it is validated and acknowledged by returning
   * `undefined` (as with v1 async sends) — never shaped into an assistant
   * message, never a completion claim.
   *
   * Conflict/ambiguity policy: an id conflict (409) is verified by reading the
   * message back — found means duplicate (reported, not resent), missing means
   * indeterminate. Ambiguous transport outcomes (network fault, abort, 408,
   * 5xx) always surface as `IndeterminateSendError`, which demands
   * reconciliation with the same id before any resend.
   */
  async sendMessage(input: SendMessageInput): Promise<OpencodeMessage | undefined> {
    const body = this.messageBody(input);
    const v1path = input.async
      ? `/session/${encodeURIComponent(input.sessionId)}/prompt_async`
      : `/session/${encodeURIComponent(input.sessionId)}/message`;
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };

    try {
      return (await this.request<unknown>(v1path, init)) as OpencodeMessage | undefined;
    } catch (error) {
      if (isConflictError(error)) return await this.reconcilePromptConflict(input, error);
      if (isAmbiguousSendError(error)) throw new IndeterminateSendError(input.messageID, sendErrorText(error));
      // 404 on POST names a missing session on both generations; only a
      // refused method (405) or an HTML body proves route incompatibility.
      if (!isMethodNotAllowedError(error) && !isInvalidJsonError(error)) throw error;
    }

    const v2body = this.v2PromptBody(input);
    const v2path = `/api/session/${encodeURIComponent(input.sessionId)}/prompt`;
    let receipt: unknown;
    try {
      receipt = await this.request<unknown>(v2path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(v2body)
      });
    } catch (error) {
      if (isConflictError(error)) return await this.reconcilePromptConflict(input, error);
      if (isAmbiguousSendError(error)) throw new IndeterminateSendError(input.messageID, sendErrorText(error));
      throw error;
    }
    this.checkPromptReceipt(receipt, v2path);
    return undefined;
  }

  /**
   * Verify an id conflict by reading the message back under the same id.
   * Found → duplicate (no resend). Missing → indeterminate (reconcile first).
   * Unverifiable without our id → indeterminate as well.
   */
  private async reconcilePromptConflict(
    input: SendMessageInput,
    conflict: unknown
  ): Promise<OpencodeMessage | undefined> {
    if (input.messageID === undefined) {
      throw new IndeterminateSendError(input.messageID, sendErrorText(conflict));
    }
    let existing: OpencodeMessage | null;
    try {
      existing = await this.getMessageIfExists(input.sessionId, input.messageID);
    } catch (error) {
      throw new IndeterminateSendError(input.messageID, `conflict reply unverifiable: ${sendErrorText(error)}`);
    }
    if (!existing) {
      throw new IndeterminateSendError(input.messageID, sendErrorText(conflict));
    }
    throw new DuplicatePromptError(input.messageID, existing);
  }

  /**
   * Build the v2 prompt body, preserving the idempotent id and the text.
   * Anything without a verified equivalent fails loudly; session-level
   * configuration (model/agent) is never switched implicitly.
   */
  private v2PromptBody(input: SendMessageInput): Record<string, unknown> {
    const incompatible: string[] = [];
    if (input.providerID !== undefined || input.modelID !== undefined) {
      incompatible.push('"model" (providerID/modelID): switch the session model first, the prompt endpoint has no model field');
    }
    if (input.agent !== undefined) {
      incompatible.push('"agent": switch the session agent first, the prompt endpoint has no agent field');
    }
    if (input.system !== undefined) {
      incompatible.push('"system": the v2 prompt endpoint has no system field');
    }
    if (input.tools !== undefined) {
      incompatible.push('"tools": the v2 prompt endpoint has no tools field');
    }
    if (input.noReply === true) {
      incompatible.push('"noReply": the v2 prompt endpoint has no noReply field');
    }
    if (input.async === false) {
      incompatible.push('"async:false": v2 prompts are inbox-accepted; poll getMessages for the reply instead');
    }
    if (input.messageID !== undefined && !/^msg/.test(input.messageID)) {
      incompatible.push(`"messageID": must match ^msg for v2 idempotency (got ${JSON.stringify(input.messageID)})`);
    }
    const parts = this.messageBody(input).parts as Array<Record<string, unknown>>;
    if (!parts.every((part) => part.type === "text" && typeof part.text === "string")) {
      incompatible.push('"parts": only textual parts can be translated to a v2 prompt');
    }
    if (incompatible.length > 0) {
      throw new Error(`opencode send incompatible options for OpenCode v2: ${incompatible.join("; ")}`);
    }
    return input.messageID === undefined ? { text: input.text } : { id: input.messageID, text: input.text };
  }

  /** Validate a v2 prompt receipt (`{ data: Inbox }`) without interpreting it. */
  private checkPromptReceipt(receipt: unknown, path: string): void {
    const fail = (): Error =>
      new Error(`opencode POST ${path} returned unexpected response (expected JSON { data: { id } })`);
    if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) throw fail();
    const data = (receipt as Record<string, unknown>).data;
    if (typeof data !== "object" || data === null || Array.isArray(data)) throw fail();
    if (typeof (data as Record<string, unknown>).id !== "string") throw fail();
  }

  /**
   * Single-message read compatible with OpenCode 1.x and 2.x.
   *
   * - v1: `GET /session/:id/message/:mid` answers `{ info, parts }` directly
   *   (404 → null, behavior preserved).
   * - v2: the v1 path serves HTML (or 404), so on either signal fall back to
   *   `GET /api/session/:id/message/:mid`, which answers `{ data: Message }`.
   *   The item is validated, normalized, and required to carry the requested
   *   id (a different id is rejected).
   *
   * 404 semantics: v2 distinguishes the missing object in the error body.
   * `MessageNotFound` (and untagged 404s, i.e. v1 servers) → null, preserving
   * the long-standing contract. `SessionNotFound` → throw: a gone session
   * must never masquerade as a merely-missing message.
   */
  async getMessageIfExists(sessionId: string, messageID: string): Promise<OpencodeMessage | null> {
    const encodedSession = encodeURIComponent(sessionId);
    const encodedMessage = encodeURIComponent(messageID);
    let v1: unknown;
    try {
      v1 = await this.request<unknown>(
        `/session/${encodedSession}/message/${encodedMessage}`,
        {},
        { allowNotFound: true }
      );
    } catch (error) {
      if (!isInvalidJsonError(error)) throw error;
      v1 = null;
    }
    if (v1 !== null) return v1 as OpencodeMessage | null;

    let v2: unknown;
    try {
      v2 = await this.request<unknown>(`/api/session/${encodedSession}/message/${encodedMessage}`);
    } catch (error) {
      if (!isNotFoundError(error)) throw error;
      if (hasNotFoundTag(error, "SessionNotFound")) {
        throw new Error(`opencode session not found: ${sessionId}`);
      }
      return null;
    }
    const raw =
      typeof v2 === "object" && v2 !== null && !Array.isArray(v2) && "data" in v2
        ? (v2 as Record<string, unknown>).data
        : v2;
    const message = normalizeV2Message(raw, "/api/session/:id/message/:id");
    if (message.info.id !== messageID) {
      throw unexpectedMessage("/api/session/:id/message/:id", `missing message ${messageID}`);
    }
    return message;
  }

  /**
   * Pending permission requests compatible with OpenCode 1.x and 2.x.
   *
   * - v1: `GET /permission` answers a server-wide array; a valid answer is
   *   returned as-is and callers keep filtering by session (behavior preserved;
   *   `sessionId` is accepted but unused on this route).
   * - v2: the v1 path serves the SPA (HTTP 200 HTML → invalid JSON), 404 or
   *   405, so on any of those signals fall back once — and only when a
   *   `sessionId` is given — to the session-scoped
   *   `GET /api/session/:id/permission`, answered as `{ data: [...] }`. The
   *   global `GET /api/permission/request` is deliberately never used: scoping
   *   by route removes cross-session mixing by construction. Every entry must
   *   carry a valid id and the requested `sessionID`; anything else throws.
   *
   * An empty array on either route is a confirmed zero. Network errors,
   * 401/403, 5xx, HTML outside the fallback signals and unexpected shapes
   * throw and are never converted into an empty list.
   */
  async listPermissions(sessionId?: string): Promise<PermissionRequest[]> {
    let v1: unknown;
    try {
      v1 = await this.request<unknown>("/permission", {}, { allowNotFound: true });
    } catch (error) {
      if (!isInvalidJsonError(error) && !isMethodNotAllowedError(error)) throw error;
      v1 = null;
    }
    if (v1 === null) {
      if (!sessionId) {
        throw new Error("opencode GET /permission unavailable and no session id for the v2 fallback");
      }
      const route = `/api/session/${encodeURIComponent(sessionId)}/permission`;
      return unpackV2Permissions(await this.request<unknown>(route), route, sessionId);
    }
    return v1 as PermissionRequest[];
  }

  /**
   * Pending human-input requests compatible with OpenCode 1.x and 2.x.
   *
   * - v1: `GET /question` answers a server-wide array of `QuestionRequest`
   *   (`{ id, sessionID, questions[], tool? }`); a valid answer is returned
   *   as-is and callers keep filtering by session (`sessionId` is accepted
   *   but unused on this route).
   * - v2: there is no `/question` route (the v1 path serves HTML, 404 or 405),
   *   so on any of those signals fall back once — and only with a `sessionId`
   *   — to the session-scoped `GET /api/session/:id/form`, answered as
   *   `{ data: Form.Info[] }`. The global `GET /api/form` is deliberately
   *   never used. Forms are carried verbatim (`title`/`fields`/`metadata`);
   *   nothing is translated into v1 `questions[]`.
   *
   * An empty array on either route is a confirmed zero. Network errors,
   * 401/403, 5xx, HTML outside the fallback signals and unexpected shapes
   * throw and are never converted into an empty list.
   */
  async listQuestions(sessionId?: string): Promise<QuestionRequest[]> {
    let v1: unknown;
    try {
      v1 = await this.request<unknown>("/question", {}, { allowNotFound: true });
    } catch (error) {
      if (!isInvalidJsonError(error) && !isMethodNotAllowedError(error)) throw error;
      v1 = null;
    }
    if (v1 === null) {
      if (!sessionId) {
        throw new Error("opencode GET /question unavailable and no session id for the v2 fallback");
      }
      const route = `/api/session/${encodeURIComponent(sessionId)}/form`;
      return unpackV2Forms(await this.request<unknown>(route), route, sessionId);
    }
    return v1 as QuestionRequest[];
  }

  /** Answer one pending v1 question or v2 form after session-scoped identity validation. */
  async answerQuestion(
    sessionId: string,
    requestID: string,
    input: { answers?: string[][]; answer?: FormAnswer }
  ): Promise<QuestionMutationResult> {
    const pending = await this.listQuestions(sessionId);
    const record = pending.find((item) => item.id === requestID && item.sessionID === sessionId);
    if (!record) return await this.reconcileV2FormResolution(sessionId, requestID, input.answer);
    if (record.fields) {
      if (input.answer === undefined || input.answers !== undefined) throw new Error("v2 form reply requires answer and forbids v1 answers");
      validateV2FormAnswer(record.fields, input.answer);
      const route = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestID)}/reply`;
      try {
        await this.request<void>(route, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: input.answer })
        });
        return { applied: true, alreadyResolved: false };
      } catch (error) {
        if (isAmbiguousSendError(error)) throw new IndeterminateInterventionError("answer", requestID, sendErrorText(error));
        if (!isConflictError(error)) throw error;
        return await this.reconcileV2FormResolution(sessionId, requestID, input.answer);
      }
    }
    if (input.answers === undefined || input.answer !== undefined) throw new Error("v1 question reply requires answers and forbids v2 answer");
    let applied: boolean;
    try {
      applied = await this.request<boolean>(`/question/${encodeURIComponent(requestID)}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: input.answers })
      });
    } catch (error) {
      if (isAmbiguousSendError(error)) throw new IndeterminateInterventionError("answer", requestID, sendErrorText(error));
      throw error;
    }
    return { applied: Boolean(applied), alreadyResolved: false };
  }

  /** Reject/cancel one pending v1 question or v2 form after session isolation checks. */
  async rejectQuestion(sessionId: string, requestID: string): Promise<QuestionMutationResult> {
    const pending = await this.listQuestions(sessionId);
    const record = pending.find((item) => item.id === requestID && item.sessionID === sessionId);
    if (!record) return await this.reconcileV2FormResolution(sessionId, requestID);
    if (record.fields) {
      const route = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestID)}`;
      try {
        await this.request<void>(route, { method: "DELETE" });
        return { applied: true, alreadyResolved: false };
      } catch (error) {
        if (isAmbiguousSendError(error)) throw new IndeterminateInterventionError("reject", requestID, sendErrorText(error));
        if (!isConflictError(error)) throw error;
        return await this.reconcileV2FormResolution(sessionId, requestID);
      }
    }
    let applied: boolean;
    try {
      applied = await this.request<boolean>(`/question/${encodeURIComponent(requestID)}/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
    } catch (error) {
      if (isAmbiguousSendError(error)) throw new IndeterminateInterventionError("reject", requestID, sendErrorText(error));
      throw error;
    }
    return { applied: Boolean(applied), alreadyResolved: false };
  }

  private async reconcileV2FormResolution(
    sessionId: string,
    requestID: string,
    expectedAnswer?: FormAnswer
  ): Promise<QuestionMutationResult> {
    const route = `/api/session/${encodeURIComponent(sessionId)}/form/${encodeURIComponent(requestID)}`;
    let payload: unknown;
    try {
      payload = await this.request<unknown>(route);
    } catch (error) {
      if (isNotFoundError(error)) throw new Error(`opencode form ${requestID} is not pending for session ${sessionId}`);
      throw error;
    }
    const raw = plainObject(payload) && "data" in payload ? payload.data : payload;
    if (!plainObject(raw) || raw.id !== requestID || raw.sessionID !== sessionId || !plainObject(raw.state)) {
      throw new Error(`opencode GET ${route} returned unexpected response (invalid form detail or session ownership)`);
    }
    if (raw.state.status === "cancelled") {
      if (expectedAnswer !== undefined) throw new Error(`opencode form ${requestID} was already cancelled; answer was not applied`);
      return { applied: false, alreadyResolved: true, resolution: "cancelled" };
    }
    if (raw.state.status === "answered") {
      if (expectedAnswer !== undefined && !sameAnswer(raw.state.answer, expectedAnswer)) {
        throw new Error(`opencode form ${requestID} was already answered with a different answer`);
      }
      return { applied: false, alreadyResolved: true, resolution: "answered" };
    }
    throw new Error(`opencode form ${requestID} is pending but was absent from the session-scoped pending list`);
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
   *
   * OpenCode 2.x (`POST /api/session/:id/permission/:rid/reply { decision }`):
   * the v1 path answers 405 (or HTML), so on either signal — and only then —
   * verify first via the session-scoped permission listing that `permissionId`
   * is still pending for `sessionId`, translate once (`allow`→`once`,
   * `allow`/`once`+`remember` or `always`→`always`, `deny`/`reject`→`reject`,
   * anything else fails closed to `reject`; a `deny`+`remember` combination
   * has no v2 equivalent and the remember flag is dropped, documented here),
   * then post exactly one reply. A missing record means "not pending": no
   * reply is posted. A 404 naming the session aborts as session-not-found; a
   * 404 after a verified pending record is indeterminate (applied-then-
   * vanished vs settled-unanswered are indistinguishable) and never reported
   * as granted. POSTs are never retried; human confirmation gates live in the
   * MCP layer (`confirmCheckpoint`) and are untouched.
   */
  async respondPermission(sessionId: string, permissionId: string, response: PermissionResponse, remember = false): Promise<boolean> {
    const reply = toOpencodePermissionReply(response);
    const encodedSession = encodeURIComponent(sessionId);
    const encodedPermission = encodeURIComponent(permissionId);
    try {
      return await this.request<boolean>(`/session/${encodedSession}/permissions/${encodedPermission}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response: reply, remember })
      });
    } catch (error) {
      if (isAmbiguousSendError(error)) throw new IndeterminateInterventionError("permission", permissionId, sendErrorText(error));
      if (!isMethodNotAllowedError(error) && !isInvalidJsonError(error)) throw error;
    }

    const route = `/api/session/${encodedSession}/permission`;
    const pending = unpackV2Permissions(await this.request<unknown>(route), route, sessionId);
    if (!pending.some((record) => record.id === permissionId)) {
      throw new Error(`opencode permission ${permissionId} is not pending for session ${sessionId}`);
    }
    const decision = toV2PermissionDecision(response, remember);
    try {
      await this.request<unknown>(`${route}/${encodedPermission}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision })
      });
    } catch (error) {
      if (isAmbiguousSendError(error)) throw new IndeterminateInterventionError("permission", permissionId, sendErrorText(error));
      if (!isNotFoundError(error)) throw error;
      if (hasNotFoundTag(error, "SessionNotFound")) {
        throw new Error(`opencode session not found: ${sessionId}`);
      }
      throw new Error(
        `opencode reply indeterminate for permission ${permissionId}: not found after verification; ` +
          `reconcile via list before retrying (cause: ${sendErrorText(error)})`
      );
    }
    return true;
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
