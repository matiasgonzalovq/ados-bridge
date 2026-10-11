import { describe, expect, it } from "vitest";
import {
  DuplicatePromptError,
  IndeterminateSendError,
  OpencodeClient,
  PERMISSION_RESPONSES,
  toOpencodePermissionReply,
  validateV2FormAnswer,
  type PermissionResponse
} from "../src/opencode/client.js";

describe("OpencodeClient", () => {
  it("sends basic auth and JSON payloads", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: "ses_1" }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096/", username: "u", password: "p", fetchImpl });
    await client.createSession("Title");

    expect(calls[0]?.url).toBe("http://127.0.0.1:4096/session");
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: "Title" });
  });

  it("uses prompt_async for async messages", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(null, { status: 204 });
    };

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    await client.sendMessage({ sessionId: "abc", text: "hello", async: true });
    expect(calls[0]).toBe("http://localhost:4096/session/abc/prompt_async");
  });

  it("can request provider and model configuration", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    await client.listProviders();
    await client.getProviderAuthMethods();
    await client.getConfigProviders();

    expect(calls).toEqual([
      "http://localhost:4096/provider",
      "http://localhost:4096/provider/auth",
      "http://localhost:4096/config/providers"
    ]);
  });
});

describe("OpencodeClient answer/reject question v1/v2", () => {
  const json = (value: unknown, status = 200, statusText = "") =>
    new Response(JSON.stringify(value), { status, statusText, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } });

  it("answers v1 only after matching the question to the owned session", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method ?? "GET");
      calls.push({ path, method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === "/question" && method === "GET") return json([{ id: "q1", sessionID: "ses_a", questions: [{ question: "Pick" }] }]);
      if (path === "/question/q1/reply" && method === "POST") return json(true);
      return new Response("not found", { status: 404, statusText: "Not Found" });
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.answerQuestion("ses_a", "q1", { answers: [["yes"]] })).resolves.toEqual({ applied: true, alreadyResolved: false });
    expect(calls).toEqual([
      { path: "/question", method: "GET" },
      { path: "/question/q1/reply", method: "POST", body: { answers: [["yes"]] } }
    ]);
  });

  it("answers a structured v2 form with original keys/types and one POST", async () => {
    const fields = [
      { key: "target", type: "string", required: true, options: [{ value: "repo-a", label: "Repo A" }] },
      { key: "count", type: "integer", minimum: 1, maximum: 3 },
      { key: "tags", type: "multiselect", options: [{ value: "safe", label: "Safe" }], minItems: 1 },
      { key: "ack", type: "external", url: "https://example.test" }
    ];
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method ?? "GET");
      calls.push({ path, method, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path === "/question") return html();
      if (path === "/api/session/ses_a/form" && method === "GET") return json({ data: [{ id: "frm_1", sessionID: "ses_a", title: "Run", fields }] });
      if (path === "/api/session/ses_a/form/frm_1/reply" && method === "POST") return new Response(null, { status: 204 });
      return new Response("not found", { status: 404, statusText: "Not Found" });
    };
    const answer = { target: "repo-a", count: 2, tags: ["safe"], ack: true };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.answerQuestion("ses_a", "frm_1", { answer })).resolves.toEqual({ applied: true, alreadyResolved: false });
    expect(calls.filter((call) => call.method === "POST")).toEqual([
      { path: "/api/session/ses_a/form/frm_1/reply", method: "POST", body: { answer } }
    ]);
  });

  it("rejects invalid v2 values locally without any POST", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method ?? "GET");
      calls.push({ path, method });
      if (path === "/question") return html();
      return json({ data: [{ id: "frm_1", sessionID: "ses_a", title: "Run", fields: [{ key: "count", type: "integer", required: true, minimum: 1 }] }] });
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.answerQuestion("ses_a", "frm_1", { answer: { count: 1.5 } })).rejects.toThrow(/expected integer/);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("isolates sessions and never posts for a foreign form", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method ?? "GET");
      calls.push({ path, method });
      if (path === "/question") return html();
      if (path.endsWith("/form")) return json({ data: [] });
      return new Response("missing", { status: 404, statusText: "Not Found" });
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.answerQuestion("ses_a", "frm_foreign", { answer: { ok: true } })).rejects.toThrow(/not pending for session ses_a/);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });

  it("classifies a 409 with identical read-back as already answered, without retrying", async () => {
    let posts = 0;
    const answer = { choice: "safe" };
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method ?? "GET");
      if (path === "/question") return html();
      if (path.endsWith("/form") && method === "GET") return json({ data: [{ id: "frm_1", sessionID: "ses_a", title: "Pick", fields: [{ key: "choice", type: "string", required: true }] }] });
      if (path.endsWith("/reply") && method === "POST") { posts += 1; return json({ name: "FormAlreadySettledError" }, 409, "Conflict"); }
      if (path.endsWith("/form/frm_1") && method === "GET") return json({ data: { id: "frm_1", sessionID: "ses_a", state: { status: "answered", answer } } });
      return new Response("missing", { status: 404, statusText: "Not Found" });
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.answerQuestion("ses_a", "frm_1", { answer })).resolves.toEqual({ applied: false, alreadyResolved: true, resolution: "answered" });
    expect(posts).toBe(1);
  });

  it("cancels a v2 form with DELETE and never POSTs", async () => {
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      const method = String(init.method ?? "GET");
      methods.push(method);
      if (path === "/question") return html();
      if (path.endsWith("/form") && method === "GET") return json({ data: [{ id: "frm_1", sessionID: "ses_a", title: "Pick", fields: [{ key: "ok", type: "boolean" }] }] });
      if (path.endsWith("/form/frm_1") && method === "DELETE") return new Response(null, { status: 204 });
      return new Response("missing", { status: 404, statusText: "Not Found" });
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.rejectQuestion("ses_a", "frm_1")).resolves.toEqual({ applied: true, alreadyResolved: false });
    expect(methods).toContain("DELETE");
    expect(methods).not.toContain("POST");
  });

  it("validates conditional required fields and closed options", () => {
    const fields = [
      { key: "mode", type: "string", options: [{ value: "advanced", label: "Advanced" }] },
      { key: "detail", type: "string", required: true, when: [{ key: "mode", op: "eq", value: "advanced" }] }
    ];
    expect(() => validateV2FormAnswer(fields, { mode: "advanced" })).toThrow(/missing required/);
    expect(() => validateV2FormAnswer(fields, { mode: "invalid" })).toThrow(/invalid option/);
    expect(() => validateV2FormAnswer(fields, { mode: "advanced", detail: "ok" })).not.toThrow();
  });
});

describe("permission response wire mapping", () => {
  it("sends the public responses as OpenCode's accepted wire values", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify(true), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = new OpencodeClient({ baseUrl: "http://localhost:4096", fetchImpl });
    await client.respondPermission("ses_1", "per_1", "deny");
    await client.respondPermission("ses_1", "per_1", "reject");
    await client.respondPermission("ses_1", "per_1", "once");
    await client.respondPermission("ses_1", "per_1", "always");
    await client.respondPermission("ses_1", "per_1", "allow", true);

    // Regression: OpenCode 1.18.30 answers HTTP 400 to "deny" with
    // expects "once" | "always" | "reject".
    expect(calls[0]?.url).toBe("http://localhost:4096/session/ses_1/permissions/per_1");
    expect(calls.map((call) => call.body.response)).toEqual(["reject", "reject", "once", "always", "once"]);
    expect(calls[4]?.body).toEqual({ response: "once", remember: true });
  });

  it("never widens a grant and fails closed on unknown input", () => {
    expect(toOpencodePermissionReply("deny")).toBe("reject");
    expect(toOpencodePermissionReply("reject")).toBe("reject");
    expect(toOpencodePermissionReply("once")).toBe("once");
    expect(toOpencodePermissionReply("always")).toBe("always");
    expect(toOpencodePermissionReply("allow")).toBe("once");
    expect(toOpencodePermissionReply("banana" as PermissionResponse)).toBe("reject");
  });

  it("keeps the legacy public vocabulary alongside OpenCode's own name", () => {
    expect(PERMISSION_RESPONSES).toEqual(["allow", "deny", "once", "always", "reject"]);
  });
});

