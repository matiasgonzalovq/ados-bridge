import { describe, expect, it } from "vitest";
import { getSetupGuide } from "../src/setupGuide.js";
import type { BridgeConfig } from "../src/types.js";

const TOKEN = "abcd1234secret9876wxyz";

const config: BridgeConfig = {
  host: "127.0.0.1",
  port: 8787,
  autoPort: true,
  allowedHosts: ["127.0.0.1", "localhost"],
  allowedRoots: ["/tmp/repos"],
  bridgeToken: TOKEN,
  checkpoints: true,
  opencodeBin: "opencode",
  opencodeHost: "127.0.0.1",
  opencodePortStart: 4096,
  opencodeUsername: "opencode",
  stateDir: "/tmp/state",
  tunnel: "cloudflare",
  tailscaleBin: "/usr/bin/tailscale",
  cloudflaredBin: "cloudflared"
};

const base = {
  config,
  localUrl: "http://127.0.0.1:8787",
  publicUrl: "https://example.trycloudflare.com",
  opencodeStatus: { installed: true, version: "1.17.7", path: "/usr/local/bin/opencode" }
};

describe("setup guide", () => {
  it("prints ChatGPT and opencode setup details", () => {
    const guide = getSetupGuide(base);

    expect(guide).toContain("Settings -> Apps & Connectors");
    expect(guide).toContain("Connector URL: https://example.trycloudflare.com/mcp");
    expect(guide).toContain("opencode: installed");
    expect(guide).toContain("opencode serve");
  });

  it("keeps the token masked and prefers header auth by default", () => {
    const guide = getSetupGuide(base);

    expect(guide.includes(TOKEN)).toBe(false);
    expect(guide).toContain("Bearer token: abcd…wxyz");
    expect(guide).toContain("Header auth (preferred): Authorization: Bearer");
    expect(guide).toContain("show-token");
    expect(guide).not.toContain(`?token=${TOKEN}`);
    expect(guide).not.toContain(`/mcp/${TOKEN}`);
  });

  it("never prints URL-token variants; only the show-token command documents them", () => {
    const guide = getSetupGuide(base);

    expect(guide).not.toContain(`https://example.trycloudflare.com/mcp/${TOKEN}`);
    expect(guide).not.toContain(`https://example.trycloudflare.com/mcp?token=${TOKEN}`);
    expect(guide).toContain("URL-token fallback: never printed here.");
    expect(guide).toContain("opencode-chatgpt-bridge show-token");
  });

  it("reports a missing token without leaking anything", () => {
    const guide = getSetupGuide({ ...base, config: { ...config, bridgeToken: undefined } });

    expect(guide).toContain("Bearer token: NOT SET");
    expect(guide.includes(TOKEN)).toBe(false);
  });
});
