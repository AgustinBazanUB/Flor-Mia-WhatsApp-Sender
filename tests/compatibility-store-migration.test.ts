import { describe, expect, it } from "vitest";
import { CompatibilityStore, COMPATIBILITY_STATE_KEY } from "../src/storage/compatibility-store";
import type { KeyValueStorage } from "../src/storage/state-store";

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

describe("compatibility storage migration", () => {
  it("recovers from a legacy lastKnownGood entry missing lastWorkingAt instead of crashing initialization", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      [COMPATIBILITY_STATE_KEY]: {
        schemaVersion: 1,
        overallStatus: "GREEN",
        lastKnownGood: {
          composer: {
            capability: "composer",
            extensionVersion: "0.8.0",
            selectedStrategy: "legacy-composer"
          }
        },
        developmentFault: "none"
      }
    };

    const state = await new CompatibilityStore(storage).load();

    expect(state.schemaVersion).toBe(2);
    expect(state.lastKnownGood).toEqual({});
    expect(state.lastKnownGoodExtensionVersion).toBeNull();
    expect(state.developmentFault).toBe("none");
  });

  it("sanitizes malformed schema 2 metadata instead of trusting a superficially valid object", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      [COMPATIBILITY_STATE_KEY]: {
        schemaVersion: 2,
        overallStatus: "GREEN",
        checkedAt: 123,
        lastKnownGoodExtensionVersion: null,
        lastKnownGood: { composer: { lastWorkingAt: null } },
        lastPreflight: { failures: "invalid" },
        driftHistory: [{ capability: "not-real", detectedAt: 1 }],
        lastFailure: { capability: "composer" },
        developmentFault: "invalid-fault",
        updatedAt: null
      }
    };

    const state = await new CompatibilityStore(storage).load();

    expect(state.schemaVersion).toBe(2);
    expect(state.overallStatus).toBe("GREEN");
    expect(state.checkedAt).toBeNull();
    expect(state.lastKnownGood).toEqual({});
    expect(state.lastPreflight).toBeNull();
    expect(state.driftHistory).toEqual([]);
    expect(state.lastFailure).toBeNull();
    expect(state.developmentFault).toBe("none");
  });
});
