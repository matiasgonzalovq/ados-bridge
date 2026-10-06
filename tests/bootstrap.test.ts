import { mkdtemp, readFile, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initEnv, checkEnvFileMode } from "../src/config/bootstrap.js";

describe("initEnv", () => {
  it("creates a ready-to-use env file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-init-"));
    const envPath = join(dir, ".env");
    const result = await initEnv({ envPath, allowedRoots: [dir] });
    const content = await readFile(envPath, "utf8");
    const mode = (await stat(envPath)).mode & 0o777;

    expect(result.created).toBe(true);
    expect(result.token.length).toBeGreaterThan(20);
    expect(content).toContain("OPENCODE_BRIDGE_TOKEN=");
    expect(content).toContain("OPENCODE_BRIDGE_TUNNEL=tailscale");
    expect(content).toContain(dir);
    expect(mode).toBe(0o600);
  });
});

describe("checkEnvFileMode", () => {
  it("reports ok when mode is 0600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-mode-"));
    const envPath = join(dir, ".env");
    await initEnv({ envPath, allowedRoots: [dir] });
    const report = await checkEnvFileMode(envPath);
    expect(report.ok).toBe(true);
    expect(report.mode).toBe(0o600);
  });

  it("reports ok=false when mode allows group/other read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bridge-mode-bad-"));
    const envPath = join(dir, ".env");
    await initEnv({ envPath, allowedRoots: [dir] });
    await chmod(envPath, 0o644);
    const report = await checkEnvFileMode(envPath);
    expect(report.ok).toBe(false);
    expect(report.mode).toBe(0o644);
  });
});
