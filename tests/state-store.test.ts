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
    expect(state.config.webAppOrigins).toContain("https://app-integral-fm.netlify.app");
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
});
