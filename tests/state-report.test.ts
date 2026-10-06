import { describe, expect, it } from "vitest";
import { buildReport } from "../src/mcp/state.js";
import { fakeRegistry, makeContext, makeFakeClient, makeObservation, makeTempRepo } from "./fakes.js";
import type { OpencodeStateReport } from "../src/types.js";

const MINUTE = 60_000;

function payload(result: { structuredContent: unknown }): OpencodeStateReport {
  return result.structuredContent as OpencodeStateReport;
}

function ensureCalls(ctx: { processManager: unknown }): string[] {
  return (ctx.processManager as { ensureCalls: string[] }).ensureCalls;
}

describe("opencode_state", () => {
  it("reports ready/idle with observed activity and no invented fields", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "idle" } },
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 1_000 } }, parts: [] }]
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.availability).toBe("ready");
    expect(report.state).toBe("idle");
    expect(report.rawOpenCodeState).toBe("idle");
    expect(report.project.authorized).toBe(true);
    expect(report.lastActivityAt).not.toBeNull();
    expect(report.currentOperation).toBeNull();
    expect(report.lastOperation).toBeNull();
    expect(report.pendingInterventions).toEqual({ permissions: [], questions: [] });
    expect(report.lastError).toBeNull();
    expect(report.notes).toEqual([]);
  });

  it("reports busy when opencode is busy and activity is recent", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 5_000 } }, parts: [] }]
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("busy");
    expect(report.inactiveForMs).not.toBeNull();
    expect(report.execution.startedAt).not.toBeNull();
    expect(report.currentOperation).toBeNull(); // no observed event: nothing to claim
  });

  it("reports waiting-human while a question is pending even though raw status is busy", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      questions: [
        {
          id: "quest_1",
          sessionID: "ses_probe",
          questions: [{ question: "Which one?", header: "Pick", options: [{ label: "a" }, { label: "b" }] }]
        },
        { id: "quest_other", sessionID: "ses_other", questions: [{ question: "other", options: [] }] }
      ],
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 10 * MINUTE } }, parts: [] }]
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("waiting-human");
    expect(report.rawOpenCodeState).toBe("busy");
    expect(report.pendingInterventions.questions).toHaveLength(1);
    expect((report.pendingInterventions.questions[0] as { id: string }).id).toBe("quest_1");
  });

  it("reports waiting-human while a permission is pending", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      permissions: [{ id: "perm_1", sessionID: "ses_probe", permission: "bash", patterns: ["rm *"] }],
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 10 * MINUTE } }, parts: [] }]
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("waiting-human");
    expect(report.pendingInterventions.permissions).toHaveLength(1);
  });

  it("reports stalled when a busy session has been silent past the threshold", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 10 * MINUTE } }, parts: [] }]
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client, config: { stalledMs: 120_000 } });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("stalled");
    expect(report.inactiveForMs).toBeGreaterThanOrEqual(120_000);
  });

  it("reports stalled when busy with no meaningful recent activity", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ statuses: { ses_probe: { type: "busy" } } });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("stalled");
    expect(report.lastActivityAt).toBeNull();
    expect(report.inactiveForMs).toBeNull();
  });

  it("reports error while the newest signal is a message error", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      messages: [
        { info: { id: "msg_u", role: "user", time: { created: now - 5_000 } }, parts: [] },
        {
          info: { id: "msg_a", role: "assistant", time: { created: now - 1_000 }, error: { name: "APIError", message: "boom" } },
          parts: []
        }
      ]
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("error");
    expect(report.lastError).toBe("APIError: boom");
  });

  it("reports error from an observed session.error event", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 60_000 } }, parts: [] }]
    });
    const events = fakeRegistry(
      makeObservation("ses_probe", {
        lastActivityAt: now - 1_000,
        lastEventAt: now - 1_000,
        lastError: "APIError: exploded",
        lastErrorAt: now - 1_000,
        current: { type: "session.error", sessionID: "ses_probe", at: now - 1_000 }
      })
    );
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client, events });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("error");
    expect(report.lastError).toBe("APIError: exploded");
    expect(report.execution.lastEventAt).not.toBeNull();
  });

  it("exposes the current operation only while busy", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 1_000 } }, parts: [] }]
    });
    const events = fakeRegistry(
      makeObservation("ses_probe", {
        lastActivityAt: now - 1_000,
        lastEventAt: now - 1_000,
        current: { type: "message.part.updated", sessionID: "ses_probe", at: now - 1_000 },
        lastCompletion: { type: "session.idle", sessionID: "ses_probe", at: now - 60_000 }
      })
    );
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client, events });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.currentOperation).toEqual({ type: "message.part.updated", at: new Date(now - 1_000).toISOString() });
    expect(report.lastOperation).toEqual({ type: "session.idle", at: new Date(now - 60_000).toISOString() });
  });

  it("degrades to notes when supporting reads fail", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({
      failures: {
        getSessionStatus: "connect ECONNREFUSED 127.0.0.1:4096",
        listQuestions: "connect ECONNREFUSED 127.0.0.1:4096"
      }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.availability).toBe("ready");
    expect(report.state).toBe("idle");
    expect(report.rawOpenCodeState).toBeNull();
    expect(report.notes.join(" | ")).toContain("session status unavailable");
    expect(report.notes.join(" | ")).toContain("pending questions unavailable");
  });

  it("reports server-unreachable without inventing a session state", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({
      allowedRoots: [root],
      client,
      ensureError: "spawn opencode ENOENT"
    });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.availability).toBe("server-unreachable");
    expect(report.state).toBe("error");
    expect(report.rawOpenCodeState).toBeNull();
    expect(report.lastError).toContain("opencode server unavailable");
    expect(report.pendingInterventions).toEqual({ permissions: [], questions: [] });
  });

  it("reports session-not-found when opencode no longer knows the session", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ sessionExists: false });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.availability).toBe("session-not-found");
    expect(report.lastError).toContain("opencode session not found");
    expect(ensureCalls(ctx)).toHaveLength(1);
  });

  it("denies a repo removed from the allowlist without contacting opencode", async () => {
    const root = await makeTempRepo();
    const outside = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(outside);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.availability).toBe("repo-not-authorized");
    expect(report.project.authorized).toBe(false);
    expect(report.state).toBe("error");
    expect(report.lastError).toContain("outside allowed roots");
    expect(ensureCalls(ctx)).toHaveLength(0);
  });

  it("reports stale-repo when the stored repo path disappeared", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(`${root}/gone`);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.availability).toBe("stale-repo");
    expect(report.state).toBe("error");
    expect(ensureCalls(ctx)).toHaveLength(0);
  });

  it("rejects an unknown bridge session", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx } = await makeContext({ allowedRoots: [root], client });

    const result = await buildReport(ctx, "ses_does_not_exist");

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("ses_does_not_exist");
  });

  it("does not observe events when the bridge runs without an observer registry", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ statuses: { ses_probe: { type: "busy" } } });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.execution.lastEventAt).toBeNull();
    expect(report.lastOperation).toBeNull();
  });
});
