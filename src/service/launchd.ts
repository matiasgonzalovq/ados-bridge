import { dirname, join, resolve } from "node:path";
import type { LaunchdPaths, LaunchdRuntime } from "./launchd-runtime.js";
import { LAUNCHD_LABEL, getLaunchdRuntime } from "./launchd-runtime.js";

const LABEL = LAUNCHD_LABEL;
const SERVICE_PORT = 8790;
const FUNNEL_PORT = 10000;

const HEALTH_TIMEOUT_MS = 1000;
const HEALTH_RETRY_DELAY_MS = 300;
const HEALTH_ATTEMPTS_STATUS = 3;
const HEALTH_ATTEMPTS_INSTALL = 5;
const STATE_POLL_ATTEMPTS = 10;
const STATE_POLL_DELAY_MS = 200;

const TRANSIENT_REPO_ROOTS = [
  /^\/private\/var\/folders(\/|$)/,
  /^\/var\/folders(\/|$)/,
  /^\/private\/tmp(\/|$)/,
  /^\/var\/tmp(\/|$)/,
  /^\/tmp(\/|$)/
];

export type ServiceStatus = {
  label: string;
  plistPath: string;
  installed: boolean;
  loaded: boolean;
  pid?: number;
  lastExitStatus?: number;
  stdoutPath: string;
  stderrPath: string;
  servicePort: number;
  publicUrl?: string;
  connectorUrl?: string;
  healthy: boolean;
};

export type InstallServiceOptions = {
  repoDir: string;
  nodeBin: string;
  tailscaleBin: string;
};

export function getServicePaths(): LaunchdPaths {
  return getLaunchdRuntime().paths();
}

export function connectorUrlFor(publicUrl?: string): string | undefined {
  if (!publicUrl) return undefined;
  return `${publicUrl.replace(/\/+$/, "")}/mcp`;
}

export async function installService(options: InstallServiceOptions): Promise<ServiceStatus> {
  const runtime = getLaunchdRuntime();
  const paths = runtime.paths();
  const repoDir = resolve(options.repoDir);
  assertPersistentRepoDir(repoDir, "Install service aborted");

  await configureTailscaleFunnel(options.tailscaleBin, SERVICE_PORT, runtime);

  await runtime.mkdirp(dirname(paths.plistPath));
  await runtime.mkdirp(dirname(paths.stdoutPath));

  await unloadPreviousAgent(runtime, paths);

  const plist = buildPlist({
    label: LABEL,
    repoDir,
    nodeBin: options.nodeBin,
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    servicePort: SERVICE_PORT
  });
  await runtime.writeFile(paths.plistPath, plist);

  const target = domainTarget(runtime);
  await launchctlStep(runtime, ["bootstrap", target, paths.plistPath], "bootstrap");
  await launchctlStep(runtime, ["kickstart", "-k", `${target}/${LABEL}`], "kickstart");

  await confirmLoaded(runtime, target);
  await waitForPid(runtime, target);

  return await collectStatus(runtime, {
    tailscaleBin: options.tailscaleBin,
    healthAttempts: HEALTH_ATTEMPTS_INSTALL
  });
}

export async function configureTailscaleFunnel(
  tailscaleBin: string,
  servicePort = SERVICE_PORT,
  runtime: LaunchdRuntime = getLaunchdRuntime()
): Promise<string> {
  await runtime.exec(
    tailscaleBin,
    ["funnel", "--bg", "--yes", "--https", String(FUNNEL_PORT), `http://127.0.0.1:${servicePort}`],
    { timeoutMs: 15_000 }
  );
  const publicUrl = await resolvePublicUrl(runtime, tailscaleBin);
  if (!publicUrl) {
    throw new Error("Could not determine Tailscale HTTPS domain. Is Tailscale logged in and HTTPS/Funnel enabled?");
  }
  return publicUrl;
}

export async function unloadService(): Promise<void> {
  const runtime = getLaunchdRuntime();
  const paths = runtime.paths();
  const target = domainTarget(runtime);
  try {
    await runtime.exec("launchctl", ["bootout", `${target}/${LABEL}`]);
  } catch {
    await runtime.exec("launchctl", ["bootout", target, paths.plistPath]);
  }
}

export async function uninstallService(): Promise<ServiceStatus> {
  await unloadService().catch(() => undefined);
  return await getServiceStatus();
}

export async function getServiceStatus(tailscaleBin?: string): Promise<ServiceStatus> {
  return await collectStatus(getLaunchdRuntime(), {
    tailscaleBin,
    healthAttempts: HEALTH_ATTEMPTS_STATUS
  });
}

type CollectStatusOptions = {
  tailscaleBin?: string;
  healthAttempts: number;
};

async function collectStatus(runtime: LaunchdRuntime, options: CollectStatusOptions): Promise<ServiceStatus> {
  const paths = runtime.paths();
  const installed = await runtime
    .readFile(paths.plistPath)
    .then(() => true)
    .catch(() => false);
  const target = domainTarget(runtime);
  const printed = await printAgent(runtime, target);
  const pid = parsePid(printed);
  const publicUrl = await resolvePublicUrl(runtime, options.tailscaleBin);
  const healthy = await isServiceHealthy(runtime, pid, options.healthAttempts);
  return {
    label: LABEL,
    plistPath: paths.plistPath,
    installed,
    loaded: printed.trim().length > 0,
    pid,
    lastExitStatus: parseLastExitStatus(printed),
    stdoutPath: paths.stdoutPath,
    stderrPath: paths.stderrPath,
    servicePort: SERVICE_PORT,
    publicUrl,
    connectorUrl: connectorUrlFor(publicUrl),
    healthy
  };
}

