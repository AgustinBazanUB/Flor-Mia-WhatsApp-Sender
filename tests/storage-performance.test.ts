import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { CampaignStore, createCampaignState } from "../src/campaign/campaign-store";
import { CampaignDataStore } from "../src/storage/campaign-data-store";
import { DEFAULT_CAMPAIGN_POLICY } from "../src/campaign/campaign-policy";
import { refreshDailyLimit } from "../src/campaign/daily-limit";
import { validateCampaignInput } from "../src/shared/campaign";
import type { KeyValueStorage } from "../src/storage/state-store";

Object.defineProperty(globalThis, "IDBKeyRange", { value: IDBKeyRange, configurable: true });

class MeasuringStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  writes: number[] = [];
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> {
    this.writes.push(new TextEncoder().encode(JSON.stringify(items)).byteLength);
    this.value = { ...this.value, ...items };
  }
}

function stateFor(count: number) {
  const campaign = validateCampaignInput({
    campaignId: `perf-${count}`,
    campaignName: "Performance",
    createdBy: "tests",
    recipients: Array.from({ length: count }, (_, index) => ({
      recipientId: `r-${index}`,
      clientId: `c-${index}`,
      name: `Cliente ${index}`,
      phone: "5491111111111",
      source: "flor_mia" as const
    })),
    message: "Hola, esto es una prueba 👋",
    images: [],
    imageOrder: [],
    imageCount: 0,
    totalRecipients: count
  });
  return createCampaignState(campaign, DEFAULT_CAMPAIGN_POLICY, refreshDailyLimit(null, 1_000));
}

describe("campaign hot/cold storage performance contract", () => {
  it.each([1, 100, 1000, 5000])("keeps hot write bounded for %i recipients", async (count) => {
    const storage = new MeasuringStorage();
    const store = new CampaignStore(storage, new CampaignDataStore(new IDBFactory()));
    const state = stateFor(count);
    const legacyBytes = new TextEncoder().encode(JSON.stringify({ activeCampaign: state })).byteLength;
    await store.saveActive(state);
    const hotBytes = storage.writes.at(-1) ?? 0;
    console.info(JSON.stringify({ metric: "campaign-storage", count, legacyBytes, hotBytes, reduction: legacyBytes ? 1 - hotBytes / legacyBytes : 0 }));
    expect(hotBytes).toBeLessThan(16 * 1024);
    if (count >= 1000) expect(hotBytes).toBeLessThan(legacyBytes * 0.1);
  });

  it("one recipient transition writes compact hot meta, not the whole recipient list", async () => {
    const storage = new MeasuringStorage();
    const store = new CampaignStore(storage, new CampaignDataStore(new IDBFactory()));
    const state = stateFor(1000);
    await store.saveActive(state);
    storage.writes = [];
    await store.saveActive({
      ...state,
      sequence: state.sequence + 1,
      recipients: state.recipients.map((recipient, index) => index === 0 ? { ...recipient, status: "active" as const } : recipient)
    });
    expect(storage.writes).toHaveLength(1);
    expect(storage.writes[0]).toBeLessThan(16 * 1024);
  });
});
