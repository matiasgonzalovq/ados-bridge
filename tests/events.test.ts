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