describe("OpencodeClient health (v1/v2 contracts)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

  function router(routes: Record<string, Response | ((call: number) => Response)>): {
    fetchImpl: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (url) => {
      n += 1;
      calls.push(String(url));
      const path = new URL(String(url)).pathname;
      const route = routes[path];
      if (typeof route === "function") return route(n);
      if (route) return route.clone();
      return new Response("not found", { status: 404, statusText: "Not Found" });
    };
    return { fetchImpl, calls };
  }

  it("accepts the v1 contract without calling /api/project", async () => {
    const { fetchImpl, calls } = router({ "/global/health": json({ healthy: true, version: "1.18.30" }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.health()).resolves.toEqual({ healthy: true, version: "1.18.30" });
    expect(calls).toEqual(["http://127.0.0.1:4096/global/health"]);
  });

  it("respects a well-formed v1 unhealthy answer without fallback", async () => {
    const { fetchImpl, calls } = router({ "/global/health": json({ healthy: false }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.health()).resolves.toEqual({ healthy: false });
    expect(calls).toEqual(["http://127.0.0.1:4096/global/health"]);
  });

  it("falls back to /api/project when v1 answers HTML (v2.0.20)", async () => {
    const project = [{ id: "proj_1", canonical: "/repo", time: {}, sandboxes: [] as string[] }];
    const { fetchImpl, calls } = router({
      "/global/health": new Response("<!doctype html><html></html>", {
        status: 200,
        headers: { "content-type": "text/html" }
      }),
      "/api/project": json(project)
    });
    const client = new OpencodeClient({
      baseUrl: "http://127.0.0.1:4096",
      username: "opencode",
      password: "secret",
      fetchImpl
    });
    await expect(client.health()).resolves.toEqual({ healthy: true });
    expect(calls).toEqual(["http://127.0.0.1:4096/global/health", "http://127.0.0.1:4096/api/project"]);
  });

  it("falls back to /api/project when v1 is 404 and accepts an empty project list", async () => {
    const { fetchImpl, calls } = router({ "/api/project": json([]) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.health()).resolves.toEqual({ healthy: true });
    expect(calls).toEqual(["http://127.0.0.1:4096/global/health", "http://127.0.0.1:4096/api/project"]);
  });

  it("sends Basic auth on the /api/project probe", async () => {
    const seen: Array<Record<string, string>> = [];
    const authFetch: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      if (path === "/global/health") return new Response("nope", { status: 404 });
      seen.push({ ...(init.headers as Record<string, string>) });
      return json([]);
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", username: "u", password: "p", fetchImpl: authFetch });
    await client.health();
    expect(seen[0]?.Authorization).toBe(`Basic ${Buffer.from("u:p").toString("base64")}`);
  });

  it("rejects HTML on /api/project", async () => {
    const { fetchImpl } = router({
      "/global/health": new Response("nope", { status: 404 }),
      "/api/project": new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.health()).rejects.toThrow(/invalid JSON/);
  });

  it("rejects malformed JSON on /api/project", async () => {
    const { fetchImpl } = router({
      "/global/health": new Response("nope", { status: 404 }),
      "/api/project": new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.health()).rejects.toThrow(/invalid JSON/);
  });

  it.each([401, 403])("rejects HTTP %i on /api/project", async (status) => {
    const { fetchImpl } = router({
      "/global/health": new Response("nope", { status: 404 }),
      "/api/project": new Response("denied", { status, statusText: "Denied" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.health()).rejects.toThrow(new RegExp(`failed: ${status}`));
  });

  it.each([
    ["scalar", json(true)],
    ["object-instead-of-array", json({ id: "proj_1" })],
    ["entry-without-id", json([{ name: "x" }])],
    ["entry-with-empty-id", json([{ id: "" }])]
  ])("rejects unexpected v2 shape: %s", async (_label, response) => {
    const { fetchImpl } = router({
      "/global/health": new Response("nope", { status: 404 }),
      "/api/project": response
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.health()).rejects.toThrow(/unexpected response/);
  });

  it("fails closed when both contracts are unreachable", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.health()).rejects.toThrow();
  });
});

describe("OpencodeClient createSession (v1/v2 contracts)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = (status = 200) =>
    new Response("<!doctype html><html></html>", { status, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  it("keeps the v1 contract: single POST /session, direct object", async () => {
    const { fetchImpl, calls } = router({ "/session": json({ id: "ses_1", title: "Title" }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("Title")).resolves.toEqual({ id: "ses_1", title: "Title" });
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ title: "Title" });
  });

  it("accepts legacy id aliases on the v1 shape", async () => {
    const { fetchImpl } = router({ "/session": json({ sessionID: "ses_abc123" }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession()).resolves.toEqual({ sessionID: "ses_abc123" });
  });

  it("falls back to POST /api/session on v1 404 and unwraps data (v2.0.20)", async () => {
    const v2session = { id: "ses_9f2c", title: "Hello", projectID: "proj_1" };
    const { fetchImpl, calls } = router({
      "/session": notFound(),
      "/api/session": json({ data: v2session })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("Hello")).resolves.toEqual(v2session);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session",
      "http://127.0.0.1:4096/api/session"
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ title: "Hello" });
  });

  it("falls back to POST /api/session on v1 405 (real OpenCode 2.0.20 answer)", async () => {
    const v2session = { id: "ses_405a", title: "Hello", projectID: "proj_1" };
    const { fetchImpl, calls } = router({
      "/session": new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        statusText: "Method Not Allowed",
        headers: { "content-type": "application/json" }
      }),
      "/api/session": json({ data: v2session })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("Hello")).resolves.toEqual(v2session);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session",
      "http://127.0.0.1:4096/api/session"
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ title: "Hello" });
  });

  it("falls back on 405 with a plain-text body (status is what matters)", async () => {
    const v2session = { id: "ses_405b", title: "T" };
    const { fetchImpl, calls } = router({
      "/session": new Response("Method Not Allowed", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session": json({ data: v2session })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).resolves.toEqual(v2session);
    expect(calls).toHaveLength(2);
  });

  it("never falls back on v1 401 (auth failure must surface, not mask)", async () => {
    const { fetchImpl, calls } = router({
      "/session": new Response("unauthorized", { status: 401, statusText: "Unauthorized" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).rejects.toThrow(/failed: 401/);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session"]);
  });

  it("never falls back on a v1 network failure (ambiguous: session may exist)", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push(String(url));
      if (new URL(String(url)).pathname === "/session") throw new TypeError("fetch failed");
      return json({ data: { id: "ses_dup" } });
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).rejects.toThrow(/fetch failed/);
    expect(calls).toEqual(["http://127.0.0.1:4096/session"]);
  });

  it("falls back on v1 HTML without duplicating (single POST per route)", async () => {
    const v2session = { id: "ses_html1", title: "T" };
    const { fetchImpl, calls } = router({ "/session": html(), "/api/session": json({ data: v2session }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).resolves.toEqual(v2session);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session",
      "http://127.0.0.1:4096/api/session"
    ]);
  });

  it("sends Basic auth on the v2 fallback", async () => {
    const { fetchImpl, calls } = router({
      "/session": notFound(),
      "/api/session": json({ data: { id: "ses_auth1" } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", username: "u", password: "p", fetchImpl });
    await client.createSession("T");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`
    );
  });

  it("never falls back on v1 500 (ambiguous: session may exist)", async () => {
    const { fetchImpl, calls } = router({ "/session": new Response("boom", { status: 500, statusText: "Boom" }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).rejects.toThrow(/failed: 500/);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session"]);
  });

  it("never retries a failing v2 POST (single attempt, no duplicates)", async () => {
    const { fetchImpl, calls } = router({
      "/session": notFound(),
      "/api/session": new Response("boom", { status: 503, statusText: "Unavailable" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).rejects.toThrow(/failed: 503/);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session",
      "http://127.0.0.1:4096/api/session"
    ]);
  });

  it("fails closed on v1 200 without a valid id (no second POST)", async () => {
    const { fetchImpl, calls } = router({ "/session": json({ title: "orphan?" }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).rejects.toThrow(/missing valid session id/);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session"]);
  });

  it.each([
    ["wrong-prefix", { id: "abc123" }],
    ["empty-id", { id: "" }],
    ["numeric-id", { id: 42 }],
    ["scalar", true],
    ["array", [{ id: "ses_x" }]]
  ])("rejects unexpected v1 shape: %s (no fallback POST)", async (_label, payload) => {
    const { fetchImpl, calls } = router({ "/session": json(payload) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).rejects.toThrow(/missing valid session id/);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ["html", html()],
    ["malformed-json", new Response("{not-json", { status: 200, headers: { "content-type": "application/json" } })],
    ["missing-data-id", json({ data: { title: "no id" } })],
    ["bad-data-id", json({ data: { id: "xyz" } })],
    ["scalar", json("ses_ok")]
  ])("rejects invalid v2 response: %s", async (_label, response) => {
    const { fetchImpl } = router({ "/session": notFound(), "/api/session": response });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).rejects.toThrow();
  });

  it.each([401, 403])("rejects HTTP %i on the v2 route", async (status) => {
    const { fetchImpl } = router({
      "/session": notFound(),
      "/api/session": new Response("denied", { status, statusText: "Denied" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.createSession("T")).rejects.toThrow(new RegExp(`failed: ${status}`));
  });
});

describe("OpencodeClient listSessions/getSession (v1/v2 contracts)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push(String(url));
      void init;
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  it("keeps the v1 list contract: direct array, no /api call", async () => {
    const sessions = [{ id: "ses_a1", title: "A" }, { id: "ses_b2", title: "B" }];
    const { fetchImpl, calls } = router({ "/session": json(sessions) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listSessions()).resolves.toEqual(sessions);
    expect(calls).toEqual(["http://127.0.0.1:4096/session"]);
  });

  it("accepts an empty v1 list", async () => {
    const { fetchImpl } = router({ "/session": json([]) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listSessions()).resolves.toEqual([]);
  });

  it("falls back to GET /api/session on v1 HTML and unwraps data", async () => {
    const sessions = [{ id: "ses_a1" }, { id: "ses_b2" }];
    const { fetchImpl, calls } = router({
      "/session": html(),
      "/api/session": json({ data: sessions, cursor: { previous: null, next: null } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listSessions()).resolves.toEqual(sessions);
    expect(calls).toEqual(["http://127.0.0.1:4096/session", "http://127.0.0.1:4096/api/session"]);
  });

  it("falls back to GET /api/session on v1 404 and accepts an empty page", async () => {
    const { fetchImpl, calls } = router({ "/api/session": json({ data: [], cursor: {} }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listSessions()).resolves.toEqual([]);
    expect(calls).toEqual(["http://127.0.0.1:4096/session", "http://127.0.0.1:4096/api/session"]);
  });

  it("keeps foreign-project entries untouched (callers match by id)", async () => {
    const sessions = [{ id: "ses_mine" }, { id: "ses_other" }];
    const { fetchImpl } = router({ "/session": json(sessions) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    // No filtering/merging inside the client: bridge store owns managed sessions.
    await expect(client.listSessions()).resolves.toEqual(sessions);
  });

  it.each([
    ["scalar", json(true)],
    ["object-without-data", json({ id: "ses_a1" })],
    ["data-not-array", json({ data: { id: "ses_a1" } })],
    ["entry-without-id", json([{ id: "ses_a1" }, { title: "no id" }])],
    ["entry-with-bad-id", json([{ id: "xyz" }])]
  ])("rejects unexpected v1 list shape: %s (no fallback)", async (_label, response) => {
    const { fetchImpl, calls } = router({ "/session": response });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listSessions()).rejects.toThrow(/unexpected response/);
    expect(calls).toEqual(["http://127.0.0.1:4096/session"]);
  });

  it.each([
    ["html", html()],
    ["missing-data", json({ cursor: {} })],
    ["entry-without-id", json({ data: [{ title: "x" }] })]
  ])("rejects unexpected v2 list shape: %s", async (_label, response) => {
    const { fetchImpl } = router({ "/session": html(), "/api/session": response });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listSessions()).rejects.toThrow();
  });

  it("never converts a v1 401 on list into success", async () => {
    const { fetchImpl, calls } = router({
      "/session": new Response("denied", { status: 401, statusText: "Unauthorized" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listSessions()).rejects.toThrow(/failed: 401/);
    expect(calls).toEqual(["http://127.0.0.1:4096/session"]);
  });

  it("keeps the v1 get contract: direct object, single GET", async () => {
    const session = { id: "ses_a1", title: "A" };
    const { fetchImpl, calls } = router({ "/session/ses_a1": json(session) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSession("ses_a1")).resolves.toEqual(session);
    expect(calls).toEqual(["http://127.0.0.1:4096/session/ses_a1"]);
  });

  it("falls back to GET /api/session/:id on v1 HTML and unwraps data", async () => {
    const session = { id: "ses_a1", title: "A" };
    const { fetchImpl, calls } = router({
      "/session/ses_a1": html(),
      "/api/session/ses_a1": json({ data: session })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSession("ses_a1")).resolves.toEqual(session);
    expect(calls).toEqual(["http://127.0.0.1:4096/session/ses_a1", "http://127.0.0.1:4096/api/session/ses_a1"]);
  });

  it("preserves 404 semantics when the session exists on neither route", async () => {
    const { fetchImpl, calls } = router({
      "/api/session/ses_missing": new Response("gone", { status: 404, statusText: "Not Found" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSession("ses_missing")).rejects.toThrow(/failed: 404/);
    expect(calls).toEqual([
      "http://127.0.0.1:4096/session/ses_missing",
      "http://127.0.0.1:4096/api/session/ses_missing"
    ]);
  });

  it("rejects a v2 answer for a different session id (no mixing)", async () => {
    const { fetchImpl } = router({
      "/session/ses_a1": html(),
      "/api/session/ses_a1": json({ data: { id: "ses_other", title: "foreign" } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSession("ses_a1")).rejects.toThrow(/missing session ses_a1/);
  });

  it.each([
    ["no-id", json({ title: "x" })],
    ["bad-id", json({ id: "abc" })],
    ["scalar", json("ses_a1")]
  ])("rejects unexpected v1 get shape: %s (no fallback)", async (_label, response) => {
    const { fetchImpl, calls } = router({ "/session/ses_a1": response });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSession("ses_a1")).rejects.toThrow(/unexpected response/);
    expect(calls).toEqual(["http://127.0.0.1:4096/session/ses_a1"]);
  });

  it.each([401, 403])("never converts v1 HTTP %i on get into success", async (status) => {
    const { fetchImpl, calls } = router({
      "/session/ses_a1": new Response("denied", { status, statusText: "Denied" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSession("ses_a1")).rejects.toThrow(new RegExp(`failed: ${status}`));
    expect(calls).toEqual(["http://127.0.0.1:4096/session/ses_a1"]);
  });
});

describe("OpencodeClient getMessages/getMessageIfExists (v1/v2 contracts)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });
  const tagged404 = (tag: string, extra: Record<string, unknown> = {}) =>
    new Response(JSON.stringify({ _tag: tag, ...extra }), { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  const v1user = { info: { role: "user", time: { created: 1000 } }, parts: [{ type: "text", text: "hi" }] };

  it("keeps the v1 list contract: passthrough, limit forwarded, no /api call", async () => {
    const { fetchImpl, calls } = router({ "/session/ses_a/message": json([v1user]) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessages("ses_a", 10)).resolves.toEqual([v1user]);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_a/message?limit=10"]);
  });

  it("accepts an empty v1 list", async () => {
    const { fetchImpl } = router({ "/session/ses_a/message": json([]) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessages("ses_a")).resolves.toEqual([]);
  });

  it("falls back on v1 HTML and normalizes user/assistant/textless items", async () => {
    const v2 = {
      data: [
        { id: "msg_u1", time: { created: 1000 }, text: "hi", type: "user" },
        {
          id: "msg_a1",
          time: { created: 1001, completed: 1002 },
          type: "assistant",
          agent: "build",
          content: [
            { type: "text", text: "done" },
            { type: "reasoning", text: "thinking" },
            { type: "tool", id: "call_1", name: "read", state: { status: "completed" } }
          ],
          error: { type: "ProviderError", message: "boom" }
        },
        { id: "msg_s1", time: { created: 1003 }, type: "synthetic", text: "note" },
        { id: "msg_i1", time: { created: 1004 }, type: "idle", outcome: "succeeded" }
      ],
      cursor: { previous: null, next: null }
    };
    const { fetchImpl, calls } = router({ "/session/ses_a/message": html(), "/api/session/ses_a/message": json(v2) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const messages = await client.getMessages("ses_a", 10);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_a/message?limit=10",
      "http://127.0.0.1:4096/api/session/ses_a/message?limit=10"
    ]);
    expect(messages[0]).toEqual({
      info: { id: "msg_u1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "hi" }]
    });
    expect(messages[1]).toEqual({
      info: {
        id: "msg_a1",
        role: "assistant",
        time: { created: 1001, completed: 1002 },
        error: { name: "ProviderError", message: "boom" },
        agent: "build"
      },
      parts: [
        { type: "text", text: "done" },
        { type: "reasoning", text: "thinking" },
        { type: "tool", id: "call_1", name: "read", state: { status: "completed" } }
      ]
    });
    expect(messages[2]?.parts).toEqual([{ type: "text", text: "note" }]);
    // No text/content anywhere: empty parts, nothing invented.
    expect(messages[3]).toEqual({
      info: { id: "msg_i1", role: "idle", time: { created: 1004 } },
      parts: []
    });
  });

  it("accepts an empty v2 page", async () => {
    const { fetchImpl } = router({
      "/session/ses_a/message": html(),
      "/api/session/ses_a/message": json({ data: [], cursor: { previous: null, next: null } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessages("ses_a")).resolves.toEqual([]);
  });

  it("sends Basic auth on the v2 message fallback", async () => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/message": html(),
      "/api/session/ses_a/message": json({ data: [] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", username: "u", password: "p", fetchImpl });
    await client.getMessages("ses_a");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`
    );
  });

  it.each([
    ["scalar", json(true)],
    ["object-without-data", json({ id: "msg_x1" })],
    ["data-not-array", json({ data: {} })],
    ["item-without-id", json({ data: [{ type: "user", time: { created: 1 }, text: "x" }] })],
    ["item-with-bad-id", json({ data: [{ id: "bad", type: "user", time: { created: 1 } }] })],
    ["item-without-time", json({ data: [{ id: "msg_x1", type: "user", text: "x" }] })],
    ["item-without-type", json({ data: [{ id: "msg_x1", time: { created: 1 } }] })],
    ["item-with-bad-content", json({ data: [{ id: "msg_x1", type: "assistant", time: { created: 1 }, content: [{ type: "text" }] }] })]
  ])("rejects unexpected v2 list shape: %s", async (_label, response) => {
    const { fetchImpl } = router({ "/session/ses_a/message": html(), "/api/session/ses_a/message": response });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessages("ses_a")).rejects.toThrow(/unexpected response/);
  });

  it.each([401, 500])("never falls back on v1 HTTP %i for list (no masking, no /api read)", async (status) => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/message": new Response("denied", { status, statusText: "Err" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessages("ses_a")).rejects.toThrow(new RegExp(`failed: ${status}`));
    // 500 is retried on the same v1 URL (bounded GET retries); 401 is not.
    // Either way the v2 route is never touched.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === "http://127.0.0.1:4096/session/ses_a/message")).toBe(true);
  });

  it("keeps the v1 single-message contract: passthrough object", async () => {
    const { fetchImpl, calls } = router({ "/session/ses_a/message/msg_x1": json(v1user) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessageIfExists("ses_a", "msg_x1")).resolves.toEqual(v1user);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_a/message/msg_x1"]);
  });

  it("maps v1 404 + v2 MessageNotFound to null", async () => {
    const { fetchImpl, calls } = router({
      "/api/session/ses_a/message/msg_x1": tagged404("MessageNotFoundError", { messageID: "msg_x1" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessageIfExists("ses_a", "msg_x1")).resolves.toBeNull();
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_a/message/msg_x1",
      "http://127.0.0.1:4096/api/session/ses_a/message/msg_x1"
    ]);
  });

  it("maps v1 404 + untagged v2 404 to null (v1-server compatibility)", async () => {
    const { fetchImpl } = router({});
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessageIfExists("ses_a", "msg_x1")).resolves.toBeNull();
  });

  it("throws (not null) when the session itself is gone", async () => {
    const { fetchImpl } = router({
      "/api/session/ses_a/message/msg_x1": tagged404("SessionNotFoundError", { sessionID: "ses_a" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessageIfExists("ses_a", "msg_x1")).rejects.toThrow(/session not found: ses_a/);
  });

  it("falls back on v1 HTML and returns the normalized message on id match", async () => {
    const { fetchImpl } = router({
      "/session/ses_a/message/msg_x1": html(),
      "/api/session/ses_a/message/msg_x1": json({
        data: { id: "msg_x1", time: { created: 1000 }, text: "hi", type: "user" }
      })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessageIfExists("ses_a", "msg_x1")).resolves.toEqual({
      info: { id: "msg_x1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "hi" }]
    });
  });

  it("rejects a v2 single answer with a different id", async () => {
    const { fetchImpl } = router({
      "/session/ses_a/message/msg_x1": html(),
      "/api/session/ses_a/message/msg_x1": json({ data: { id: "msg_other", time: { created: 1 }, type: "user" } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessageIfExists("ses_a", "msg_x1")).rejects.toThrow(/missing message msg_x1/);
  });

  it.each([401, 500])("never falls back on v1 HTTP %i for single read", async (status) => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/message/msg_x1": new Response("denied", { status, statusText: "Err" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessageIfExists("ses_a", "msg_x1")).rejects.toThrow(new RegExp(`failed: ${status}`));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === "http://127.0.0.1:4096/session/ses_a/message/msg_x1")).toBe(true);
  });

  it("never falls back on a v1 network failure for single read", async () => {    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      throw new TypeError("fetch failed");
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getMessageIfExists("ses_a", "msg_x1")).rejects.toThrow(/fetch failed/);
    // Transient network faults retry the same v1 URL (bounded); /api is never touched.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((url) => url === "http://127.0.0.1:4096/session/ses_a/message/msg_x1")).toBe(true);
  });
});

describe("OpencodeClient getSessionStatus (v1/v2 supervision)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  it("keeps the v1 contract: direct map, no /api call", async () => {
    const statuses = { ses_a: { type: "busy" }, ses_b: { type: "idle" } };
    const { fetchImpl, calls } = router({ "/session/status": json(statuses) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSessionStatus()).resolves.toEqual(statuses);
    expect(calls).toEqual(["http://127.0.0.1:4096/session/status"]);
  });

  it("accepts an empty v1 map without fallback", async () => {
    const { fetchImpl, calls } = router({ "/session/status": json({}) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSessionStatus()).resolves.toEqual({});
    expect(calls).toEqual(["http://127.0.0.1:4096/session/status"]);
  });

  it("falls back on v1 HTML and maps confirmed running to busy", async () => {
    const { fetchImpl, calls } = router({
      "/session/status": html(),
      "/api/session/active": json({ data: { ses_a: { type: "running" }, ses_b: { type: "running" } } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSessionStatus()).resolves.toEqual({
      ses_a: { type: "busy" },
      ses_b: { type: "busy" }
    });
    expect(calls).toEqual(["http://127.0.0.1:4096/session/status", "http://127.0.0.1:4096/api/session/active"]);
  });

  it("falls back on v1 404 and keeps absence as absence (never idle)", async () => {
    const { fetchImpl, calls } = router({ "/api/session/active": json({ data: {} }) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    // No idle synthesis: callers keep the legacy absent=>unknown/idle contract.
    await expect(client.getSessionStatus()).resolves.toEqual({});
    expect(calls).toEqual(["http://127.0.0.1:4096/session/status", "http://127.0.0.1:4096/api/session/active"]);
  });

  it("omits idle sessions instead of claiming their state", async () => {
    const { fetchImpl } = router({
      "/session/status": html(),
      "/api/session/active": json({ data: { ses_busy: { type: "running" } } })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const statuses = await client.getSessionStatus();
    expect(statuses).toEqual({ ses_busy: { type: "busy" } });
    expect("ses_idle" in statuses).toBe(false);
  });

  it("sends Basic auth on the v2 fallback", async () => {
    const seen: string[] = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      if (new URL(String(url)).pathname === "/session/status") return html();
      seen.push((init.headers as Record<string, string>).Authorization ?? "");
      return json({ data: {} });
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", username: "u", password: "p", fetchImpl });
    await client.getSessionStatus();
    expect(seen).toEqual([`Basic ${Buffer.from("u:p").toString("base64")}`]);
  });

  it.each([
    ["scalar", json(true)],
    ["array", json([])],
    ["data-not-object", json({ data: [] })],
    ["data-missing", json({ cursor: {} })],
    ["bad-key", json({ data: { nope: { type: "running" } } })],
    ["non-object-entry", json({ data: { ses_a: "running" } })],
    ["unknown-state", json({ data: { ses_a: { type: "paused" } } })]
  ])("rejects unexpected v2 shape: %s", async (_label, response) => {
    const { fetchImpl } = router({ "/session/status": html(), "/api/session/active": response });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSessionStatus()).rejects.toThrow(/unexpected response/);
  });

  it("rejects unexpected v1 shapes without fallback", async () => {
    const { fetchImpl, calls } = router({ "/session/status": json([{ ses_a: { type: "busy" } }]) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    // v1 passthrough preserved: arrays flow to callers that index by id (=> undefined => idle),
    // exactly as before this checkpoint. No silent rewrite, no extra call.
    await expect(client.getSessionStatus()).resolves.toEqual([{ ses_a: { type: "busy" } }]);
    expect(calls).toEqual(["http://127.0.0.1:4096/session/status"]);
  });

  it.each([401, 403])("never converts v1 HTTP %i into success", async (status) => {
    const { fetchImpl, calls } = router({
      "/session/status": new Response("denied", { status, statusText: "Denied" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSessionStatus()).rejects.toThrow(new RegExp(`failed: ${status}`));
    expect(calls.every((url) => url === "http://127.0.0.1:4096/session/status")).toBe(true);
  });

  it("surfaces v2 401 instead of masking it", async () => {
    const { fetchImpl } = router({
      "/session/status": html(),
      "/api/session/active": new Response("denied", { status: 401, statusText: "Unauthorized" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSessionStatus()).rejects.toThrow(/failed: 401/);
  });

  it("never falls back on a v1 network failure", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      throw new TypeError("fetch failed");
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.getSessionStatus()).rejects.toThrow(/fetch failed/);
    expect(calls.every((url) => url === "http://127.0.0.1:4096/session/status")).toBe(true);
  });
});

describe("OpencodeClient listPermissions (v1/v2 session isolation)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  const V1_MIXED = [
    { id: "per_1", sessionID: "ses_a", permission: "read", tool: { messageID: "msg_1", callID: "call_1" } },
    { id: "per_2", sessionID: "ses_other", permission: "write" }
  ];

  it("keeps the v1 contract: server-wide passthrough, callers keep filtering", async () => {
    const { fetchImpl, calls } = router({ "/permission": json(V1_MIXED) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    // sessionId accepted but unused on the v1 route; all records flow to the caller filter.
    await expect(client.listPermissions("ses_a")).resolves.toEqual(V1_MIXED);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/permission"]);
  });

  it("accepts an empty v1 list as confirmed zero", async () => {
    const { fetchImpl } = router({ "/permission": json([]) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions("ses_a")).resolves.toEqual([]);
  });

  it("falls back to the session-scoped v2 route on HTML-200 and normalizes source", async () => {
    const { fetchImpl, calls } = router({
      "/permission": html(),
      "/api/session/ses_a/permission": json({
        data: [
          {
            id: "per_9",
            sessionID: "ses_a",
            action: "read",
            resources: ["fs"],
            save: ["project"],
            message: "allow?",
            metadata: { k: "v" },
            source: { type: "tool", messageID: "msg_9", id: "call_9" }
          },
          { id: "per_10", sessionID: "ses_a", action: "edit", resources: [] }
        ]
      })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions("ses_a")).resolves.toEqual([
      {
        id: "per_9",
        sessionID: "ses_a",
        action: "read",
        resources: ["fs"],
        save: ["project"],
        message: "allow?",
        metadata: { k: "v" },
        source: { type: "tool", messageID: "msg_9", id: "call_9" },
        tool: { messageID: "msg_9" }
      },
      { id: "per_10", sessionID: "ses_a", action: "edit", resources: [] }
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/permission",
      "http://127.0.0.1:4096/api/session/ses_a/permission"
    ]);
    expect(calls.some((c) => c.url.includes("/api/permission/request"))).toBe(false);
  });

  it.each([404, 405])("falls back on v1 HTTP %i", async (status) => {
    const { fetchImpl, calls } = router({
      "/permission": new Response("gone", { status, statusText: "Gone" }),
      "/api/session/ses_a/permission": json({ data: [] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions("ses_a")).resolves.toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/permission",
      "http://127.0.0.1:4096/api/session/ses_a/permission"
    ]);
  });

  it("accepts an empty v2 page as confirmed zero", async () => {
    const { fetchImpl } = router({
      "/permission": html(),
      "/api/session/ses_a/permission": json({ data: [] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions("ses_a")).resolves.toEqual([]);
  });

  it("throws without a session id instead of using the global v2 route", async () => {
    const { fetchImpl, calls } = router({
      "/permission": html(),
      "/api/permission/request": json({ location: {}, data: [{ id: "per_x", sessionID: "ses_a" }] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions()).rejects.toThrow(/no session id/);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/permission"]);
  });

  it.each([
    ["missing-id", { data: [{ sessionID: "ses_a" }] }],
    ["empty-id", { data: [{ id: "", sessionID: "ses_a" }] }],
    ["foreign-session", { data: [{ id: "per_x", sessionID: "ses_other" }] }],
    ["missing-session", { data: [{ id: "per_x" }] }],
    ["scalar", json(true)],
    ["no-envelope", json([{ id: "per_x", sessionID: "ses_a" }])],
    ["data-not-array", json({ data: {} })],
    ["bad-resources", { data: [{ id: "per_x", sessionID: "ses_a", resources: "fs" }] }],
    ["bad-source", { data: [{ id: "per_x", sessionID: "ses_a", source: "tool" }] }]
  ])("rejects unexpected v2 shape: %s (never mixed, never empty)", async (_label, payload) => {
    const response = payload instanceof Response ? payload : json(payload);
    const { fetchImpl } = router({ "/permission": html(), "/api/session/ses_a/permission": response });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions("ses_a")).rejects.toThrow(/unexpected response/);
  });

  it("leaves records without tool linkage actionable-safe (no tool invented)", async () => {
    const { fetchImpl } = router({
      "/permission": html(),
      "/api/session/ses_a/permission": json({
        data: [
          { id: "per_nosrc", sessionID: "ses_a", action: "read", resources: [] },
          { id: "per_other", sessionID: "ses_a", action: "read", resources: [], source: { type: "other", id: "x" } }
        ]
      })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const records = await client.listPermissions("ses_a");
    expect(records.map((r) => r.tool)).toEqual([undefined, undefined]);
  });

  it("sends Basic auth on the v2 fallback", async () => {
    const { fetchImpl, calls } = router({
      "/permission": html(),
      "/api/session/ses_a/permission": json({ data: [] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", username: "u", password: "p", fetchImpl });
    await client.listPermissions("ses_a");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`
    );
  });

  it.each([401, 403, 500])("never converts v1 HTTP %i into an empty list", async (status) => {
    const { fetchImpl, calls } = router({
      "/permission": new Response("denied", { status, statusText: "Denied" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions("ses_a")).rejects.toThrow(new RegExp(`failed: ${status}`));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === "http://127.0.0.1:4096/permission")).toBe(true);
  });

  it("surfaces v2 401 instead of an empty list", async () => {
    const { fetchImpl } = router({
      "/permission": html(),
      "/api/session/ses_a/permission": new Response("denied", { status: 401, statusText: "Unauthorized" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions("ses_a")).rejects.toThrow(/failed: 401/);
  });

  it("never falls back on a v1 network failure", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      throw new TypeError("fetch failed");
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listPermissions("ses_a")).rejects.toThrow(/fetch failed/);
    expect(calls.every((url) => url === "http://127.0.0.1:4096/permission")).toBe(true);
  });
});

describe("OpencodeClient listQuestions/forms (v1/v2 session isolation)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  const V1_MIXED = [
    { id: "quest_1", sessionID: "ses_a", questions: [{ question: "Which?", options: [{ label: "a" }] }] },
    { id: "quest_2", sessionID: "ses_other", questions: [{ question: "Other?" }] }
  ];

  it("keeps the v1 contract: server-wide passthrough, callers keep filtering", async () => {
    const { fetchImpl, calls } = router({ "/question": json(V1_MIXED) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).resolves.toEqual(V1_MIXED);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/question"]);
  });

  it("accepts an empty v1 list as confirmed zero", async () => {
    const { fetchImpl } = router({ "/question": json([]) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).resolves.toEqual([]);
  });

  it("falls back to the session-scoped v2 route on HTML-200 and preserves fields verbatim", async () => {
    const fields = [
      { type: "string", key: "color", label: "color", required: true, extra: { nested: [1, 2] } },
      { type: "number", key: "count", label: "count" },
      { type: "boolean", key: "ok", label: "ok" },
      { type: "multiselect", key: "tags", label: "tags", options: [{ label: "x", value: "x" }] }
    ];
    const { fetchImpl, calls } = router({
      "/question": html(),
      "/api/session/ses_a/form": json({
        data: [
          { id: "frm_1", sessionID: "ses_a", title: "Pick", fields, metadata: { origin: "lab" } },
          { id: "frm_2", sessionID: "ses_a", title: "Bare", fields: [] }
        ]
      })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).resolves.toEqual([
      { id: "frm_1", sessionID: "ses_a", title: "Pick", fields, metadata: { origin: "lab" } },
      { id: "frm_2", sessionID: "ses_a", title: "Bare", fields: [] }
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/question",
      "http://127.0.0.1:4096/api/session/ses_a/form"
    ]);
    expect(calls.some((c) => new URL(c.url).pathname === "/api/form")).toBe(false);
  });

  it("never invents v1 questions from v2 fields", async () => {
    const { fetchImpl } = router({
      "/question": html(),
      "/api/session/ses_a/form": json({
        data: [{ id: "frm_1", sessionID: "ses_a", title: "Pick", fields: [{ type: "boolean", key: "ok" }] }]
      })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const records = await client.listQuestions("ses_a");
    expect(records[0]).not.toHaveProperty("questions");
    expect(records[0]).not.toHaveProperty("tool");
  });

  it.each([404, 405])("falls back on v1 HTTP %i", async (status) => {
    const { fetchImpl, calls } = router({
      "/question": new Response("gone", { status, statusText: "Gone" }),
      "/api/session/ses_a/form": json({ data: [] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).resolves.toEqual([]);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/question",
      "http://127.0.0.1:4096/api/session/ses_a/form"
    ]);
  });

  it("accepts an empty v2 page as confirmed zero", async () => {
    const { fetchImpl } = router({
      "/question": html(),
      "/api/session/ses_a/form": json({ data: [] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).resolves.toEqual([]);
  });

  it("throws without a session id instead of using the global v2 route", async () => {
    const { fetchImpl, calls } = router({
      "/question": html(),
      "/api/form": json({ location: {}, data: [{ id: "frm_x", sessionID: "ses_a" }] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions()).rejects.toThrow(/no session id/);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/question"]);
  });

  it.each([
    ["missing-id", { data: [{ sessionID: "ses_a", title: "T", fields: [] }] }],
    ["empty-id", { data: [{ id: "", sessionID: "ses_a", title: "T", fields: [] }] }],
    ["foreign-session", { data: [{ id: "frm_x", sessionID: "ses_other", title: "T", fields: [] }] }],
    ["missing-session", { data: [{ id: "frm_x", title: "T", fields: [] }] }],
    ["missing-title", { data: [{ id: "frm_x", sessionID: "ses_a", fields: [] }] }],
    ["missing-fields", { data: [{ id: "frm_x", sessionID: "ses_a", title: "T" }] }],
    ["fields-not-array", { data: [{ id: "frm_x", sessionID: "ses_a", title: "T", fields: {} }] }],
    ["field-not-object", { data: [{ id: "frm_x", sessionID: "ses_a", title: "T", fields: ["color"] }] }],
    ["bad-metadata", { data: [{ id: "frm_x", sessionID: "ses_a", title: "T", fields: [], metadata: "lab" }] }],
    ["scalar", json(true)],
    ["no-envelope", json([{ id: "frm_x", sessionID: "ses_a", title: "T", fields: [] }])],
    ["data-not-array", json({ data: {} })]
  ])("rejects unexpected v2 shape: %s (never mixed, never empty)", async (_label, payload) => {
    const response = payload instanceof Response ? payload : json(payload);
    const { fetchImpl } = router({ "/question": html(), "/api/session/ses_a/form": response });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).rejects.toThrow(/unexpected response/);
  });

  it("sends Basic auth on the v2 fallback", async () => {
    const { fetchImpl, calls } = router({
      "/question": html(),
      "/api/session/ses_a/form": json({ data: [] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", username: "u", password: "p", fetchImpl });
    await client.listQuestions("ses_a");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`
    );
  });

  it.each([401, 403, 500])("never converts v1 HTTP %i into an empty list", async (status) => {
    const { fetchImpl, calls } = router({
      "/question": new Response("denied", { status, statusText: "Denied" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).rejects.toThrow(new RegExp(`failed: ${status}`));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.url === "http://127.0.0.1:4096/question")).toBe(true);
  });

  it("surfaces v2 401 instead of an empty list", async () => {
    const { fetchImpl } = router({
      "/question": html(),
      "/api/session/ses_a/form": new Response("denied", { status: 401, statusText: "Unauthorized" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).rejects.toThrow(/failed: 401/);
  });

  it("never falls back on a v1 network failure", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      throw new TypeError("fetch failed");
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.listQuestions("ses_a")).rejects.toThrow(/fetch failed/);
    expect(calls.every((url) => url === "http://127.0.0.1:4096/question")).toBe(true);
  });
});

describe("OpencodeClient sendMessage (v1/v2 prompt compatibility)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  const V1_MESSAGE = { info: { id: "msg_1", role: "assistant" }, parts: [{ type: "text", text: "hi" }] };
  const V2_RECEIPT = { data: { id: "msg_x1", sessionID: "ses_a", time: { created: 1000 }, type: "user" } };

  it("keeps the v1 sync contract: full body, message returned, single POST", async () => {
    const { fetchImpl, calls } = router({ "/session/ses_a/message": json(V1_MESSAGE) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(
      client.sendMessage({ sessionId: "ses_a", text: "hi", providerID: "p", modelID: "m", agent: "a", system: "s", tools: { t: true } })
    ).resolves.toEqual(V1_MESSAGE);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_a/message"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      model: { providerID: "p", modelID: "m" },
      agent: "a",
      system: "s",
      tools: { t: true },
      parts: [{ type: "text", text: "hi" }]
    });
  });

  it("falls back on v1 405, preserves the id, and returns acceptance without fabrication", async () => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/prompt_async": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/ses_a/prompt": json(V2_RECEIPT)
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    // async:false would still try the v1 sync route first; the 405 proves v2.
    await expect(
      client.sendMessage({ sessionId: "ses_a", text: "hi", messageID: "msg_x1", async: true })
    ).resolves.toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_a/prompt_async",
      "http://127.0.0.1:4096/api/session/ses_a/prompt"
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ id: "msg_x1", text: "hi" });
  });

  it("falls back on v1 HTML-200", async () => {
    const { fetchImpl, calls } = router({ "/session/ses_a/message": html(), "/api/session/ses_a/prompt": json(V2_RECEIPT) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.sendMessage({ sessionId: "ses_a", text: "hi" })).resolves.toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_a/message",
      "http://127.0.0.1:4096/api/session/ses_a/prompt"
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ text: "hi" });
  });

  it("never falls back on v1 404 (missing session on both generations)", async () => {
    const { fetchImpl, calls } = router({});
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.sendMessage({ sessionId: "ses_gone", text: "hi" })).rejects.toThrow(/failed: 404/);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_gone/message"]);
  });

  it.each([
    ["model", { providerID: "p", modelID: "m" }],
    ["agent", { agent: "a" }],
    ["system", { system: "s" }],
    ["tools", { tools: { t: true } }],
    ["noReply", { noReply: true }],
    ["sync", { async: false }],
    ["bad-id", { messageID: "nope" }]
  ])("rejects incompatible option on v2 without silently dropping it: %s", async (_label, extra) => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/message": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/ses_a/prompt": json(V2_RECEIPT)
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.sendMessage({ sessionId: "ses_a", text: "hi", ...extra })).rejects.toThrow(/incompatible/);
    // The v2 route is never posted when options cannot be translated.
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_a/message"]);
  });

  it("keeps v1-only options working on v1 (no validation there)", async () => {
    const { fetchImpl } = router({ "/session/ses_a/message": json(V1_MESSAGE) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(
      client.sendMessage({ sessionId: "ses_a", text: "hi", agent: "a", async: false })
    ).resolves.toEqual(V1_MESSAGE);
  });

  it.each([
    ["scalar", json(true)],
    ["missing-data", json({ cursor: {} })],
    ["data-without-id", json({ data: { sessionID: "ses_a" } })]
  ])("rejects malformed v2 receipts: %s", async (_label, response) => {
    const { fetchImpl } = router({
      "/session/ses_a/message": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/ses_a/prompt": response
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.sendMessage({ sessionId: "ses_a", text: "hi" })).rejects.toThrow(/unexpected response/);
  });

  it("resolves a 409 by read-back: found means duplicate, single POST per route", async () => {
    const raw = { id: "msg_x1", time: { created: 1000 }, text: "hi", type: "user" };
    const normalized = {
      info: { id: "msg_x1", role: "user", time: { created: 1000 } },
      parts: [{ type: "text", text: "hi" }]
    };
    const { fetchImpl, calls } = router({
      "/session/ses_a/message": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/ses_a/prompt": new Response("taken", { status: 409, statusText: "Conflict" }),
      "/api/session/ses_a/message/msg_x1": json({ data: raw })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const failure = await client.sendMessage({ sessionId: "ses_a", text: "hi", messageID: "msg_x1" }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(DuplicatePromptError);
    expect((failure as DuplicatePromptError).existing).toEqual(normalized);
    // One POST per route; the read-back itself walks v1-then-v2 like any other read.
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_a/message",
      "http://127.0.0.1:4096/api/session/ses_a/prompt",
      "http://127.0.0.1:4096/session/ses_a/message/msg_x1",
      "http://127.0.0.1:4096/api/session/ses_a/message/msg_x1"
    ]);
  });

  it("turns an unverifiable 409 into indeterminate, never success", async () => {
    const { fetchImpl } = router({
      "/session/ses_a/message": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/ses_a/prompt": new Response("taken", { status: 409, statusText: "Conflict" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    // Router defaults unknown paths to 404: the message lookup misses.
    const failure = await client.sendMessage({ sessionId: "ses_a", text: "hi", messageID: "msg_x1" }).then(
      () => null,
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(IndeterminateSendError);
    expect(String((failure as Error).message)).toMatch(/reconcile with the same message id/);
  });

  it("marks ambiguous transport outcomes indeterminate, definitive ones plain", async () => {
    const netFail: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const denied: typeof fetch = async () => new Response("no", { status: 401, statusText: "Unauthorized" });
    const busy: typeof fetch = async () => new Response("no", { status: 503, statusText: "Unavailable" });

    const net = await new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl: netFail })
      .sendMessage({ sessionId: "ses_a", text: "hi", messageID: "msg_x1" }).then(() => null, (e: unknown) => e);
    expect(net).toBeInstanceOf(IndeterminateSendError);
    expect(String((net as Error).message)).toMatch(/fetch failed/);

    const auth = await new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl: denied })
      .sendMessage({ sessionId: "ses_a", text: "hi" }).then(() => null, (e: unknown) => e);
    expect(auth).not.toBeInstanceOf(IndeterminateSendError);
    expect(String((auth as Error).message)).toMatch(/failed: 401/);

    const down = await new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl: busy })
      .sendMessage({ sessionId: "ses_a", text: "hi", messageID: "msg_x1" }).then(() => null, (e: unknown) => e);
    expect(down).toBeInstanceOf(IndeterminateSendError);
    expect(String((down as Error).message)).toMatch(/failed: 503/);
  });

  it("never retries POSTs: one attempt per route", async () => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/message": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/ses_a/prompt": new Response("down", { status: 503, statusText: "Unavailable" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.sendMessage({ sessionId: "ses_a", text: "hi" })).rejects.toThrow(IndeterminateSendError);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_a/message",
      "http://127.0.0.1:4096/api/session/ses_a/prompt"
    ]);
  });

  it("keeps session isolation and auth on the v2 route", async () => {
    const { fetchImpl, calls } = router({
      "/session/a%20b/message": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/a%20b/prompt": json(V2_RECEIPT)
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", username: "u", password: "p", fetchImpl });
    await client.sendMessage({ sessionId: "a b", text: "hi" });
    expect(calls[1]?.url).toBe("http://127.0.0.1:4096/api/session/a%20b/prompt");
    expect((calls[1]?.init.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`
    );
  });
});

describe("OpencodeClient abortSession (v1/v2 interrupt)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  it("keeps the v1 contract: boolean passthrough, single POST", async () => {
    const { fetchImpl, calls } = router({ "/session/ses_a/abort": json(true) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.abortSession("ses_a")).resolves.toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_a/abort"]);
    expect(calls[0]?.init.method).toBe("POST");
  });

  it("falls back on v1 405 and returns the effective flag", async () => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/abort": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/ses_a/interrupt": json({ interrupted: true })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.abortSession("ses_a")).resolves.toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_a/abort",
      "http://127.0.0.1:4096/api/session/ses_a/interrupt"
    ]);
  });

  it("returns interrupted:false as-is, never as an effective interruption", async () => {
    const { fetchImpl } = router({
      "/session/ses_a/abort": html(),
      "/api/session/ses_a/interrupt": json({ interrupted: false })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.abortSession("ses_a")).resolves.toBe(false);
  });

  it.each([
    ["scalar", json(true)],
    ["missing-flag", json({})],
    ["non-boolean", json({ interrupted: "yes" })]
  ])("rejects malformed v2 receipts: %s", async (_label, response) => {
    const { fetchImpl } = router({
      "/session/ses_a/abort": new Response("nope", { status: 405, statusText: "Method Not Allowed" }),
      "/api/session/ses_a/interrupt": response
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.abortSession("ses_a")).rejects.toThrow(/unexpected response/);
  });

  it("never falls back on v1 404 (missing session on both generations)", async () => {
    const { fetchImpl, calls } = router({});
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.abortSession("ses_gone")).rejects.toThrow(/failed: 404/);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_gone/abort"]);
  });

  it.each([401, 500])("never falls back on v1 HTTP %i (single POST, no retry)", async (status) => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/abort": new Response("denied", { status, statusText: "Denied" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.abortSession("ses_a")).rejects.toThrow(new RegExp(`failed: ${status}`));
    expect(calls).toHaveLength(1);
  });

  it("never falls back on a v1 network failure", async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      throw new TypeError("fetch failed");
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.abortSession("ses_a")).rejects.toThrow(/fetch failed/);
    expect(calls).toEqual(["http://127.0.0.1:4096/session/ses_a/abort"]);
  });
});

describe("OpencodeClient respondPermission (v1/v2 reply)", () => {
  const json = (value: unknown, status = 200) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const html = () => new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } });
  const notFound = () => new Response("not found", { status: 404, statusText: "Not Found" });

  function router(routes: Record<string, Response>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return (routes[new URL(String(url)).pathname] ?? notFound()).clone();
    };
    return { fetchImpl, calls };
  }

  const pending = (id: string, sessionID = "ses_a") => ({ id, sessionID, action: "read", resources: ["fs"] });
  const deny405 = () => new Response("nope", { status: 405, statusText: "Method Not Allowed" });

  it("keeps the v1 contract: wire body, single POST, no pre-read", async () => {
    const { fetchImpl, calls } = router({ "/session/ses_a/permissions/per_1": json(true) });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.respondPermission("ses_a", "per_1", "deny")).resolves.toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_a/permissions/per_1"]);
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ response: "reject", remember: false });
  });

  it.each([
    ["allow-once", "allow" as const, false, "once"],
    ["allow-remember", "allow" as const, true, "always"],
    ["once", "once" as const, false, "once"],
    ["always", "always" as const, false, "always"],
    ["deny", "deny" as const, false, "reject"],
    ["reject", "reject" as const, false, "reject"],
    ["deny-remember-dropped", "deny" as const, true, "reject"],
    ["unknown-fails-closed", "banana" as never, false, "reject"]
  ])("translates %s to decision %s on v2", async (_label, response, remember, decision) => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/permissions/per_1": deny405(),
      "/api/session/ses_a/permission": json({ data: [pending("per_1")] }),
      "/api/session/ses_a/permission/per_1/reply": json({})
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.respondPermission("ses_a", "per_1", response, remember)).resolves.toBe(true);
    const replyCall = calls.find((c) => c.url.endsWith("/reply"));
    expect(JSON.parse(String(replyCall?.init.body))).toEqual({ decision });
  });

  it("verifies pending state before posting and never replies twice", async () => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/permissions/per_1": deny405(),
      "/api/session/ses_a/permission": json({ data: [pending("per_1")] }),
      "/api/session/ses_a/permission/per_1/reply": json({})
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.respondPermission("ses_a", "per_1", "allow")).resolves.toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "http://127.0.0.1:4096/session/ses_a/permissions/per_1",
      "http://127.0.0.1:4096/api/session/ses_a/permission",
      "http://127.0.0.1:4096/api/session/ses_a/permission/per_1/reply"
    ]);
  });

  it("refuses without posting when the record is not pending", async () => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/permissions/per_1": deny405(),
      "/api/session/ses_a/permission": json({ data: [] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.respondPermission("ses_a", "per_1", "allow")).rejects.toThrow(/not pending for session ses_a/);
    expect(calls.some((c) => c.url.endsWith("/reply"))).toBe(false);
  });

  it("rejects a foreign record instead of answering it", async () => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/permissions/per_x": deny405(),
      "/api/session/ses_a/permission": json({ data: [pending("per_x", "ses_other")] })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    // Session-scoped unpacking rejects cross-session records before any reply.
    await expect(client.respondPermission("ses_a", "per_x", "allow")).rejects.toThrow(/unexpected response/);
    expect(calls.some((c) => c.url.endsWith("/reply"))).toBe(false);
  });

  it("reports post-reply 404 as indeterminate, never as granted", async () => {
    const { fetchImpl } = router({
      "/session/ses_a/permissions/per_1": deny405(),
      "/api/session/ses_a/permission": json({ data: [pending("per_1")] }),
      "/api/session/ses_a/permission/per_1/reply": new Response(
        JSON.stringify({ _tag: "PermissionNotFoundError", requestID: "per_1", message: "gone" }),
        { status: 404, statusText: "Not Found" }
      )
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    const failure = await client.respondPermission("ses_a", "per_1", "allow").then(
      () => null,
      (error: unknown) => error as Error
    );
    expect(failure).not.toBeNull();
    const message = (failure as Error).message;
    expect(message).toMatch(/indeterminate/);
    expect(message).not.toMatch(/granted|ok|success/i);
  });

  it("distinguishes a gone session from a settled permission", async () => {
    const { fetchImpl } = router({
      "/session/ses_a/permissions/per_1": deny405(),
      "/api/session/ses_a/permission": json({ data: [pending("per_1")] }),
      "/api/session/ses_a/permission/per_1/reply": new Response(
        JSON.stringify({ _tag: "SessionNotFoundError", sessionID: "ses_a", message: "gone" }),
        { status: 404, statusText: "Not Found" }
      )
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.respondPermission("ses_a", "per_1", "allow")).rejects.toThrow(/session not found: ses_a/);
  });

  it("treats a second answer as not-pending with a single reply POST total", async () => {
    let reads = 0;
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init = {}) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (path === "/session/ses_a/permissions/per_1") return deny405();
      if (path === "/api/session/ses_a/permission") {
        reads += 1;
        return reads === 1 ? json({ data: [pending("per_1")] }) : json({ data: [] });
      }
      if (path === "/api/session/ses_a/permission/per_1/reply") return json({});
      return notFound();
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.respondPermission("ses_a", "per_1", "allow")).resolves.toBe(true);
    await expect(client.respondPermission("ses_a", "per_1", "allow")).rejects.toThrow(/not pending/);
    expect(calls.filter((c) => c.endsWith("/reply"))).toHaveLength(1);
  });

  it("sends Basic auth on the v2 calls", async () => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/permissions/per_1": deny405(),
      "/api/session/ses_a/permission": json({ data: [pending("per_1")] }),
      "/api/session/ses_a/permission/per_1/reply": json({})
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", username: "u", password: "p", fetchImpl });
    await client.respondPermission("ses_a", "per_1", "allow");
    for (const call of calls.slice(1)) {
      expect((call.init.headers as Record<string, string>).Authorization).toBe(
        `Basic ${Buffer.from("u:p").toString("base64")}`
      );
    }
  });

  it("never falls back on v1 404 (missing session or record)", async () => {
    const { fetchImpl, calls } = router({});
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.respondPermission("ses_gone", "per_1", "allow")).rejects.toThrow(/failed: 404/);
    expect(calls.map((c) => c.url)).toEqual(["http://127.0.0.1:4096/session/ses_gone/permissions/per_1"]);
  });

  it.each([401, 500])("never falls back on v1 HTTP %i (single POST, no retry)", async (status) => {
    const { fetchImpl, calls } = router({
      "/session/ses_a/permissions/per_1": new Response("denied", { status, statusText: "Denied" })
    });
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
    await expect(client.respondPermission("ses_a", "per_1", "allow")).rejects.toThrow(new RegExp(`failed: ${status}`));
    expect(calls).toHaveLength(1);
  });
});