async function unloadPreviousAgent(runtime: LaunchdRuntime, paths: LaunchdPaths): Promise<void> {
  const target = domainTarget(runtime);
  try {
    await runtime.exec("launchctl", ["bootout", `${target}/${LABEL}`]);
  } catch {
    try {
      await runtime.exec("launchctl", ["bootout", target, paths.plistPath]);
    } catch {
      // The agent may never have been loaded; the confirmation below decides.
    }
  }
  const unloaded = await poll(runtime, async () => !(await isAgentLoaded(runtime, target)));
  if (!unloaded) {
    throw new Error("Install service aborted: the previous LaunchAgent is still loaded after bootout");
  }
}

async function confirmLoaded(runtime: LaunchdRuntime, target: string): Promise<void> {
  const loaded = await poll(runtime, async () => await isAgentLoaded(runtime, target));
  if (!loaded) {
    throw new Error("Install service failed: the LaunchAgent never reported loaded after bootstrap");
  }
}

async function waitForPid(runtime: LaunchdRuntime, target: string): Promise<number | undefined> {
  for (let attempt = 1; attempt <= STATE_POLL_ATTEMPTS; attempt += 1) {
    const pid = parsePid(await printAgent(runtime, target));
    if (pid !== undefined) return pid;
    if (attempt < STATE_POLL_ATTEMPTS) await runtime.sleep(STATE_POLL_DELAY_MS);
  }
  return undefined;
}

async function poll(runtime: LaunchdRuntime, check: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 1; attempt <= STATE_POLL_ATTEMPTS; attempt += 1) {
    if (await check()) return true;
    if (attempt < STATE_POLL_ATTEMPTS) await runtime.sleep(STATE_POLL_DELAY_MS);
  }
  return false;
}

async function launchctlStep(runtime: LaunchdRuntime, args: string[], step: string): Promise<void> {
  try {
    await runtime.exec("launchctl", args);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Install service failed: launchctl ${step} failed: ${detail}`);
  }
}

async function isAgentLoaded(runtime: LaunchdRuntime, target: string): Promise<boolean> {
  const printed = await printAgent(runtime, target);
  return printed.trim().length > 0;
}

async function printAgent(runtime: LaunchdRuntime, target: string): Promise<string> {
  return await runtime
    .exec("launchctl", ["print", `${target}/${LABEL}`])
    .then((result) => result.stdout)
    .catch(() => "");
}

function parsePid(printed: string): number | undefined {
  const match = printed.match(/pid = (\d+)/);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

function parseLastExitStatus(printed: string): number | undefined {
  const match = printed.match(/previous exit status = ([-\d]+)/) ?? printed.match(/last exit code = ([-\d]+)/);
  return match?.[1] !== undefined ? Number(match[1]) : undefined;
}

function domainTarget(runtime: LaunchdRuntime): string {
  return `gui/${runtime.uid()}`;
}

async function isServiceHealthy(runtime: LaunchdRuntime, pid: number | undefined, attempts: number): Promise<boolean> {
  if (pid === undefined || !runtime.isPidAlive(pid)) return false;
  const url = `http://127.0.0.1:${SERVICE_PORT}/health`;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await runtime.httpGet(url, HEALTH_TIMEOUT_MS);
      if (response.statusCode === 200 && isHealthPayload(response.body) && runtime.isPidAlive(pid)) {
        return true;
      }
    } catch {
      // Connection refused, timeout, or any transport error: retry inside the bounded budget.
    }
    if (attempt < attempts) await runtime.sleep(HEALTH_RETRY_DELAY_MS);
  }
  return false;
}

function isHealthPayload(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { ok?: unknown } | null;
    return typeof parsed === "object" && parsed !== null && parsed.ok === true;
  } catch {
    return false;
  }
}

function assertPersistentRepoDir(repoDir: string, context: string): void {
  const transient = TRANSIENT_REPO_ROOTS.find((pattern) => pattern.test(repoDir));
  if (transient) {
    throw new Error(`${context}: repo directory appears to be a transient path: ${repoDir}`);
  }
}

async function resolvePublicUrl(runtime: LaunchdRuntime, tailscaleBin?: string): Promise<string | undefined> {
  if (!tailscaleBin) return undefined;
  try {
    const { stdout } = await runtime.exec(tailscaleBin, ["status", "--json"], { timeoutMs: 5000 });
    const status = JSON.parse(stdout) as { CertDomains?: string[]; Self?: { DNSName?: string } };
    const domain = status.CertDomains?.[0] ?? status.Self?.DNSName?.replace(/\.$/, "");
    if (!domain) return undefined;
    return `https://${domain.replace(/\.$/, "")}:${FUNNEL_PORT}`;
  } catch {
    return undefined;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function buildPlist(input: { label: string; repoDir: string; nodeBin: string; stdoutPath: string; stderrPath: string; servicePort: number }): string {
  const cliPath = join(input.repoDir, "dist", "cli.js");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(input.nodeBin)}</string>
    <string>${xmlEscape(cliPath)}</string>
    <string>start</string>
    <string>--tunnel</string>
    <string>none</string>
    <string>--port</string>
    <string>${input.servicePort}</string>
    <string>--auto-port</string>
    <string>false</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(input.repoDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.stderrPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
</dict>
</plist>
`;
}
