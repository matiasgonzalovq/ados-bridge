import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { connectorUrlFor } from "../src/service/launchd.js";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tsx = join(repoRoot, "node_modules", ".bin", "tsx");
const cli = join(repoRoot, "src", "cli.ts");
const TOKEN = "tok_f0_secret_value_do_not_leak_1234";

type RunResult = { stdout: string; stderr: string; code: number };

async function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<RunResult> {
  // cwd is an empty temp dir so the developer's local .env can never leak into the test.
  const cwd = await mkdtemp(join(tmpdir(), "bridge-cli-"));
  try {
    const { stdout, stderr } = await execFileAsync(tsx, [cli, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...env },
      timeout: 30_000
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.code ?? 1 };
  }
}

describe("token hygiene", () => {
  it("show-token is the only way to print the raw value", async () => {
    const result = await runCli(["show-token"], { OPENCODE_BRIDGE_TOKEN: TOKEN });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(`${TOKEN}\n`);
    expect(result.stderr).toContain("explicitly");
  }, 30_000);

  it("show-token fails cleanly when no token is configured", async () => {
    const result = await runCli(["show-token"], {});

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No bridge token configured");
  }, 30_000);

  it("doctor never prints the raw token or token URLs", async () => {
    const result = await runCli(["doctor"], { OPENCODE_BRIDGE_TOKEN: TOKEN });

    expect(result.stdout).not.toContain(TOKEN);
    expect(result.stdout).not.toContain(`?token=${TOKEN}`);
    expect(result.stdout).not.toContain(`/mcp/${TOKEN}`);
    expect(result.stdout).toContain("Bearer token:");
    expect(result.stdout).toContain("show-token");
  }, 30_000);

  it("connector status URL never embeds the token", () => {
    expect(connectorUrlFor("https://example.ts.net")).toBe("https://example.ts.net/mcp");
    expect(connectorUrlFor("https://example.ts.net")).not.toContain(TOKEN);
    expect(connectorUrlFor(undefined)).toBeUndefined();
  });
});
