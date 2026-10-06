import { execFile } from "node:child_process";
import { get as httpGet, type ClientRequest } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const LAUNCHD_LABEL = "com.yuga.opencode-chatgpt-bridge";

export type LaunchdPaths = {
  plistPath: string;
  stdoutPath: string;
  stderrPath: string;
};

export type LaunchdExecResult = {
  stdout: string;
  stderr: string;
};

export type LaunchdHealthResponse = {
  statusCode: number;
  body: string;
};

/**
 * Every external effect the launchd lifecycle needs: process execution,
 * filesystem access, the health probe, sleeping, and liveness checks.
 * Tests inject a fake so `pnpm test` never reaches launchctl, the real
 * LaunchAgents directory, or a real HTTP socket.
 */
export type LaunchdRuntime = {
  paths(): LaunchdPaths;
  uid(): number;
  exec(file: string, args: string[], options?: { timeoutMs?: number }): Promise<LaunchdExecResult>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  mkdirp(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  httpGet(url: string, timeoutMs: number): Promise<LaunchdHealthResponse>;
  isPidAlive(pid: number): boolean;
};

function assertRealRuntimeAllowed(operation: string): void {
  if (process.env.VITEST) {
    throw new Error(
      `Refused to ${operation} through the real LaunchdRuntime during tests. ` +
        "Inject a fake with setLaunchdRuntime() so pnpm test never touches launchctl or ~/Library/LaunchAgents."
    );
  }
}

export function createNodeLaunchdRuntime(): LaunchdRuntime {
  return {
    paths(): LaunchdPaths {
      const stateDir = join(homedir(), ".opencode-chatgpt-bridge");
      return {
        plistPath: join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
        stdoutPath: join(stateDir, "bridge.log"),
        stderrPath: join(stateDir, "bridge.err.log")
      };
    },
    uid(): number {
      return process.getuid?.() ?? 0;
    },
    async exec(file: string, args: string[], options?: { timeoutMs?: number }): Promise<LaunchdExecResult> {
      assertRealRuntimeAllowed(`run \`${file}\``);
      const { stdout, stderr } = await execFileAsync(file, args, { timeout: options?.timeoutMs ?? 15_000 });
      return { stdout: String(stdout), stderr: String(stderr) };
    },
    async readFile(path: string): Promise<string> {
      assertRealRuntimeAllowed(`read ${path}`);
      return await readFile(path, "utf8");
    },
    async writeFile(path: string, data: string): Promise<void> {
      assertRealRuntimeAllowed(`write ${path}`);
      await writeFile(path, data, "utf8");
    },
    async mkdirp(path: string): Promise<void> {
      assertRealRuntimeAllowed(`create ${path}`);
      await mkdir(path, { recursive: true });
    },
    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
    async httpGet(url: string, timeoutMs: number): Promise<LaunchdHealthResponse> {
      const { hostname } = new URL(url);
      if (hostname !== "127.0.0.1") {
        throw new Error(`Health checks are restricted to 127.0.0.1 (got ${hostname})`);
      }
      assertRealRuntimeAllowed(`send a health request to ${url}`);
      return await new Promise<LaunchdHealthResponse>((resolve, reject) => {
        const request: ClientRequest = httpGet(url, { timeout: timeoutMs }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => {
            if (body.length <= 8192) body += chunk;
          });
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body }));
        });
        request.on("timeout", () => {
          request.destroy(new Error(`health check timed out after ${timeoutMs}ms`));
        });
        request.on("error", reject);
      });
    },
    isPidAlive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }
  };
}

let activeRuntime: LaunchdRuntime | undefined;
let defaultRuntime: LaunchdRuntime | undefined;

export function getLaunchdRuntime(): LaunchdRuntime {
  if (activeRuntime) return activeRuntime;
  defaultRuntime ??= createNodeLaunchdRuntime();
  return defaultRuntime;
}

export function setLaunchdRuntime(runtime: LaunchdRuntime): void {
  activeRuntime = runtime;
}

export function resetLaunchdRuntime(): void {
  activeRuntime = undefined;
}
