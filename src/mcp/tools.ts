import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";
import type { JsonValue } from "../types.js";
import { PERMISSION_RESPONSES } from "../opencode/client.js";
import { listProjects, validateRepoPath } from "../security/paths.js";
import { destructiveCheckpoint, filterInsideRepo, resolveInsideRepo } from "../security/checkpoints.js";
import { checkpointResult, safeTool } from "./results.js";
import { requireSession, type RegisterContext } from "./session.js";
import { sendPrompt } from "./send.js";
import { answerQuestion, listInterventions } from "./interventions.js";
import { buildReport } from "./state.js";
import { opencodeGitDiff, opencodeGitStatus } from "./git.js";

export { requireSession, type RegisterContext } from "./session.js";

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function createBridgeMcpServer(ctx: RegisterContext): McpServer {
  const server = new McpServer(
    { name: "opencode-chatgpt-bridge", version: "0.1.0" },
    {
      instructions:
"Use this server to control local opencode sessions. Always validate a repo with list_projects or create_session first. For an operational answer to \"what is happening\", call opencode_state: it derives idle/busy/waiting-human/stalled/error from several signals instead of trusting raw busy alone, and lists pending permissions/questions. Prefer async messages for long work, then poll opencode_state/opencode_get_messages and review get_diff before claiming changes are complete. When retrying a send after an ambiguous failure, reuse the same messageID: the bridge and opencode both dedupe on it. For REAL repository evidence (branch, clean/staged/untracked files, diffs) call opencode_git_status and opencode_git_diff: they read local Git inside the session repo only and never mutate the index or working tree. Destructive tools (opencode_stop, opencode_abort, opencode_respond_permission, opencode_answer_question) return a destructive checkpoint first: review it, then re-send the same call with confirmCheckpoint=true to proceed. File reads are contained to the session repository."
    }
  );

  server.registerTool(
    "bridge_health",
    {
      title: "Bridge health",
      description: "Check the bridge configuration and managed opencode processes.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () =>
      safeTool(async () => ({
        ok: true,
        allowedRoots: ctx.config.allowedRoots,
        opencodeBaseUrl: ctx.config.opencodeBaseUrl ?? null,
        managedProcesses: json(ctx.processManager.list()),
        tokenAuthEnabled: Boolean(ctx.config.bridgeToken),
        checkpoints: ctx.config.checkpoints,
        stalledMs: ctx.config.stalledMs ?? 120000,
        eventObservers: json(ctx.events?.status() ?? [])
      }))
  );

  server.registerTool(
    "list_projects",
    {
      title: "List local projects",
      description: "List Git repositories under the configured allowed roots.",
      inputSchema: { depth: z.number().int().min(0).max(5).default(2) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ depth }) => safeTool(async () => ({ projects: json(await listProjects(ctx.config.allowedRoots, depth)) }))
  );

  server.registerTool(
    "opencode_start",
    {
      title: "Start opencode server",
      description: "Start or reuse a local opencode server for a repo path within the allowed roots.",
      inputSchema: { repoPath: z.string().min(1) },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath }) =>
      safeTool(async () => {
        const validated = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        const managed = await ctx.processManager.ensure(validated);
        const client = ctx.processManager.clientFor(managed);
        return { ok: true, repoPath: validated, baseUrl: managed.baseUrl, health: json(await client.health()) };
      })
  );

  server.registerTool(
    "opencode_stop",
    {
      title: "Stop opencode server",
      description:
        "Stop managed opencode servers spawned by the bridge. Omitting repoPath stops all managed servers. Destructive: requires confirmCheckpoint=true when checkpoints are enabled.",
      inputSchema: { repoPath: z.string().optional(), confirmCheckpoint: z.boolean().default(false) },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath, confirmCheckpoint }) => {
      const gate = destructiveCheckpoint({
        enabled: ctx.config.checkpoints,
        confirmed: confirmCheckpoint,
        tool: "opencode_stop",
        action: "stop managed opencode server(s)",
        target: repoPath ?? "all managed servers"
      });
      if (gate) return checkpointResult(gate);
      return await safeTool(async () => {
        const validated = repoPath ? await validateRepoPath(repoPath, ctx.config.allowedRoots) : undefined;
        const before = ctx.processManager.list();
        const result = await ctx.processManager.stop(validated);
        if (ctx.events) {
          if (validated) {
            const target = before.find((proc) => proc.repoPath === validated);
            if (target) await ctx.events.stop(target.baseUrl);
          } else {
            await ctx.events.stopAll();
          }
        }
        return { ok: true, ...result };
      });
    }
  );

  server.registerTool(
    "opencode_create_session",
    {
      title: "Create opencode session",
      description: "Create an opencode session for a repo. Returns a bridgeSessionId used by other tools.",
      inputSchema: {
        repoPath: z.string().min(1),
        title: z.string().optional(),
        parentID: z.string().optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ repoPath, title, parentID }) =>
      safeTool(async () => {
        const validated = await validateRepoPath(repoPath, ctx.config.allowedRoots);
        const managed = await ctx.processManager.ensure(validated);
        const client = ctx.processManager.clientFor(managed);
        const session = await client.createSession(title, parentID);
        const opencodeSessionId = String(session.id ?? session.ID ?? session.sessionID ?? "");
        if (!opencodeSessionId) throw new Error(`opencode returned a session without an id: ${JSON.stringify(session)}`);
        const bridge = await ctx.state.createSession({
          opencodeSessionId,
          repoPath: validated,
          baseUrl: managed.baseUrl,
          title
        });
        return { ok: true, bridgeSession: json(bridge), opencodeSession: json(session) };
      })
  );

  server.registerTool(
    "opencode_list_sessions",
    {
      title: "List bridge sessions",
      description: "List bridge sessions previously created through this MCP server.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async () => safeTool(async () => ({ sessions: json(await ctx.state.listSessions()) }))
  );

  server.registerTool(
    "opencode_get_session_status",
    {
      title: "Get opencode session status",
      description: "Get status for an opencode session or all sessions in that repo.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const statuses = await client.getSessionStatus();
        return {
          bridgeSession: json(bridge),
          opencodeStatus: json(statuses[bridge.opencodeSessionId] ?? null),
          allStatuses: json(statuses)
        };
      })
  );

  server.registerTool(
    "opencode_state",
    {
      title: "Operational state",
      description:
        "Operational state of one bridge session: idle, busy, waiting-human, stalled, or error. " +
        "Derives from pending permissions/questions, observed events, recent messages, raw " +
        "session status and inactivity time instead of trusting busy alone. Reports " +
        "pendingInterventions, lastActivityAt/inactiveForMs, current/last operation, lastError, " +
        "and how well the session resolved (availability). Never invents data: unknown fields are null or [].",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) => buildReport(ctx, bridgeSessionId)
  );

  server.registerTool(
    "opencode_list_interventions",
    {
      title: "List pending interventions",
      description:
        "Pending opencode permissions and questions for a bridge session (filtered by session id). " +
        "Use polling here when the event stream was connected late; answers are never invented.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) => listInterventions(ctx, bridgeSessionId)
  );

  server.registerTool(
    "opencode_answer_question",
    {
      title: "Answer opencode question",
      description:
        "Answer a pending opencode question with an explicit human choice. answers holds one array " +
        "of selected option labels per question, in order. Destructive: requires " +
        "confirmCheckpoint=true when checkpoints are enabled.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        questionId: z.string().min(1),
        answers: z.array(z.array(z.string().min(1))).min(1),
        confirmCheckpoint: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async (input) => answerQuestion(ctx, input)
  );

  server.registerTool(
    "opencode_send_message",
    {
      title: "Send opencode message",
      description:
        "Send a prompt to an opencode session. Use async=true for long-running coding tasks. " +
        "Pass messageID to make the send idempotent: reuse the same value when retrying after an " +
        "ambiguous failure and the bridge/opencode will not create a second prompt. " +
        "On success, stateTouch reports whether bridge bookkeeping after the send succeeded; " +
        "a failed stateTouch never means the prompt was not accepted.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        text: z.string().min(1),
        async: z.boolean().default(true),
        providerID: z.string().optional(),
        modelID: z.string().optional(),
        agent: z.string().optional(),
        system: z.string().optional(),
        noReply: z.boolean().optional(),
        messageID: z.string().min(1).optional()
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async (input) => sendPrompt(ctx, input)
  );

  server.registerTool(
    "opencode_get_messages",
    {
      title: "Get opencode messages",
      description: "Fetch messages from a bridge session.",
      inputSchema: { bridgeSessionId: z.string().min(1), limit: z.number().int().min(1).max(200).optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, limit }) =>
      safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { bridgeSession: json(bridge), messages: json(await client.getMessages(bridge.opencodeSessionId, limit)) };
      })
  );

  server.registerTool(
    "opencode_get_diff",
    {
      title: "Get opencode diff",
      description: "Fetch file diffs for a bridge session. Call this before summarizing completed code work.",
      inputSchema: { bridgeSessionId: z.string().min(1), messageID: z.string().optional() },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, messageID }) =>
      safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { bridgeSession: json(bridge), diff: json(await client.getDiff(bridge.opencodeSessionId, messageID)) };
      })
  );

  server.registerTool(
    "opencode_abort",
    {
      title: "Abort opencode session",
      description:
        "Abort a running opencode session. Destructive: requires confirmCheckpoint=true when checkpoints are enabled.",
      inputSchema: { bridgeSessionId: z.string().min(1), confirmCheckpoint: z.boolean().default(false) },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ bridgeSessionId, confirmCheckpoint }) => {
      const gate = destructiveCheckpoint({
        enabled: ctx.config.checkpoints,
        confirmed: confirmCheckpoint,
        tool: "opencode_abort",
        action: "abort the running opencode session",
        target: bridgeSessionId
      });
      if (gate) return checkpointResult(gate);
      return await safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { ok: await client.abortSession(bridge.opencodeSessionId) };
      });
    }
  );

  server.registerTool(
    "opencode_respond_permission",
    {
      title: "Respond to opencode permission",
      description:
        "Allow or deny an opencode permission request surfaced in the session messages/status. " +
        "response: `once` or `allow` grants this single call, `always` remembers the grant, " +
        "`deny` or `reject` refuses the call (the bridge sends both as OpenCode's `reject`). " +
        "Destructive: requires confirmCheckpoint=true when checkpoints are enabled.",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        permissionId: z.string().min(1),
        response: z.enum(PERMISSION_RESPONSES),
        remember: z.boolean().default(false),
        confirmCheckpoint: z.boolean().default(false)
      },
      annotations: { readOnlyHint: false, openWorldHint: false }
    },
    async ({ bridgeSessionId, permissionId, response, remember, confirmCheckpoint }) => {
      const gate = destructiveCheckpoint({
        enabled: ctx.config.checkpoints,
        confirmed: confirmCheckpoint,
        tool: "opencode_respond_permission",
        action: "answer an opencode permission prompt",
        target: `${permissionId} -> ${response}${remember ? " (remembered)" : ""}`
      });
      if (gate) return checkpointResult(gate);
      return await safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { ok: await client.respondPermission(bridge.opencodeSessionId, permissionId, response, remember) };
      });
    }
  );

  server.registerTool(
    "opencode_read_file",
    {
      title: "Read project file through opencode",
      description:
        "Read a file using opencode's server API. The path must resolve inside the session repository (always enforced; no escape hatch).",
      inputSchema: { bridgeSessionId: z.string().min(1), path: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, path }) =>
      safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const target = await resolveInsideRepo(bridge.repoPath, path);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { file: json(await client.readFile(target)), path: target };
      })
  );

  server.registerTool(
    "opencode_find_files",
    {
      title: "Find project files through opencode",
      description:
        "Fuzzy find files in the current opencode project. The directory scope and returned paths are always contained to the session repository (always enforced; no escape hatch).",
      inputSchema: {
        bridgeSessionId: z.string().min(1),
        query: z.string().min(1),
        limit: z.number().int().min(1).max(200).default(50),
        directory: z.string().optional()
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId, query, limit, directory }) =>
      safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const scope = directory ? await resolveInsideRepo(bridge.repoPath, directory) : undefined;
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const found = await client.findFiles(query, limit, scope);
        const files = Array.isArray(found) ? await filterInsideRepo(bridge.repoPath, found) : found;
        return { files: json(files) };
      })
  );

  server.registerTool(
    "opencode_vcs_status",
    {
      title: "Get VCS status",
      description: "Get opencode VCS and tracked file status for a bridge session.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        return { vcs: json(await client.vcs()), files: json(await client.fileStatus()) };
      })
  );

  server.registerTool(
    "opencode_git_status",
    {
      title: "Git status (read-only)",
      description:
        "Read-only evidence of the local Git repository for a bridge session: branch, head, upstream, ahead/behind, " +
        "and the staged/modified/untracked/deleted/renamed/conflicted file lists plus clean/commitPending/pushPending. " +
        "Runs local Git inside the authorized session repo only (never an arbitrary cwd) and never mutates the index " +
        "or working tree. Returns a structured error if the repo is not a Git repository.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) => opencodeGitStatus(ctx, { bridgeSessionId })
  );

  server.registerTool(
    "opencode_git_diff",
    {
      title: "Git diff (read-only)",
      description:
        "Read-only diff evidence for a bridge session: unstaged changes (git diff), staged changes (git diff --cached), " +
        "and evidence for untracked files (detected with git ls-files --others --exclude-standard and shown via " +
        "git diff --no-index -- /dev/null, without git add or any index/working-tree mutation). Untracked file content " +
        "is read only when it resolves strictly inside the repo (symlinks are never followed).",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) => opencodeGitDiff(ctx, { bridgeSessionId })
  );

  server.registerTool(
    "opencode_capabilities",
    {
      title: "List opencode capabilities",
      description: "List agents, slash commands, and provider/model configuration available in opencode for a bridge session.",
      inputSchema: { bridgeSessionId: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ bridgeSessionId }) =>
      safeTool(async () => {
        const bridge = await requireSession(ctx, bridgeSessionId);
        const managed = await ctx.processManager.ensure(bridge.repoPath);
        const client = ctx.processManager.clientFor(managed);
        const [agents, commands, providers, providerAuth, configProviders] = await Promise.all([
          client.listAgents(),
          client.listCommands(),
          client.listProviders(),
          client.getProviderAuthMethods(),
          client.getConfigProviders()
        ]);
        return {
          agents: json(agents),
          commands: json(commands),
          providers: json(providers),
          providerAuth: json(providerAuth),
          configProviders: json(configProviders)
        };
      })
  );

  // ChatGPT Connector creation can be stricter than raw MCP clients.
 // The current MCP SDK adds experimental task execution metadata to every
 // registerTool() descriptor. We do not use task-augmented execution, so omit
 // it from tools/list for maximum Apps SDK compatibility.
 const registeredTools = (server as unknown as { _registeredTools?: Record<string, { execution?: unknown }> })._registeredTools;
 if (registeredTools) {
 for (const tool of Object.values(registeredTools)) {
 tool.execution = undefined;
 }
 }

 return server;
}
