import { describe, expect, it } from "vitest";
import { DailyLimitStore, incrementDailyLimit, refreshDailyLimit } from "../src/campaign/daily-limit";
import type { KeyValueStorage } from "../src/storage/state-store";

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

describe("daily contact limit", () => {
  it("keeps the same-day count and recalculates remaining capacity", () => {
    const now = new Date(2026, 7, 15, 10, 0, 0);
    const state = refreshDailyLimit({
      localDate: "2026-08-15",
      completedToday: 7,
      limit: 10,
      remaining: 3,
      countedContactKeys: ["campaign:contact-1"],
      updatedAt: now.toISOString()
    }, 10, now);
    expect(state).toMatchObject({ completedToday: 7, remaining: 3, limit: 10 });
  });

  it("resets safely when the local calendar day changes", () => {
    const state = refreshDailyLimit({
      localDate: "2026-08-14",
      completedToday: 1_000,
      limit: 1_000,
      remaining: 0,
      countedContactKeys: ["old"],
      updatedAt: "2026-08-14T23:59:00.000Z"
    }, 1_000, new Date(2026, 7, 15, 0, 1, 0));
    expect(state).toMatchObject({ localDate: "2026-08-15", completedToday: 0, remaining: 1_000 });
    expect(state.countedContactKeys).toEqual([]);
  });

  it("counts a completed contact idempotently", () => {
    const base = refreshDailyLimit(null, 2, new Date(2026, 7, 15, 10, 0, 0));
    const once = incrementDailyLimit(base, "campaign:contact-1", new Date(2026, 7, 15, 10, 1, 0));
    const duplicate = incrementDailyLimit(once, "campaign:contact-1", new Date(2026, 7, 15, 10, 2, 0));
    expect(duplicate.completedToday).toBe(1);
    expect(duplicate.remaining).toBe(1);
  });

  it("survives a repository and Service Worker instance restart", async () => {
    const storage = new MemoryStorage();
    const now = new Date(2026, 7, 15, 10, 0, 0);
    await new DailyLimitStore(storage).recordCompletion(1_000, "campaign:contact-1", now);
    const rehydrated = await new DailyLimitStore(storage).load(1_000, new Date(2026, 7, 15, 11, 0, 0));
    expect(rehydrated).toMatchObject({ completedToday: 1, remaining: 999, localDate: "2026-08-15" });
  });
});
