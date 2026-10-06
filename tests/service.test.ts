import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getServicePaths, getServiceStatus, installService, uninstallService } from "../src/service/launchd.js";
import {
  createNodeLaunchdRuntime,
  resetLaunchdRuntime,
  setLaunchdRuntime,
  type LaunchdPaths,
  type LaunchdRuntime
} from "../src/service/launchd-runtime.js";

const LABEL = "com.yuga.opencode-chatgpt-bridge";
const HEALTH_URL = "http://127.0.0.1:8790/health";
const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const NODE_BIN = "/usr/local/bin/node";
const TAILSCALE_BIN = "tailscale";

type HealthMode = "ok" | "refused" | "timeout" | "http-500" | "invalid-json" | "not-ok";

type FakeLaunchdOptions = {
  loaded?: boolean;
  initialDefinition?: string;
  pid?: number;
  bootout?: "ok" | "fail";
  bootstrap?: "ok" | "fail";
  kickstart?: "ok" | "fail";
  pidAlive?: boolean;
  health?: HealthMode;
};

type ExecCall = { file: string; args: string[] };

type FakeLaunchd = {
  runtime: LaunchdRuntime;
  paths: LaunchdPaths;
  events: string[];
  execCalls: ExecCall[];
  healthUrls: string[];
  files: Map<string, string>;
  definition(): string | undefined;
};

async function createFakeLaunchd(options: FakeLaunchdOptions = {}): Promise<FakeLaunchd> {
  const root = await mkdtemp(join(tmpdir(), "bridge-launchd-fake-"));
  const paths: LaunchdPaths = {
    plistPath: join(root, "Library", "LaunchAgents", `${LABEL}.plist`),
    stdoutPath: join(root, "bridge.log"),
    stderrPath: join(root, "bridge.err.log")
  };
  const events: string[] = [];
  const execCalls: ExecCall[] = [];
  const healthUrls: string[] = [];
  const files = new Map<string, string>();
  const pid = "pid" in options ? options.pid : 4321;
  const pidAlive = options.pidAlive ?? true;
  let loaded = options.loaded ?? false;
  let definition = options.initialDefinition;

  const runtime: LaunchdRuntime = {
    paths: () => paths,
    uid: () => 501,
    async exec(file, args) {
      events.push(file === "launchctl" ? `launchctl ${args[0] ?? ""}` : `${file} ${args[0] ?? ""}`.trim());
      execCalls.push({ file, args });
      if (file === "launchctl") {
        const command = args[0];
        if (command === "bootout") {
          if ((options.bootout ?? "ok") === "fail") {
            throw new Error("launchctl bootout failed: 3: No such process");
          }
          loaded = false;
          definition = undefined;
          return { stdout: "", stderr: "" };
        }
        if (command === "bootstrap") {
          if (options.bootstrap === "fail") {
            throw new Error("launchctl bootstrap failed: 5: Input/output error");
          }
          const written = files.get(paths.plistPath);
          if (written === undefined) {
            throw new Error("launchctl bootstrap failed: no such file or directory");
          }
          loaded = true;
          definition = written;
          return { stdout: "", stderr: "" };
        }
        if (command === "kickstart") {
          if (options.kickstart === "fail") {
            throw new Error("launchctl kickstart failed: service is malformed");
          }
          if (!loaded) {
            throw new Error("launchctl kickstart failed: could not find service");
          }
          return { stdout: "", stderr: "" };
        }
        if (command === "print") {
          if (!loaded) {
            throw new Error(`Could not find service "${args[1] ?? ""}"`);
          }
          const pidLine = pid === undefined ? "" : `\tpid = ${pid}\n`;
          return { stdout: `service = ${LABEL}\n${pidLine}\tstate = running\n`, stderr: "" };
        }
        throw new Error(`unexpected launchctl subcommand: ${command}`);
      }
      if (file === TAILSCALE_BIN) {
        if (args[0] === "status") {
          return { stdout: JSON.stringify({ CertDomains: ["bridge.example.ts.net"] }), stderr: "" };
        }
        return { stdout: "", stderr: "" };
      }
      throw new Error(`unexpected executable: ${file}`);
    },
    async readFile(path) {
      events.push(`read ${path}`);
      const content = files.get(path);
      if (content === undefined) {
        throw Object.assign(new Error(`ENOENT: no such file or directory ${path}`), { code: "ENOENT" });
      }
      return content;
    },
    async writeFile(path, data) {
      events.push(`write ${path}`);
      files.set(path, data);
    },
    async mkdirp(path) {
      events.push(`mkdir ${path}`);
    },
    async sleep() {
      // Polling and retry delays are instantaneous under test.
    },
    async httpGet(url, timeoutMs) {
      events.push(`health ${url}`);
      healthUrls.push(url);
      const mode = options.health ?? "ok";
      if (mode === "refused") {
        throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8790"), { code: "ECONNREFUSED" });
      }
      if (mode === "timeout") {
        throw new Error(`health check timed out after ${timeoutMs}ms`);
      }
      if (mode === "http-500") {
        return { statusCode: 500, body: "internal server error" };
      }
      if (mode === "invalid-json") {
        return { statusCode: 200, body: "<html>definitely not json</html>" };
      }
      if (mode === "not-ok") {
        return { statusCode: 200, body: JSON.stringify({ ok: false }) };
      }
      return { statusCode: 200, body: JSON.stringify({ ok: true, name: "opencode-chatgpt-bridge" }) };
    },
    isPidAlive: () => pidAlive
  };

  return {
    runtime,
    paths,
    events,
    execCalls,
    healthUrls,
    files,
    definition: () => definition
  };
}

