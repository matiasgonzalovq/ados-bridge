import { describe, expect, it } from "vitest";
import { normalizeMessageId, newMessageId, sendPrompt } from "../src/mcp/send.js";
import { DuplicatePromptError } from "../src/opencode/client.js";
import { makeContext, makeFakeClient, makeTempRepo, type FakeClient } from "./fakes.js";

function withFailingTouch(client: FakeClient, allowedRoots: string[]) {
  return makeContext({ allowedRoots, client }).then(({ ctx, seed }) => {
    const broken = Object.create(ctx.state) as typeof ctx.state;
    broken.updateSession = async () => {
      throw new Error("state store is read-only");
    };
    return { ctx: { ...ctx, state: broken }, seed };
  });
}

describe("normalizeMessageId", () => {
  it("prefixes bare ids and keeps opencode-compatible ones", () => {
    expect(normalizeMessageId("retry-42")).toBe("msg_retry-42");
    expect(normalizeMessageId("msg_abc")).toBe("msg_abc");
    expect(normalizeMessageId("  msg_abc  ")).toBe("msg_abc");
  });

  it("rejects ids with nothing usable", () => {
    expect(() => normalizeMessageId("   ")).toThrow(/at least one alphanumeric/);
  });
});

describe("newMessageId", () => {
  it("produces opencode-compatible ids", () => {
    const id = newMessageId();
    expect(id.startsWith("msg")).toBe(true);
    expect(id.length).toBeGreaterThan(4);
    expect(newMessageId()).not.toBe(id);
  });
});

describe("opencode_send_message idempotency", () => {
  it("sends with the caller's messageID on the first attempt", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "hello", messageID: "retry-1" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, accepted: true, duplicate: false, messageID: "msg_retry-1" });
    expect(client.calls.sendMessage).toHaveLength(1);
    expect(client.calls.sendMessage[0]).toEqual({
      sessionId: bridge.opencodeSessionId,
      messageID: "msg_retry-1",
      text: "hello",
      async: true
    });
  });

  it("preserves explicitly requested v1-only options without adding omitted ones", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    await sendPrompt(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      text: "hello",
      providerID: "provider",
      modelID: "model",
      agent: "Build",
      system: "system",
      noReply: false
    });

    expect(client.calls.sendMessage[0]).toMatchObject({
      providerID: "provider",
      modelID: "model",
      agent: "Build",
      system: "system",
      noReply: false
    });
  });

  it("does not create a second prompt when the same messageID was already accepted", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({
      acceptedMessages: { "msg_retry-1": { id: "msg_retry-1", parts: [] } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "hello", messageID: "retry-1" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, accepted: true, duplicate: true, messageID: "msg_retry-1" });
    expect(client.calls.sendMessage).toHaveLength(0);
  });

  it("sends again when a different messageID is used", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "one", messageID: "first" });
    await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "two", messageID: "second" });

    expect(client.calls.sendMessage).toHaveLength(2);
    expect(client.calls.sendMessage.map((call) => call.messageID)).toEqual(["msg_first", "msg_second"]);
  });

  it("generates a compatible messageID when the caller omits one", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "hello" });

    const payload = result.structuredContent as { messageID: string };
    expect(payload.messageID.startsWith("msg")).toBe(true);
    expect(client.calls.sendMessage).toHaveLength(1);
  });

  it("blocks a dependent continuation when idle is uncorroborated", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ statuses: {} });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);
    const result = await sendPrompt(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      text: "continue",
      dependsOnPreviousCompletion: true
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("completionEvidence=uncorroborated");
    expect(client.calls.sendMessage).toHaveLength(0);
  });

  it("allows a dependent continuation only after corroborated successful completion", async () => {
    const root = await makeTempRepo();
    const idleAt = Date.now() - 1_000;
    const client = makeFakeClient({
      statuses: {},
      sessionInfo: { outcome: "succeeded", time: { idle: idleAt } }
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);
    const result = await sendPrompt(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      text: "continue",
      dependsOnPreviousCompletion: true
    });
    expect(result.isError).toBeUndefined();
    expect(client.calls.sendMessage).toHaveLength(1);
  });

  it("never retries an ambiguous POST", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ sendMessageError: "socket hang up (response never observed)" });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "hello", messageID: "retry-1" });

    expect(result.isError).toBe(true);
    expect(client.calls.sendMessage).toHaveLength(1);
    expect(JSON.stringify(result.structuredContent)).toContain("socket hang up");
  });

  it("keeps a successful send successful when the state touch fails", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await withFailingTouch(client, [root]);
    const bridge = await seed(root);

    const result = await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "hello" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, accepted: true });
    const payload = result.structuredContent as { stateTouch: { ok: boolean; error: string } };
    expect(payload.stateTouch.ok).toBe(false);
    expect(payload.stateTouch.error).toContain("read-only");
    expect(client.calls.sendMessage).toHaveLength(1);
  });

  it("denies sending to a session whose repo is no longer allowed", async () => {
    const root = await makeTempRepo();
    const outside = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(outside);

    const result = await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "hello" });

    expect(result.isError).toBe(true);
    expect(client.calls.sendMessage).toHaveLength(0);
  });

  it("reports a 409-verified conflict as duplicate without resending", async () => {
    const root = await makeTempRepo();
    const base = makeFakeClient();
    const existing = { info: { id: "msg_retry-1", role: "user" }, parts: [] as unknown[] };
    let posts = 0;
    const client: FakeClient = {
      ...base,
      sendMessage: async () => {
        posts += 1;
        throw new DuplicatePromptError("msg_retry-1", existing as never);
      }
    };
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await sendPrompt(ctx, { bridgeSessionId: bridge.bridgeSessionId, text: "hello", messageID: "retry-1" });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, accepted: true, duplicate: true, messageID: "msg_retry-1" });
    expect(posts).toBe(1);
  });
});
