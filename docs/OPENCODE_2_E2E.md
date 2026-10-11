# OpenCode 2.0.20 controlled E2E

Status: validated by the controlled CP1.51-G run. Repeating this procedure sends a real instruction
to a model/agent and therefore requires explicit human authorization immediately before execution.

## Fixed scope

- Repository under test: a dedicated `bridge-test` laboratory checkout only. Resolve and record its
  absolute path locally; never commit a user-specific path.
- Temporary authenticated OpenCode 2.0.20 server only; do not use or restart the primary Bridge.
- No Iglesia App, Staging, Production, Firebase, commits, pushes, deploys, or automatic permission grants.
- Use unique temporary session/form/message IDs and reuse the same message ID after any ambiguous send.
- Selected provider/model: `opencode-go/longcat-2.5-preview-free`. OpenCode 2.0.20 advertised it with zero
  input, output, and cache cost. Recheck the effective model metadata immediately before every run;
  if it is absent, disabled, or has any non-zero cost, stop and request new authorization.
- Selected primary agent: display name `Build`, configuration/API ID `build`.

## Temporary OpenCode configuration

The temporary server must not inherit project configuration. Start it with a fresh, recorded
configuration directory and all three environment variables below:

```sh
OPENCODE_CONFIG_DIR="$E2E_CONFIG_DIR"
OPENCODE_CONFIG_PROJECT_DISABLE=1
OPENCODE_CONFIG_CONTENT='{"model":"opencode-go/longcat-2.5-preview-free","default_agent":"build","permission":{"*":"deny","edit":"ask","external_directory":"deny"}}'
```

The key is `permission` (singular), as required by the OpenCode 2.0.20 public configuration schema.
Rule order is intentional: OpenCode preserves it and the last matching rule wins. The effective
result is that every action is denied except `edit`, which requires a human answer, while every
external-directory access remains denied. `write` and `patch` share the `edit` permission action.
In particular, `bash`, tasks, web tools, and all other unmatched actions remain denied.
Although the UI name is `Build`, OpenCode 2.0.20 agent IDs are case-sensitive and the actual ID is
lowercase `build`. Using `"Build"` does not resolve that agent and merely happens to fall back to the
built-in default, which is not acceptable evidence that the configured selection took effect.

Before creating a session, query the authenticated temporary server and verify all of the following:

- after provider settlement, `/api/model/default` is exactly provider `opencode-go`, model
  `longcat-2.5-preview-free`, with `enabled=true`, `status=active`, tools enabled, and every advertised
  cost zero;
- agent ID `build` exists, has display name `Build`, is primary and visible, and appears first in the
  agent list as the selected default;
- its effective rules end with `* = deny`, `edit = ask`, and `external_directory = deny` in that order;
- no project configuration, plugin, MCP server, command, or instruction was inherited unexpectedly.

Do not pass model or agent selection in the prompt. OpenCode v2's prompt endpoint has no equivalent
fields; selection is fixed by the temporary server configuration above.

## Filesystem isolation on macOS

The Bridge allowlist and OpenCode permissions are logical controls, not an operating-system sandbox.
They must never be described as absolute isolation.

For the real E2E, start the temporary OpenCode server manually with macOS `sandbox-exec`, then point
the temporary Bridge at that authenticated loopback URL instead of asking the Bridge to spawn it.
Use an inline or separately reviewed temporary profile with these properties:

- default deny;
- allow process execution, loopback/network access, and read access needed by the OpenCode binary;
- allow filesystem writes only beneath two newly created, exactly recorded directories inside the
  resolved `bridge-test` real path: one for OpenCode state and one for E2E output;
- place the temporary OpenCode config, data, cache, database, logs, and provider-auth copy beneath a
  dedicated directory inside `bridge-test` so OpenCode does not need write access elsewhere;
- deny writes everywhere else, including pre-existing files in `bridge-test`, the Bridge repository,
  and the user's normal OpenCode data;
- mount or copy only the minimum provider authentication material needed, never print it, and remove
  the dedicated temporary directory during exact-path cleanup.

`sandbox-exec` is present in the target macOS installation, but it is deprecated and its profile
language is not a supported public security boundary. Therefore this procedure provides an additional
kernel-enforced write restriction, not a claim of absolute isolation. If the sandboxed server cannot
start, authenticate, create its own session database inside the dedicated directory, or expose the
effective configuration endpoints without broader write access, stop. The safe fallback is a disposable
container/VM with only `bridge-test` mounted read-write; do not fall back to an unsandboxed model run.
For the tested local authentication layout, copy only `~/.local/share/opencode/auth.json` into the
temporary `XDG_DATA_HOME/opencode/auth.json`, set mode `0600`, and never copy the normal OpenCode
database, logs, plugins, or configuration. The copy and all newly created OpenCode state remain under
the dedicated E2E directory and are removed by exact recorded path during cleanup.
OpenCode Go model selection also requires exporting `OPENCODE_API_KEY` to the temporary OpenCode
process from the existing Go credential. Read it without printing or logging it, do not modify the
credential, and never persist the value in the repository or evidence record.
The harmless instruction must target only the dedicated output directory; never grant the sandbox
write access to the whole laboratory merely to simplify the profile.