async function useFake(options: FakeLaunchdOptions = {}): Promise<FakeLaunchd> {
  const fake = await createFakeLaunchd(options);
  setLaunchdRuntime(fake.runtime);
  return fake;
}

function installOptions(repoDir: string) {
  return { repoDir, nodeBin: NODE_BIN, tailscaleBin: TAILSCALE_BIN };
}

function eventIndex(events: string[], needle: string): number {
  return events.findIndex((event) => event.includes(needle));
}

afterEach(() => {
  resetLaunchdRuntime();
});

describe("installService lifecycle", () => {
  it("installs a fresh agent and reports healthy only after /health answers", async () => {
    const fake = await useFake({ pid: 4321, health: "ok" });
    const status = await installService(installOptions(repoRoot));

    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(true);
    expect(status.pid).toBe(4321);
    expect(status.healthy).toBe(true);
    expect(status.servicePort).toBe(8790);
    expect(fake.healthUrls).toEqual([HEALTH_URL]);

    const bootoutAt = eventIndex(fake.events, "launchctl bootout");
    const bootstrapAt = eventIndex(fake.events, "launchctl bootstrap");
    const kickstartAt = eventIndex(fake.events, "launchctl kickstart");
    const healthAt = eventIndex(fake.events, `health ${HEALTH_URL}`);
    expect(bootoutAt).toBeGreaterThanOrEqual(0);
    expect(bootstrapAt).toBeGreaterThan(bootoutAt);
    expect(kickstartAt).toBeGreaterThan(bootstrapAt);
    expect(healthAt).toBeGreaterThan(kickstartAt);
  });

  it("replaces a previously loaded agent with the new definition", async () => {
    const fake = await useFake({
      loaded: true,
      pid: 1111,
      initialDefinition: "/old/bridge-repo/dist/cli.js",
      health: "ok"
    });
    const status = await installService(installOptions("/Users/shared/bridge-repo"));

    expect(fake.definition()).toContain("/Users/shared/bridge-repo/dist/cli.js");
    expect(fake.definition()).not.toContain("/old/bridge-repo");
    expect(status.loaded).toBe(true);

    const bootoutAt = eventIndex(fake.events, "launchctl bootout");
    const bootstrapAt = eventIndex(fake.events, "launchctl bootstrap");
    expect(bootoutAt).toBeGreaterThanOrEqual(0);
    expect(bootstrapAt).toBeGreaterThan(bootoutAt);
  });

  it("still installs when bootout fails because the agent was already gone", async () => {
    const fake = await useFake({ loaded: false, bootout: "fail", pid: 4321, health: "ok" });
    const status = await installService(installOptions(repoRoot));

    expect(status.healthy).toBe(true);
    const bootouts = fake.execCalls.filter((call) => call.file === "launchctl" && call.args[0] === "bootout");
    expect(bootouts.length).toBe(2);
  });

  it("aborts when the previous agent is still loaded after bootout", async () => {
    const fake = await useFake({ loaded: true, bootout: "fail", pid: 1111, health: "ok" });

    await expect(installService(installOptions(repoRoot))).rejects.toThrow(
      "previous LaunchAgent is still loaded after bootout"
    );
    expect(fake.execCalls.some((call) => call.args[0] === "bootstrap")).toBe(false);
    expect(fake.healthUrls).toEqual([]);
  });

  it("fails when launchctl bootstrap fails and never claims health", async () => {
    const fake = await useFake({ bootstrap: "fail", health: "ok" });

    await expect(installService(installOptions(repoRoot))).rejects.toThrow("launchctl bootstrap failed");
    expect(fake.execCalls.some((call) => call.args[0] === "kickstart")).toBe(false);
    expect(fake.healthUrls).toEqual([]);
  });

  it("fails when launchctl kickstart fails", async () => {
    const fake = await useFake({ kickstart: "fail", health: "ok" });

    await expect(installService(installOptions(repoRoot))).rejects.toThrow("launchctl kickstart failed");
    expect(fake.healthUrls).toEqual([]);
  });

  it("reports loaded but not healthy when no PID ever appears", async () => {
    const fake = await useFake({ pid: undefined, health: "ok" });
    const status = await installService(installOptions(repoRoot));

    expect(status.installed).toBe(true);
    expect(status.loaded).toBe(true);
    expect(status.pid).toBeUndefined();
    expect(status.healthy).toBe(false);
    expect(fake.healthUrls).toEqual([]);
  });

  it("keeps loaded:true with healthy:false when the port refuses the connection", async () => {
    const fake = await useFake({ pid: 4321, health: "refused" });
    const status = await installService(installOptions(repoRoot));

    expect(status.loaded).toBe(true);
    expect(status.pid).toBe(4321);
    expect(status.healthy).toBe(false);
    expect(fake.healthUrls.length).toBeGreaterThan(1);
    expect(fake.healthUrls.length).toBeLessThanOrEqual(5);
    expect(fake.healthUrls.every((url) => url === HEALTH_URL)).toBe(true);
  });

  it("reports healthy:false when /health times out", async () => {
    const fake = await useFake({ pid: 4321, health: "timeout" });
    const status = await installService(installOptions(repoRoot));

    expect(status.loaded).toBe(true);
    expect(status.healthy).toBe(false);
    expect(fake.healthUrls.length).toBeGreaterThan(1);
    expect(fake.healthUrls.length).toBeLessThanOrEqual(5);
  });

  it.each([
    ["an HTTP 500 response", "http-500"],
    ["a payload without ok:true", "not-ok"],
    ["a non-JSON body", "invalid-json"]
  ] as const)("reports healthy:false when /health returns %s", async (_label, mode) => {
    const fake = await useFake({ pid: 4321, health: mode });
    const status = await installService(installOptions(repoRoot));

    expect(status.loaded).toBe(true);
    expect(status.healthy).toBe(false);
  });

  it("reports healthy:false when the process vanished before the health probe", async () => {
    const fake = await useFake({ pid: 4321, pidAlive: false, health: "ok" });
    const status = await installService(installOptions(repoRoot));

    expect(status.loaded).toBe(true);
    expect(status.pid).toBe(4321);
    expect(status.healthy).toBe(false);
    expect(fake.healthUrls).toEqual([]);
  });
});

