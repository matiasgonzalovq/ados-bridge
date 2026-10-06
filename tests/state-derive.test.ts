import { describe, expect, it } from "vitest";
import { deriveOperationalState, inactiveForMs, stalledThresholdMs, DEFAULT_STALLED_MS, MIN_STALLED_MS } from "../src/state/derive.js";

const NOW = 1_770_000_000_000;
const MINUTE = 60_000;

function derive(overrides: Partial<Parameters<typeof deriveOperationalState>[0]> = {}) {
  return deriveOperationalState({
    now: NOW,
    rawState: null,
    pendingPermissions: 0,
    pendingQuestions: 0,
    lastActivityAt: NOW - 1_000,
    lastErrorAt: null,
    ...overrides
  });
}

describe("deriveOperationalState", () => {
  it("reports idle when opencode is not busy", () => {
    expect(derive({ rawState: null })).toBe("idle");
    expect(derive({ rawState: "idle" })).toBe("idle");
  });

  it("reports busy when opencode is busy and activity is recent", () => {
    expect(derive({ rawState: "busy", lastActivityAt: NOW - 5_000 })).toBe("busy");
    expect(derive({ rawState: "busy", lastActivityAt: NOW - 119_999 })).toBe("busy");
  });

  it("reports waiting-human when a permission is pending, regardless of raw busy", () => {
    expect(derive({ rawState: "busy", pendingPermissions: 1, lastActivityAt: NOW - 10 * MINUTE })).toBe("waiting-human");
  });

  it("reports waiting-human when a question is pending, regardless of raw busy", () => {
    // Verified live: opencode reports busy while it waits for a question reply.
    expect(derive({ rawState: "busy", pendingQuestions: 1, lastActivityAt: NOW - 10 * MINUTE })).toBe("waiting-human");
    expect(derive({ rawState: "idle", pendingQuestions: 1 })).toBe("waiting-human");
  });

  it("reports stalled when busy past the inactivity threshold", () => {
    expect(derive({ rawState: "busy", lastActivityAt: NOW - 120_000 })).toBe("stalled");
    expect(derive({ rawState: "retry", lastActivityAt: NOW - 10 * MINUTE })).toBe("stalled");
  });

  it("reports stalled when busy with no evidence of activity", () => {
    expect(derive({ rawState: "busy", lastActivityAt: null })).toBe("stalled");
  });

  it("reports error while the newest signal is an error", () => {
    expect(derive({ rawState: null, lastActivityAt: NOW - 1_000, lastErrorAt: NOW })).toBe("error");
    expect(derive({ rawState: "busy", lastActivityAt: NOW - 1_000, lastErrorAt: NOW - 500 })).toBe("error");
  });

  it("clears error once newer activity is observed", () => {
    expect(derive({ rawState: null, lastActivityAt: NOW, lastErrorAt: NOW - 5_000 })).toBe("idle");
    expect(derive({ rawState: "busy", lastActivityAt: NOW, lastErrorAt: NOW - 5_000 })).toBe("busy");
  });

  it("prioritises a pending intervention over a fresh error", () => {
    expect(derive({ rawState: "busy", pendingQuestions: 1, lastActivityAt: NOW, lastErrorAt: NOW })).toBe("waiting-human");
  });
});

describe("stalledThresholdMs", () => {
  it("uses the documented default when unset", () => {
    expect(stalledThresholdMs()).toBe(DEFAULT_STALLED_MS);
    expect(stalledThresholdMs(undefined)).toBe(DEFAULT_STALLED_MS);
    expect(stalledThresholdMs(Number.NaN)).toBe(DEFAULT_STALLED_MS);
  });

  it("never goes below the safety floor", () => {
    expect(stalledThresholdMs(1)).toBe(MIN_STALLED_MS);
    expect(stalledThresholdMs(-5_000)).toBe(MIN_STALLED_MS);
    expect(stalledThresholdMs(500_000)).toBe(500_000);
  });
});

describe("inactiveForMs", () => {
  it("returns null when nothing was observed", () => {
    expect(inactiveForMs(NOW, null)).toBeNull();
  });

  it("returns a non-negative elapsed time", () => {
    expect(inactiveForMs(NOW, NOW - 10_000)).toBe(10_000);
    expect(inactiveForMs(NOW, NOW + 10_000)).toBe(0);
  });
});
