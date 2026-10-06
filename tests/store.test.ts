import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/state/store.js";

async function makeStore(): Promise<{ store: StateStore; file: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), "bridge-store-"));
  return { store: new StateStore(stateDir), file: join(stateDir, "sessions.json") };
}

const seed = { opencodeSessionId: "ses_1", repoPath: "/tmp/repo", baseUrl: "http://127.0.0.1:4096" };

describe("StateStore", () => {
  it("persists atomically with owner-only permissions", async () => {
    const { store, file } = await makeStore();
    const session = await store.createSession(seed);

    const info = await stat(file);
    expect(info.mode & 0o777).toBe(0o600);

    const raw = JSON.parse(await readFile(file, "utf8"));
    expect(raw.sessions).toHaveLength(1);
    expect(raw.sessions[0].bridgeSessionId).toBe(session.bridgeSessionId);
  });

  it("refuses to overwrite a corrupted state file", async () => {
    const { store, file } = await makeStore();
    await writeFile(file, "{ this is not json", { mode: 0o600 });

    await expect(store.createSession(seed)).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, "utf8")).toBe("{ this is not json");
  });

  it("keeps every session under concurrent creates", async () => {
    const { store } = await makeStore();
    const sessions = await Promise.all(Array.from({ length: 10 }, () => store.createSession(seed)));

    expect(new Set(sessions.map((s) => s.bridgeSessionId)).size).toBe(10);
    expect(await store.listSessions()).toHaveLength(10);
  });

  it("updates sessions without losing fields", async () => {
    const { store } = await makeStore();
    const session = await store.createSession(seed);
    const updated = await store.updateSession(session.bridgeSessionId, { title: "renamed" });

    expect(updated.title).toBe("renamed");
    expect(updated.repoPath).toBe(seed.repoPath);
    expect(updated.createdAt).toBe(session.createdAt);
  });

  it("rejects unknown session ids", async () => {
    const { store } = await makeStore();
    await expect(store.getSession("missing")).rejects.toThrow(/Unknown bridge session/);
  });
});