describe("service status", () => {
  it("reports healthy when the running agent answers /health", async () => {
    const fake = await useFake({ loaded: true, pid: 999, health: "ok" });
    const status = await getServiceStatus(TAILSCALE_BIN);

    expect(status.installed).toBe(false);
    expect(status.loaded).toBe(true);
    expect(status.pid).toBe(999);
    expect(status.healthy).toBe(true);
    expect(status.publicUrl).toBe("https://bridge.example.ts.net:10000");
    expect(status.connectorUrl).toBe("https://bridge.example.ts.net:10000/mcp");
    expect(status.connectorUrl).not.toContain("token");
    expect(fake.healthUrls).toEqual([HEALTH_URL]);
  });

  it("reports installed:false and healthy:false for a missing plist and dead agent", async () => {
    const fake = await useFake({ loaded: false });
    const status = await getServiceStatus();

    expect(status.installed).toBe(false);
    expect(status.loaded).toBe(false);
    expect(status.healthy).toBe(false);
    expect(fake.healthUrls).toEqual([]);
  });

  it("uninstall unloads the agent and reports it as not loaded", async () => {
    const fake = await useFake({ loaded: true, pid: 1111, health: "ok" });
    const status = await uninstallService();

    expect(status.loaded).toBe(false);
    expect(status.healthy).toBe(false);
    expect(fake.execCalls.some((call) => call.args[0] === "bootout")).toBe(true);
  });
});

