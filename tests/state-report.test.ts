import { describe, expect, it } from "vitest";
import { buildReport, isCompletionSafe } from "../src/mcp/state.js";
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
    // Unknown reads are explicit non-zeros, never silent empties.
    expect(report.notes.join(" | ")).toContain("pending questions unknown (zero NOT confirmed)");
    expect(report.pendingInterventions).toEqual({ permissions: [], questions: [] });
  });

  it("marks unknown permission reads as explicitly unconfirmed", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ failures: { listPermissions: "boom 500" } });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.notes.join(" | ")).toContain("pending permissions unknown (zero NOT confirmed)");
    expect(report.pendingInterventions.permissions).toEqual([]);
  });

  it("corroborates completion from server-stamped outcome and idle time", async () => {
    const root = await makeTempRepo();
    const idleAt = Date.now() - 30_000;
    const client = makeFakeClient({
      statuses: {},
      sessionInfo: { outcome: "succeeded", time: { created: idleAt - 60_000, updated: idleAt, idle: idleAt } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("idle");
    expect(report.notes.join(" | ")).toContain("completion corroborated: opencode outcome=succeeded");
    expect(report.notes.join(" | ")).toContain("server-reported");
    expect(report.lastError).toBeNull();
  });

  it("reports a server-stamped failed outcome as lastError without newer signals", async () => {
    const root = await makeTempRepo();
    const idleAt = Date.now() - 30_000;
    const client = makeFakeClient({
      statuses: {},
      sessionInfo: { outcome: "failed", time: { created: idleAt - 60_000, updated: idleAt, idle: idleAt } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.lastError).toBe("opencode reported outcome: failed");
    expect(report.notes.join(" | ")).toContain("completion corroborated: opencode outcome=failed");
  });

  it("prefers newer message errors over a stamped interrupted outcome", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: {},
      sessionInfo: { outcome: "interrupted", time: { created: now - 120_000, updated: now - 100_000, idle: now - 100_000 } },
      messages: [
        {
          info: { role: "assistant", time: { created: now - 1_000 }, error: { name: "APIError", message: "nope" } },
          parts: []
        }
      ]
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.lastError).toBe("APIError: nope");
    expect(report.notes.join(" | ")).toContain("completion corroborated: opencode outcome=interrupted");
  });

  it("ignores non-terminal or malformed outcome payloads", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ statuses: {}, sessionInfo: { outcome: "running", time: {} } });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.lastError).toBeNull();
    expect(report.notes.join(" | ")).not.toContain("completion corroborated");
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

describe("opencode_state stale intervention reconciliation", () => {
  function assistantMessage(id: string, createdAt: number, completedAt?: number) {
    return {
      info: { id, role: "assistant", time: { created: createdAt, ...(completedAt ? { completed: completedAt } : {}) } },
      parts: []
    };
  }

  it("does not force waiting-human for a permission whose owning message already completed", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "idle" } },
      permissions: [
        {
          id: "perm_aborted",
          sessionID: "ses_probe",
          permission: "external_directory",
          patterns: ["/var/*"],
          always: ["/var/*"],
          metadata: {},
          tool: { messageID: "msg_aborted", callID: "call_1" }
        }
      ],
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 10 * MINUTE } }, parts: [] }],
      acceptedMessages: { msg_aborted: assistantMessage("msg_aborted", now - 9 * MINUTE, now - 8 * MINUTE) }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("idle");
    expect(report.pendingInterventions).toEqual({ permissions: [], questions: [] });
    expect(report.notes.join(" | ")).toContain("stale permission perm_aborted");
    expect(report.notes.join(" | ")).toContain("already completed");
  });

  it("keeps waiting-human for a live permission while dropping only the stale one", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      permissions: [
        {
          id: "perm_aborted",
          sessionID: "ses_probe",
          permission: "external_directory",
          patterns: ["/var/*"],
          always: ["/var/*"],
          metadata: {},
          tool: { messageID: "msg_aborted", callID: "call_1" }
        },
        {
          id: "perm_live",
          sessionID: "ses_probe",
          permission: "bash",
          patterns: ["rm *"],
          metadata: {},
          always: ["bash"],
          tool: { messageID: "msg_live", callID: "call_2" }
        }
      ],
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 5_000 } }, parts: [] }],
      acceptedMessages: {
        msg_aborted: assistantMessage("msg_aborted", now - 9 * MINUTE, now - 8 * MINUTE),
        msg_live: assistantMessage("msg_live", now - 4_000)
      }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("waiting-human");
    expect(report.pendingInterventions.permissions.map((item) => item.id)).toEqual(["perm_live"]);
    expect(report.pendingInterventions.permissions.map((item) => item.id)).not.toContain("perm_aborted");
  });

  it("does not force waiting-human for a question whose owning message already completed", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "idle" } },
      questions: [
        {
          id: "quest_stale",
          sessionID: "ses_probe",
          questions: [{ question: "Which one?", header: "Pick", options: [{ label: "a" }] }],
          tool: { messageID: "msg_aborted", callID: "call_1" }
        }
      ],
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 10 * MINUTE } }, parts: [] }],
      acceptedMessages: { msg_aborted: assistantMessage("msg_aborted", now - 9 * MINUTE, now - 8 * MINUTE) }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("idle");
    expect(report.pendingInterventions).toEqual({ permissions: [], questions: [] });
    expect(report.notes.join(" | ")).toContain("stale question quest_stale");
  });

  it("keeps waiting-human while the owning message is still in flight", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      permissions: [
        {
          id: "perm_live",
          sessionID: "ses_probe",
          permission: "bash",
          patterns: ["rm *"],
          metadata: {},
          always: ["bash"],
          tool: { messageID: "msg_live", callID: "call_1" }
        }
      ],
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 5_000 } }, parts: [] }],
      acceptedMessages: { msg_live: assistantMessage("msg_live", now - 4_000) }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("waiting-human");
    expect(report.pendingInterventions.permissions.map((item) => item.id)).toEqual(["perm_live"]);
  });

  it("keeps a permission actionable when its owning message cannot be resolved", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      permissions: [
        {
          id: "perm_unknown",
          sessionID: "ses_probe",
          permission: "external_directory",
          patterns: ["/var/*"],
          always: ["/var/*"],
          metadata: {},
          tool: { messageID: "msg_missing", callID: "call_1" }
        }
      ],
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 5_000 } }, parts: [] }]
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("waiting-human");
    expect(report.pendingInterventions.permissions.map((item) => item.id)).toEqual(["perm_unknown"]);
  });
});

