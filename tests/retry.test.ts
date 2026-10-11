import { describe, expect, it } from "vitest";
import { OpencodeClient } from "../src/opencode/client.js";

function sequence(responses: Array<() => Response | Promise<Response>>): {
  fetchImpl: typeof fetch;
  calls: number;
} {
  const state = { calls: 0 };
  const fetchImpl: typeof fetch = async () => {
    const next = responses[state.calls];
    state.calls += 1;
    if (!next) throw new Error("no more responses");
    return await next();
  };
  return {
    fetchImpl,
    get calls() {
      return state.calls;
    }
  };
}

const ok = () => new Response(JSON.stringify({ healthy: true }), { status: 200, headers: { "content-type": "application/json" } });
const serverError = () => new Response("boom", { status: 503, statusText: "Service Unavailable" });

describe("OpencodeClient retry policy", () => {
  it("retries idempotent GETs on transient failures", async () => {
    const seq = sequence([serverError, serverError, ok]);
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl: seq.fetchImpl });

    await expect(client.health()).resolves.toEqual({ healthy: true });
    expect(seq.calls).toBe(3);
  });

  it("retries GETs on network errors", async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return ok();
    };
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl });

    await expect(client.health()).resolves.toEqual({ healthy: true });
    expect(calls).toBe(3);
  });

  it("gives up after bounded attempts (v1 probe + v2 probe)", async () => {
    // health() tries GET /global/health (max 3 reads) then falls back to
    // GET /api/project (max 3 reads): 6 bounded fetches total, never unbounded.
    const seq = sequence([serverError, serverError, serverError, serverError, serverError, serverError]);
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl: seq.fetchImpl });

    await expect(client.health()).rejects.toThrow(/failed: 503/);
    expect(seq.calls).toBe(6);
  });

  it("never retries POST / send_message (no duplicate prompts)", async () => {
    const seq = sequence([serverError]);
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl: seq.fetchImpl });

    await expect(client.createSession("t")).rejects.toThrow(/failed: 503/);
    expect(seq.calls).toBe(1);
  });

  it("never retries prompt_async sends", async () => {
    const seq = sequence([serverError]);
    const client = new OpencodeClient({ baseUrl: "http://127.0.0.1:4096", fetchImpl: seq.fetchImpl });

    await expect(client.sendMessage({ sessionId: "abc", text: "hi", async: true })).rejects.toThrow(/failed: 503/);
    expect(seq.calls).toBe(1);
  });
});
