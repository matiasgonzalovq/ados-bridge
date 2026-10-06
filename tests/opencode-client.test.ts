import { describe, expect, it } from "vitest";
import {
  OpencodeClient,
  PERMISSION_RESPONSES,
  toOpencodePermissionReply,
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