describe("opencode_state safety guard (CP1.49-B)", () => {
  it("marks a healthy v1 report complete-but-uncorroborated: never auto-completes v1 idle", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ statuses: { ses_probe: { type: "idle" } } });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.observationComplete).toBe(true);
    expect(report.completionEvidence).toBe("uncorroborated");
    expect(isCompletionSafe(report)).toBe(false);
  });

  it("authorizes completion only for corroborated success with complete observation", async () => {
    const root = await makeTempRepo();
    const idleAt = Date.now() - 30_000;
    const client = makeFakeClient({
      statuses: {},
      sessionInfo: { outcome: "succeeded", time: { created: idleAt - 60_000, updated: idleAt, idle: idleAt } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("idle");
    expect(report.observationComplete).toBe(true);
    expect(report.completionEvidence).toBe("corroborated-success");
    expect(isCompletionSafe(report)).toBe(true);
  });

  it("never celebrates a corroborated failure as completable", async () => {
    const root = await makeTempRepo();
    const idleAt = Date.now() - 30_000;
    const client = makeFakeClient({
      statuses: {},
      sessionInfo: { outcome: "failed", time: { created: idleAt - 60_000, updated: idleAt, idle: idleAt } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    // A recent confirmed failure with nothing newer is an error state, not idle.
    expect(report.state).toBe("error");
    expect(report.lastError).toBe("opencode reported outcome: failed");
    expect(report.completionEvidence).toBe("not-applicable");
    expect(isCompletionSafe(report)).toBe(false);
  });

  it("keeps corroborated-failure visible but unsafe when newer activity exists", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: {},
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 1_000 } }, parts: [] }],
      sessionInfo: { outcome: "failed", time: { created: now - 120_000, updated: now - 100_000, idle: now - 100_000 } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("idle");
    expect(report.completionEvidence).toBe("corroborated-failure");
    expect(report.lastError).toBe("opencode reported outcome: failed");
    expect(isCompletionSafe(report)).toBe(false);
  });

  it.each(["getSessionStatus", "listPermissions", "listQuestions", "getMessages"] as const)(
    "marks observation incomplete when %s fails, keeping v1-compatible state",
    async (key) => {
      const root = await makeTempRepo();
      const client = makeFakeClient({ statuses: { ses_probe: { type: "idle" } }, failures: { [key]: "boom" } });
      const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
      const bridge = await seed(root);

      const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

      expect(report.observationComplete).toBe(false);
      expect(isCompletionSafe(report)).toBe(false);
      // Derivation itself is unchanged (v1 parity): the guard travels in fields, not in state.
      expect(report.state).toBe("idle");
      expect(report.availability).toBe("ready");
    }
  );

  it("marks contradictory evidence (busy status, succeeded outcome) not-applicable", async () => {
    const root = await makeTempRepo();
    const now = Date.now();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      messages: [{ info: { id: "msg_u", role: "user", time: { created: now - 5_000 } }, parts: [] }],
      sessionInfo: { outcome: "succeeded", time: { created: now - 60_000, updated: now - 5_000 } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("busy");
    expect(report.completionEvidence).toBe("not-applicable");
    expect(isCompletionSafe(report)).toBe(false);
  });

  it("marks waiting-human not-applicable for completion even when corroborated", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({
      statuses: { ses_probe: { type: "busy" } },
      permissions: [{ id: "per_1", sessionID: "ses_probe", permission: "edit" }],
      sessionInfo: { outcome: "succeeded", time: { created: Date.now() - 60_000, updated: Date.now() - 1_000 } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.state).toBe("waiting-human");
    expect(report.completionEvidence).toBe("not-applicable");
    expect(isCompletionSafe(report)).toBe(false);
  });

  it("marks unresolved reports incomplete and never completable", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ sessionExists: false });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.availability).toBe("session-not-found");
    expect(report.observationComplete).toBe(false);
    expect(report.completionEvidence).toBe("not-applicable");
    expect(isCompletionSafe(report)).toBe(false);
  });

  it("treats SSE disconnection as auxiliary: polling still completes observation", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ statuses: { ses_probe: { type: "idle" } } });
    // No events registry: the observer stream is disconnected/absent.
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const report = payload(await buildReport(ctx, bridge.bridgeSessionId));

    expect(report.observationComplete).toBe(true);
    expect(report.lastOperation).toBeNull();
    // …but a v1 idle is still never auto-completable.
    expect(isCompletionSafe(report)).toBe(false);
  });

  it("simulates the automated-consumer rule across the full matrix", () => {
    const base: OpencodeStateReport = {
      project: { repoPath: "/r", authorized: true },
      session: { bridgeSessionId: "b", opencodeSessionId: "ses_x" },
      availability: "ready",
      rawOpenCodeState: null,
      lastActivityAt: null,
      inactiveForMs: null,
      currentOperation: null,
      lastOperation: null,
      pendingInterventions: { permissions: [], questions: [] },
      lastError: null,
      execution: { startedAt: null, lastEventAt: null },
      notes: [],
      observationComplete: true,
      completionEvidence: "uncorroborated",
      state: "idle"
    };
    const cases: Array<[string, Partial<OpencodeStateReport>, boolean]> = [
      ["idle+complete+corroborated-success → proceed", { completionEvidence: "corroborated-success" }, true],
      ["idle+complete+uncorroborated → poll", {}, false],
      ["idle+complete+corroborated-failure → escalate, never celebrate", { completionEvidence: "corroborated-failure" }, false],
      ["idle+incomplete+corroborated-success → re-poll", { observationComplete: false, completionEvidence: "corroborated-success" }, false],
      ["busy → poll", { state: "busy", completionEvidence: "not-applicable" }, false],
      ["stalled → escalate", { state: "stalled", completionEvidence: "not-applicable" }, false],
      ["waiting-human → answer flow", { state: "waiting-human", completionEvidence: "not-applicable" }, false],
      ["error → escalate", { state: "error", completionEvidence: "not-applicable" }, false]
    ];
    for (const [label, patch, expected] of cases) {
      expect(isCompletionSafe({ ...base, ...patch }), label).toBe(expected);
    }
  });
});
