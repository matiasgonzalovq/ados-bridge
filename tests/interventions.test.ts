import { describe, expect, it } from "vitest";
import { answerQuestion, listInterventions } from "../src/mcp/interventions.js";
import { makeContext, makeFakeClient, makeTempRepo } from "./fakes.js";
import type { PermissionRequest, QuestionRequest } from "../src/opencode/client.js";

const PERMISSION: PermissionRequest = {
  id: "perm_1",
  sessionID: "ses_probe",
  permission: "bash",
  patterns: ["rm -rf *"],
  metadata: { cwd: "/tmp" },
  always: ["bash"],
  tool: { messageID: "msg_1", callID: "call_1" }
};

const FOREIGN_PERMISSION: PermissionRequest = {
  ...PERMISSION,
  id: "perm_other",
  sessionID: "ses_other"
};

const QUESTION: QuestionRequest = {
  id: "quest_1",
  sessionID: "ses_probe",
  questions: [
    {
      question: "Which target should the tool touch?",
      header: "Target",
      options: [
        { label: "repo-a", description: "first" },
        { label: "repo-b", description: "second" }
      ]
    }
  ],
  tool: { messageID: "msg_2", callID: "call_2" }
};

describe("opencode_list_interventions", () => {
  it("lists pending permissions and questions for the bridge session only", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ permissions: [PERMISSION, FOREIGN_PERMISSION], questions: [QUESTION] });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await listInterventions(ctx, bridge.bridgeSessionId);
    expect(result.isError).toBeUndefined();
    const payload = result.structuredContent as unknown as {
      session: { opencodeSessionId: string };
      permissions: PermissionRequest[];
      questions: QuestionRequest[];
    };
    expect(payload.session.opencodeSessionId).toBe("ses_probe");
    expect(payload.permissions.map((item) => item.id)).toEqual(["perm_1"]);
    expect(payload.questions.map((item) => item.id)).toEqual(["quest_1"]);
  });

  it("returns empty lists when nothing is pending", async () => {
    const root = await makeTempRepo();
    const { ctx, seed } = await makeContext({ allowedRoots: [root] });
    const bridge = await seed(root);

    const result = await listInterventions(ctx, bridge.bridgeSessionId);
    const payload = result.structuredContent as unknown as { permissions: unknown[]; questions: unknown[] };
    expect(payload.permissions).toEqual([]);
    expect(payload.questions).toEqual([]);
  });

  it("denies a session whose repo is no longer allowed", async () => {
    const root = await makeTempRepo();
    const outside = await makeTempRepo();
    const { ctx, seed } = await makeContext({ allowedRoots: [root] });
    const bridge = await seed(outside);

    const result = await listInterventions(ctx, bridge.bridgeSessionId);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false });
  });
});

describe("opencode_answer_question", () => {
  it("returns a destructive checkpoint before touching opencode", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ questions: [QUESTION] });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await answerQuestion(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      questionId: "quest_1",
      answers: [["repo-a"]],
      confirmCheckpoint: false
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: false,
      checkpoint: "destructive",
      requiresConfirmation: true,
      tool: "opencode_answer_question"
    });
    expect(client.calls.answerQuestion).toHaveLength(0);
  });

  it("answers an explicit human choice once confirmed", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ questions: [QUESTION], answerQuestionResult: true });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await answerQuestion(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      questionId: "quest_1",
      answers: [["repo-a", "repo-b"]],
      confirmCheckpoint: true
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      ok: true,
      questionId: "quest_1",
      answers: [["repo-a", "repo-b"]],
      answered: true
    });
    expect(client.calls.answerQuestion).toEqual([{ requestID: "quest_1", answers: [["repo-a", "repo-b"]] }]);
  });

  it("never retries a rejected answer and surfaces opencode's 404", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({
      answerQuestionError:
        "opencode POST /question/quest_9/reply failed: 404 Not Found - {\"name\":\"QuestionNotFoundError\"}"
    });
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await answerQuestion(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      questionId: "quest_9",
      answers: [["repo-a"]],
      confirmCheckpoint: true
    });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("QuestionNotFoundError");
    expect(client.calls.answerQuestion).toHaveLength(1);
  });

  it("rejects an empty answer set", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(root);

    const result = await answerQuestion(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      questionId: "quest_1",
      answers: [],
      confirmCheckpoint: true
    });

    expect(result.isError).toBe(true);
    expect(client.calls.answerQuestion).toHaveLength(0);
  });

  it("denies a session whose repo is no longer allowed", async () => {
    const root = await makeTempRepo();
    const outside = await makeTempRepo();
    const client = makeFakeClient();
    const { ctx, seed } = await makeContext({ allowedRoots: [root], client });
    const bridge = await seed(outside);

    const result = await answerQuestion(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      questionId: "quest_1",
      answers: [["repo-a"]],
      confirmCheckpoint: true
    });

    expect(result.isError).toBe(true);
    expect(client.calls.answerQuestion).toHaveLength(0);
  });

  it("skips the checkpoint when checkpoints are disabled", async () => {
    const root = await makeTempRepo();
    const client = makeFakeClient({ answerQuestionResult: false });
    const { ctx, seed } = await makeContext({
      allowedRoots: [root],
      client,
      config: { checkpoints: false }
    });
    const bridge = await seed(root);

    const result = await answerQuestion(ctx, {
      bridgeSessionId: bridge.bridgeSessionId,
      questionId: "quest_1",
      answers: [["repo-b"]]
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, answered: false });
  });
});