## Preflight (read-only)

1. Confirm `opencode --version` is exactly `2.0.20`.
2. Confirm `bridge-test` exists, resolve its real path, and record `git status --short --branch`.
3. Start a temporary authenticated OpenCode server bound to `127.0.0.1` on an unused port with
   `bridge-test` as its working directory, the isolated configuration above, and the reviewed macOS
   sandbox profile. Generate credentials in the shell environment; never put them in command history,
   logs, URLs, or this document.
4. Verify authenticated `GET /api/project` and reject any response that is HTML, unauthenticated, or
   does not match the expected JSON contract.
5. Configure a temporary Bridge process/state directory with the allowlist containing only the
   resolved `bridge-test` path and `OPENCODE_BASE_URL` pointing to the manually started sandboxed
   server. Do not use the primary Bridge state, port, token, OpenCode process, or LaunchAgent.

## Authorized execution

Stop here and obtain explicit human authorization to execute a model. After authorization:

1. Through MCP call `opencode_create_session` for `bridge-test`; record both bridge and OpenCode session IDs.
2. Call `opencode_send_message` once with exactly `bridgeSessionId`, the harmless `text`, a unique
   stable `messageID`, `async=true`, and `dependsOnPreviousCompletion=false`. Omit `providerID`,
   `modelID`, `agent`, `system`, and `noReply`: CP1.50-B deliberately rejects those options on the v2
   prompt route rather than silently dropping them. The instruction must be confined to a temporary
   file inside `bridge-test`.
3. Require `accepted=true` and retain the same `messageID`; never blindly retry an ambiguous result.
4. Observe with `opencode_state` plus `opencode_get_messages`; verify SSE activity and polling agree on
   the same session. Exercise one controlled human intervention. Do not answer until the human has
   inspected it and repeated the call with `confirmCheckpoint=true`.
5. For a v2 form, answer using the exact field keys and typed values returned by
   `opencode_list_interventions`; alternatively test cancellation with `opencode_reject_question`.
   Never supply invented required values and never approve a real permission automatically.
6. Continue polling. Completion is accepted only when `state=idle`, `observationComplete=true`, and
   `completionEvidence=corroborated-success`. If any condition is absent, keep polling or stop for review.
7. Read the final messages, `opencode_git_status`, and `opencode_git_diff`. Confirm the result belongs
   only to the temporary session and only changes the expected temporary file.
8. If testing a dependent follow-up, call `opencode_send_message` with
   `dependsOnPreviousCompletion=true`; confirm the bridge refuses it before corroborated completion.

## Cleanup and evidence

1. Abort only the temporary session if it is still active, with human-confirmed checkpoint.
2. Remove the temporary test artifact only after recording its diff and confirming its exact path.
3. Stop only the temporary Bridge/OpenCode processes and remove only their explicitly recorded state directory.
4. Compare final Git status with the preflight snapshot; `bridge-test` must return to its original state.
5. Preserve a redacted evidence record: versions, ports (not credentials), IDs, acceptance receipt,
   intervention result, SSE/polling observations, completion evidence, final messages, Git evidence,
   and cleanup confirmation.

Any cross-session record, authentication failure, ambiguous mutation, uncorroborated idle state, or
unexpected filesystem change is a test failure and a mandatory stop.

Starting the model remains a separate human checkpoint. Passing this document's preflight, including
the sandbox smoke test and effective-configuration inspection, does not authorize `opencode_send_message`.
Immediately before that call, present the exact instruction, model/provider, expected writable paths,
and current zero-cost evidence, then obtain an explicit human authorization for this one E2E run.

## CP1.51-G validation record

The controlled CP1.51-G run completed successfully with OpenCode 2.0.20, provider `opencode-go`,
model `longcat-2.5-preview-free`, and agent `build`. The Bridge accepted the single asynchronous
instruction, observed progress over SSE, and reported the same session state through polling. The
requested write paused at `edit=ask`; a human verified the exact operation, path, and content before
granting a one-time (`once`, never `always`) approval. No shell command or second permission was used.

Completion was accepted only after the server reported idle, the observation was complete, and the
Bridge returned `corroborated-success`. The generated file's exact content and digest were verified,
pre-existing laboratory files were unchanged, and the artifact plus all temporary state and processes
were removed. No session IDs, permission IDs, tokens, credentials, or user-specific paths are retained
in this record.

## Known OpenCode 2.0.20 read limitations

The MVP freeze does not correct two read-only compatibility gaps discovered during CP1.51-G:

- `opencode_read_file` targets the legacy `/file/content` route, which returns HTML under the tested
  OpenCode 2.0.20 server instead of the expected JSON contract.
- `opencode_vcs_status` targets the legacy `/vcs` route, which likewise returns HTML under the tested
  OpenCode 2.0.20 server.

The E2E used independent filesystem hashes and Git status/diff evidence for final integrity. These
limitations remain explicit follow-up work and do not weaken the validated permission, SSE, polling,
execution, or completion flow.
