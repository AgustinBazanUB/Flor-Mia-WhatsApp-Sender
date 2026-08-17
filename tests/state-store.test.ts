import { describe, expect, it } from "vitest";
import { StateStore, createDefaultState, type KeyValueStorage } from "../src/storage/state-store";

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

describe("state storage", () => {
  it("initializes an extensible local state", () => {
    const state = createDefaultState("2026-08-15T00:00:00.000Z");
    expect(state.status).toBe("idle");
    expect(state.currentCampaign).toBeNull();
    expect(state.lastCheckpoint).toBeNull();
    expect(state.schemaVersion).toBe(7);
    expect(state.extensionVersion).toBe("unknown");
    expect(state.config.retryPolicy.maxAttemptsPerStep).toBe(3);
    expect(state.config.campaignPolicy).toMatchObject({
      contactsPerBatch: 3,
      delayBetweenBatchesMs: 15_000,
      dailyContactLimit: 1_000
    });
    expect(state.dailyLimit).toMatchObject({ completedToday: 0, limit: 1_000, remaining: 1_000 });
    expect(state.compatibility).toMatchObject({
      schemaVersion: 2,
      overallStatus: "RED",
      lastKnownGoodExtensionVersion: null,
      lastKnownGood: {}
    });
    expect(state.diagnosticIncident).toBeNull();
    expect(state.serviceWorkerRecovery).toBeNull();
    expect(state.config.webAppOrigins).toContain("https://app-integral-fm.netlify.app");
  });

  it("migrates older stored configuration with all retry defaults", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      extensionState: {
        ...createDefaultState(),
        schemaVersion: 1,
        compatibility: {
          ...createDefaultState().compatibility,
          schemaVersion: 1,
          lastKnownGoodExtensionVersion: undefined
        },
        config: { diagnosticTimeoutMs: 2_000 }
      }
    };
    const state = await new StateStore(storage).load();
    expect(state.schemaVersion).toBe(7);
    expect(state.config.diagnosticTimeoutMs).toBe(2_000);
    expect(state.config.retryPolicy.timeouts.previewMs).toBeGreaterThan(0);
    expect(state.config.campaignPolicy.whatsappLoadWaitMs).toBe(30_000);
    expect(state.compatibility.schemaVersion).toBe(2);
    expect(state.compatibility.lastKnownGoodExtensionVersion).toBeNull();
  });

  it("does not crash when embedded legacy compatibility metadata is incomplete", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      extensionState: {
        ...createDefaultState(),
        compatibility: {
          schemaVersion: 1,
          overallStatus: "GREEN",
          lastKnownGood: {
            composer: {
              capability: "composer",
              extensionVersion: "0.8.0",
              selectedStrategy: "old-selector"
            }
          },
          developmentFault: "none"
        }
      }
    };

    const state = await new StateStore(storage).load();

    expect(state.schemaVersion).toBe(7);
    expect(state.compatibility.schemaVersion).toBe(2);
    expect(state.compatibility.lastKnownGood).toEqual({});
    expect(state.compatibility.lastKnownGoodExtensionVersion).toBeNull();
  });

  it("persists transitions and limits operation history", async () => {
    const storage = new MemoryStorage();
    const store = new StateStore(storage);
    await store.save(createDefaultState());
    await store.transition("preflight");
    await store.transition("ready");
    for (let index = 0; index < 25; index += 1) {
      await store.appendOperation({
        operationId: `operation-${index}`, kind: "diagnostic", success: true,
        startedAt: new Date().toISOString(), completedAt: new Date().toISOString()
      });
    }
    const state = await store.load();
    expect(state.status).toBe("ready");
    expect(state.operations).toHaveLength(20);
    expect(state.operations[0]?.operationId).toBe("operation-5");
  });

  it("drops a legacy full campaign copy from extensionState", async () => {
    const storage = new MemoryStorage();
    storage.value = {
      extensionState: {
        ...createDefaultState(),
        schemaVersion: 6,
        activeCampaign: {
          schemaVersion: 1,
          campaignId: "legacy-campaign",
          text: "private message",
          recipients: [{ recipientId: "r-1", phoneDigits: "5491111111111" }],
          images: [],
          status: "paused"
        }
      }
    };
    const store = new StateStore(storage);
    const migrated = await store.load();
    expect(migrated.activeCampaign).toBeNull();
    await store.save(migrated);
    expect(JSON.stringify(storage.value.extensionState)).not.toContain("private message");
    expect(JSON.stringify(storage.value.extensionState)).not.toContain("phoneDigits");
  });
});