describe("persistent path regression", () => {
  it("rejects a /private/var/folders/.../T/... repoDir before touching launchctl", async () => {
    const fake = await useFake();

    await expect(
      installService(installOptions("/private/var/folders/ab/cd/T/bridge-cli-EG8fQI"))
    ).rejects.toThrow("repo directory appears to be a transient path");
    expect(fake.execCalls).toEqual([]);
    expect(fake.events.filter((event) => event.startsWith("write "))).toEqual([]);
  });

  it("rejects /tmp, /var/tmp and macOS temp directories as repoDir", async () => {
    const fake = await useFake();
    const transient = [
      "/tmp/bridge-repo",
      "/var/tmp/bridge-repo",
      "/private/tmp/bridge-repo",
      "/var/folders/xy/zt/T/bridge-repo"
    ];

    for (const repoDir of transient) {
      await expect(installService(installOptions(repoDir))).rejects.toThrow(
        "repo directory appears to be a transient path"
      );
    }
    expect(fake.execCalls).toEqual([]);
  });

  it("writes ProgramArguments that point at the persistent dist/cli.js of the repo", async () => {
    const fake = await useFake({ pid: 4321, health: "ok" });
    await installService(installOptions(repoRoot));

    const plist = fake.files.get(fake.paths.plistPath);
    expect(plist).toBeDefined();
    expect(plist).toContain(`<string>${NODE_BIN}</string>`);
    expect(plist).toContain(`<string>${join(repoRoot, "dist", "cli.js")}</string>`);
    expect(plist).toContain(`<string>${repoRoot}</string>`);
    expect(plist).toContain("<key>KeepAlive</key>");
    expect(plist).not.toContain("bridge-cli-");
  });

  it("reinstall rewrites the previous plist with the new repo path", async () => {
    const fake = await useFake({ pid: 4321, health: "ok" });
    await installService(installOptions("/Users/shared/bridge-repo-a"));
    await installService(installOptions("/Users/shared/bridge-repo-b"));

    const plist = fake.files.get(fake.paths.plistPath);
    expect(plist).toContain("/Users/shared/bridge-repo-b/dist/cli.js");
    expect(plist).not.toContain("/Users/shared/bridge-repo-a");
    expect(fake.execCalls.filter((call) => call.args[0] === "bootout").length).toBeGreaterThanOrEqual(2);
    expect(fake.execCalls.filter((call) => call.args[0] === "bootstrap").length).toBe(2);
  });
});

describe("test isolation", () => {
  it("drives the whole lifecycle through the injected fake, never the real LaunchAgents directory", async () => {
    const fake = await useFake({ pid: 4321, health: "ok" });

    await installService(installOptions(repoRoot));
    await getServiceStatus(TAILSCALE_BIN);
    await uninstallService();

    expect(fake.execCalls.filter((call) => call.file === "launchctl").length).toBeGreaterThan(0);
    expect([...fake.files.keys()]).toEqual([fake.paths.plistPath]);

    const realPlistPath = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    expect(getServicePaths().plistPath).not.toBe(realPlistPath);
    expect(fake.files.has(realPlistPath)).toBe(false);
  });

  it("the real runtime refuses to reach launchctl, LaunchAgents or a socket under vitest", async () => {
    expect(process.env.VITEST).toBeTruthy();
    const runtime = createNodeLaunchdRuntime();

    await expect(runtime.exec("launchctl", ["print", `gui/501/${LABEL}`])).rejects.toThrow("during tests");
    await expect(runtime.readFile(runtime.paths().plistPath)).rejects.toThrow("during tests");
    await expect(runtime.writeFile(runtime.paths().plistPath, "<plist/>")).rejects.toThrow("during tests");
    await expect(runtime.httpGet(HEALTH_URL, 100)).rejects.toThrow("during tests");
    await expect(runtime.httpGet("http://example.com/health", 100)).rejects.toThrow("restricted to 127.0.0.1");
  });
});
