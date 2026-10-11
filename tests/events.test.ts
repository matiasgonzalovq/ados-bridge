import { describe, expect, it } from "vitest";
import { EventObserverRegistry, OpencodeEventObserver, type SessionObservation } from "../src/opencode/events.js";

const encoder = new TextEncoder();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for: ${label}`);
}

type ScriptedCall = { status?: number; events?: unknown[]; hold?: boolean };

/** SSE fetch fake: `hold` keeps the stream open until the abort signal fires. */
function scriptedFetch(script: ScriptedCall[]): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(String(input));
    const call = script[Math.min(calls.length - 1, script.length - 1)] ?? {};
    const status = call.status ?? 200;
    if (status >= 400) {
      return new Response("boom", { status, statusText: "Server Error" });
    }
    const signal = init?.signal ?? null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of call.events ?? []) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        if (!call.hold) {
          controller.close();
          return;
        }
        const onAbort = () => {
          try {
            controller.error(new Error("aborted"));
          } catch {
            /* already closed */
          }
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort);
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeObserver(fetchImpl: typeof fetch, options: { now?: () => number; maxRecentPerSession?: number } = {}): OpencodeEventObserver {
  return new OpencodeEventObserver({
    baseUrl: "http://127.0.0.1:4199",
    fetchImpl,
    reconnectBaseMs: 1,
    reconnectMaxMs: 5,
    ...options
  });
}

const SESSION_EVENT = { type: "message.part.updated", properties: { sessionID: "ses_a" } };

describe("OpencodeEventObserver", () => {
  it("updates lastActivityAt from a session-scoped event", async () => {
    let now = 1_000;
    const { fetchImpl } = scriptedFetch([{ events: [SESSION_EVENT], hold: true }]);
    const observer = makeObserver(fetchImpl, { now: () => now });
    observer.start();

    await waitFor(() => observer.snapshot("ses_a") !== null, "session observed");
    const snapshot = observer.snapshot("ses_a") as SessionObservation;
    expect(snapshot.lastActivityAt).toBe(1_000);
    expect(snapshot.lastEventAt).toBe(1_000);
    expect(snapshot.current?.type).toBe("message.part.updated");
    expect(snapshot.recent).toHaveLength(1);

    now = 2_000;
    observer.noteActivity("ses_a");
    expect(observer.snapshot("ses_a")?.lastActivityAt).toBe(2_000);
    expect(observer.lastEventAt).toBe(2_000);

    await observer.stop();
    expect(observer.isRunning).toBe(false);
  });

  it("never records server-level events as session activity", async () => {
    const { fetchImpl } = scriptedFetch([{ events: [{ type: "server.heartbeat" }], hold: true }]);
    const observer = makeObserver(fetchImpl);
    observer.start();

    await waitFor(() => observer.lastEventAt !== null, "server event received");
    expect(observer.snapshot("ses_a")).toBeNull();
    expect(observer.observedSessionIds()).toEqual([]);

    await observer.stop();
  });

  it("captures session.error and the completion marker", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        events: [
          { type: "session.error", properties: { sessionID: "ses_a", error: { name: "APIError", message: "nope" } } },
          { type: "session.idle", properties: { sessionID: "ses_a" } }
        ],
        hold: true
      }
    ]);
    const observer = makeObserver(fetchImpl);
    observer.start();

    await waitFor(() => {
      const snap = observer.snapshot("ses_a");
      return snap !== null && snap.lastCompletion !== null;
    }, "idle marker");
    const snapshot = observer.snapshot("ses_a") as SessionObservation;
    expect(snapshot.lastError).toBe("APIError: nope");
    expect(snapshot.lastErrorAt).not.toBeNull();
    expect(snapshot.lastCompletion?.type).toBe("session.idle");
    expect(snapshot.recent).toHaveLength(2);

    await observer.stop();
  });

  it("keeps the recent buffer bounded", async () => {
    const events = Array.from({ length: 30 }, (_, index) => ({ ...SESSION_EVENT, properties: { sessionID: "ses_a", n: index } }));
    const { fetchImpl } = scriptedFetch([{ events, hold: true }]);
    const observer = makeObserver(fetchImpl, { maxRecentPerSession: 5 });
    observer.start();

    await waitFor(() => (observer.snapshot("ses_a")?.recent.length ?? 0) === 5, "bounded recent");
    expect(observer.snapshot("ses_a")?.recent).toHaveLength(5);

    await observer.stop();
  });

  it("reconnects after a failed connection without rejecting the loop", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { status: 503 },
      { events: [SESSION_EVENT], hold: true }
    ]);
    const observer = makeObserver(fetchImpl);
    observer.start();

    await waitFor(() => calls.length >= 1, "first attempt");
    await waitFor(() => observer.snapshot("ses_a") !== null, "reconnected and observed");

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(observer.lastConnectError).toBeNull();
    expect(observer.connections).toBeGreaterThanOrEqual(1);

    await observer.stop();
  });

  it("reconnects after a clean stream end", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      { events: [SESSION_EVENT] },
      { events: [{ ...SESSION_EVENT, properties: { sessionID: "ses_a", n: 2 } }], hold: true }
    ]);
    const observer = makeObserver(fetchImpl);
    observer.start();

    await waitFor(() => calls.length >= 2, "second connection");
    await waitFor(() => (observer.snapshot("ses_a")?.recent.length ?? 0) >= 2, "both events observed");
    expect(observer.isConnected).toBe(true);

    await observer.stop();
  });

  it("stops cleanly, cancels the pending reconnect, and is safe to stop twice", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ status: 500 }, { status: 500 }, { status: 500 }]);
    const observer = makeObserver(fetchImpl);
    observer.start();

    await waitFor(() => calls.length >= 1, "first attempt");
    await observer.stop();
    expect(observer.isRunning).toBe(false);
    expect(observer.isConnected).toBe(false);

    const afterStop = calls.length;
    await sleep(50);
    expect(calls.length).toBe(afterStop);

    await observer.stop();
    expect(observer.isRunning).toBe(false);
  });

  it("reports an operational status snapshot", async () => {
    const { fetchImpl } = scriptedFetch([{ events: [SESSION_EVENT], hold: true }]);
    const observer = makeObserver(fetchImpl);
    expect(observer.status().running).toBe(false);

    observer.start();
    await waitFor(() => observer.snapshot("ses_a") !== null, "observed");

    const status = observer.status();
    expect(status.baseUrl).toBe("http://127.0.0.1:4199");
    expect(status.running).toBe(true);
    expect(status.connected).toBe(true);
    expect(status.sessions).toBe(1);
    expect(status.lastEventAt).not.toBeNull();

    await observer.stop();
  });
});

describe("EventObserverRegistry", () => {
  it("creates one observer per server and starts it lazily", async () => {
    const { fetchImpl, calls } = scriptedFetch([{ events: [SESSION_EVENT], hold: true }]);
    const registry = new EventObserverRegistry({ fetchImpl, reconnectBaseMs: 1, reconnectMaxMs: 5 });

    const first = registry.ensure({ baseUrl: "http://127.0.0.1:4199" });
    const second = registry.ensure({ baseUrl: "http://127.0.0.1:4199/" });
    expect(second).toBe(first);

    await waitFor(() => first.snapshot("ses_a") !== null, "registry observer connected");
    expect(registry.get("http://127.0.0.1:4199")).toBe(first);
    expect(registry.status()).toHaveLength(1);

    await registry.stopAll();
    expect(registry.status()).toHaveLength(0);
    const after = calls.length;
    await sleep(30);
    expect(calls.length).toBe(after);
  });

  it("stop(baseUrl) removes only that server's observer", async () => {
    const { fetchImpl } = scriptedFetch([{ status: 500 }]);
    const registry = new EventObserverRegistry({ fetchImpl, reconnectBaseMs: 1, reconnectMaxMs: 5 });
    const observer = registry.ensure({ baseUrl: "http://127.0.0.1:4199" });
    await waitFor(() => observer.status().running, "running");

    await registry.stop("http://127.0.0.1:4199/");
    expect(registry.get("http://127.0.0.1:4199")).toBeUndefined();
    await registry.stop("http://127.0.0.1:4199");
    await registry.stopAll();
  });
});

describe("OpencodeEventObserver v2 stream (OpenCode 2.x)", () => {
  // Fixtures shaped like the live 2.0.20 capture (CP1.47-A): envelopes
  // {id, created, type, location?, data:{sessionID,...}} framed as `data: {json}`.
  const V2_CREATED = {
    id: "evt_1",
    created: 1791680056749,
    type: "session.created",
    location: { directory: "/repo" },
    data: { sessionID: "ses_a", title: "lab" }
  };
  const V2_STARTED = {
    id: "evt_2",
    created: 1791680056833,
    type: "session.execution.started",
    data: { sessionID: "ses_a" }
  };
  const V2_SUCCEEDED = {
    id: "evt_3",
    created: 1791680058958,
    type: "session.execution.succeeded",
    data: { sessionID: "ses_a" }
  };
  const V2_FAILED = {
    id: "evt_4",
    created: 1791680058959,
    type: "session.execution.failed",
    data: { sessionID: "ses_a" }
  };
  const V2_LOCATION_ONLY = {
    id: "evt_5",
    created: 1791680056781,
    type: "project.updated",
    location: { directory: "/repo" },
    data: { id: "proj_1" }
  };

  type RouteSpec =
    | { status: number; contentType?: string; body?: string }
    | { sse: Array<string | unknown>; contentType?: string; hold?: boolean };

  function routedFetch(routes: Record<string, RouteSpec>): {
    fetchImpl: typeof fetch;
    calls: Array<{ url: string; init: RequestInit }>;
  } {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      const spec = routes[new URL(url).pathname] ?? { status: 404 as const };
      if ("status" in spec) {
        return new Response(spec.body ?? "nope", {
          status: spec.status,
          statusText: "Err",
          headers: spec.contentType ? { "content-type": spec.contentType } : undefined
        });
      }
      const signal = init?.signal ?? null;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const frame of spec.sse) {
            const text = typeof frame === "string" ? frame : `data: ${JSON.stringify(frame)}\n\n`;
            controller.enqueue(encoder.encode(text));
          }
          if (spec.hold) {
            const onAbort = () => {
              try {
                controller.error(new Error("aborted"));
              } catch {
                /* already closed */
              }
            };
            if (signal?.aborted) onAbort();
            else signal?.addEventListener("abort", onAbort);
            return;
          }
          controller.close();
        }
      });
      return new Response(body, { status: 200, headers: { "content-type": spec.contentType ?? "text/event-stream" } });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("keeps the v1 route when it streams valid SSE (no /api call)", async () => {
    const { fetchImpl, calls } = routedFetch({ "/event": { sse: [SESSION_EVENT], hold: true } });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => observer.snapshot("ses_a") !== null, "v1 observed");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/event"]);
    await observer.stop();
  });

  it("falls back to /api/event when /event answers HTML-200 (v2 SPA)", async () => {
    const { fetchImpl, calls } = routedFetch({
      "/event": { status: 200, contentType: "text/html", body: "<!doctype html><html></html>" },
      "/api/event": { sse: [V2_CREATED, V2_STARTED], hold: true }
    });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => observer.snapshot("ses_a") !== null, "v2 observed via fallback");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/event", "/api/event"]);
    expect(observer.snapshot("ses_a")?.current?.type).toBe("session.execution.started");
    expect(observer.isConnected).toBe(true);
    await observer.stop();
  });

  it("falls back to /api/event when /event is 404", async () => {
    const { fetchImpl, calls } = routedFetch({
      "/event": { status: 404 },
      "/api/event": { sse: [V2_CREATED], hold: true }
    });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => observer.snapshot("ses_a") !== null, "fallback on 404");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/event", "/api/event"]);
    await observer.stop();
  });

  it("never falls back on 401: auth failures keep surfacing on /event", async () => {
    const { fetchImpl, calls } = routedFetch({ "/event": { status: 401 } });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => observer.lastConnectError !== null, "auth error recorded");
    expect(observer.lastConnectError).toMatch(/401/);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => new URL(c.url).pathname === "/event")).toBe(true);
    expect(observer.snapshot("ses_a")).toBeNull();
    await observer.stop();
  });

  it("never treats HTML as connected when both routes serve it", async () => {
    const { fetchImpl } = routedFetch({
      "/event": { status: 200, contentType: "text/html", body: "<html></html>" },
      "/api/event": { status: 200, contentType: "text/html", body: "<html></html>" }
    });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => observer.lastConnectError !== null, "both-routes error recorded");
    expect(observer.lastConnectError).toMatch(/content-type/);
    expect(observer.isConnected).toBe(false);
    expect(observer.snapshot("ses_a")).toBeNull();
    await observer.stop();
  });

  it("ignores heartbeats and location-only events (no session mixing)", async () => {
    const { fetchImpl } = routedFetch({
      "/api/event": { sse: [": heartbeat\n", ":heartbeat\n", V2_LOCATION_ONLY, ": heartbeat\n"], hold: true }
    });
    // /event defaults to 404 in routedFetch, so this also exercises the fallback.
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => observer.lastEventAt !== null, "server event seen");
    expect(observer.observedSessionIds()).toEqual([]);
    expect(observer.snapshot("ses_a")).toBeNull();
    await observer.stop();
  });

  it("ignores heartbeat-only streams without faking activity", async () => {
    const { fetchImpl } = routedFetch({ "/event": { sse: [": heartbeat\n", ":heartbeat\n"], hold: true } });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await sleep(30);
    expect(observer.lastEventAt).toBeNull();
    expect(observer.observedSessionIds()).toEqual([]);
    await observer.stop();
  });

  it("records execution.succeeded as the completion marker", async () => {
    const { fetchImpl } = routedFetch({ "/event": { sse: [V2_STARTED, V2_SUCCEEDED], hold: true } });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => {
      const snap = observer.snapshot("ses_a");
      return snap !== null && snap.lastCompletion !== null;
    }, "succeeded marker");
    const snapshot = observer.snapshot("ses_a") as SessionObservation;
    expect(snapshot.lastCompletion?.type).toBe("session.execution.succeeded");
    expect(snapshot.current?.type).toBe("session.execution.succeeded");
    expect(snapshot.recent.map((e) => e.type)).toEqual(["session.execution.succeeded", "session.execution.started"]);
    await observer.stop();
  });

  it("records but never completes on unverified terminal types", async () => {
    const { fetchImpl } = routedFetch({ "/event": { sse: [V2_STARTED, V2_FAILED], hold: true } });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => observer.snapshot("ses_a")?.current?.type === "session.execution.failed", "failed observed");
    const snapshot = observer.snapshot("ses_a") as SessionObservation;
    // Visible as current/recent, but NOT rewritten into a completion.
    expect(snapshot.lastCompletion).toBeNull();
    await observer.stop();
  });

  it("stamps local time and ignores the server created field", async () => {
    const { fetchImpl } = routedFetch({ "/event": { sse: [V2_STARTED], hold: true } });
    const observer = makeObserver(fetchImpl, { now: () => 5_000 });
    observer.start();
    await waitFor(() => observer.snapshot("ses_a") !== null, "observed with fixed clock");
    // Wire `created` is 1791680058958-scale server ms; local clock rules all comparisons.
    expect(observer.snapshot("ses_a")?.lastActivityAt).toBe(5_000);
    await observer.stop();
  });

  it("reassembles a v2 frame split across chunks", async () => {
    const full = `data: ${JSON.stringify(V2_STARTED)}\n\n`;
    const cut = Math.floor(full.length / 2);
    const { fetchImpl } = routedFetch({ "/event": { sse: [full.slice(0, cut), full.slice(cut)], hold: true } });
    const observer = makeObserver(fetchImpl);
    observer.start();
    await waitFor(() => observer.snapshot("ses_a") !== null, "split frame reassembled");
    expect(observer.snapshot("ses_a")?.recent).toHaveLength(1);
    expect(observer.snapshot("ses_a")?.current?.type).toBe("session.execution.started");
    await observer.stop();
  });

  it("sends Basic auth on the /api/event fallback", async () => {
    const { fetchImpl, calls } = routedFetch({
      "/event": { status: 404 },
      "/api/event": { sse: [V2_CREATED], hold: true }
    });
    const observer = new OpencodeEventObserver({
      baseUrl: "http://127.0.0.1:4199",
      username: "u",
      password: "p",
      fetchImpl,
      reconnectBaseMs: 1,
      reconnectMaxMs: 5
    });
    observer.start();
    await waitFor(() => observer.snapshot("ses_a") !== null, "authed fallback");
    const fallbackInit = calls.find((c) => new URL(c.url).pathname === "/api/event")?.init;
    expect((fallbackInit?.headers as Record<string, string>).Authorization).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`
    );
    await observer.stop();
  });
});
