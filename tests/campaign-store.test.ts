import { describe, expect, it } from "vitest";
import { DEFAULT_CAMPAIGN_POLICY } from "../src/campaign/campaign-policy";
import { CampaignStore, createCampaignState } from "../src/campaign/campaign-store";
import { refreshDailyLimit } from "../src/campaign/daily-limit";
import { validateCampaignInput } from "../src/shared/campaign";
import type { KeyValueStorage } from "../src/storage/state-store";

class MemoryStorage implements KeyValueStorage {
  value: Record<string, unknown> = {};
  async get(): Promise<Record<string, unknown>> { return this.value; }
  async set(items: Record<string, unknown>): Promise<void> { this.value = { ...this.value, ...items }; }
}

describe("campaign persistence", () => {
  it("rehydrates the full ordered campaign without duplicating binary assets", async () => {
    const storage = new MemoryStorage();
    const campaign = validateCampaignInput({
      campaignId: "campaign-persisted",
      campaignName: "Persistida",
      createdBy: "admin-1",
      recipients: [
        { recipientId: "r-1", name: "Uno", phone: "5491111111111", source: "flor_mia" },
        { recipientId: "r-2", name: "Dos", phone: "5492222222222", source: "excel" }
      ],
      message: "Texto compartido",
      imageCount: 1,
      imageOrder: [1],
      images: [{ order: 1, name: "uno.png", type: "image/png", size: 1, data: new Uint8Array([1]).buffer }],
      totalRecipients: 2
    });
    const state = createCampaignState(
      campaign,
      DEFAULT_CAMPAIGN_POLICY,
      refreshDailyLimit(null, 1_000, new Date(2026, 7, 15, 10, 0, 0)),
      "2026-08-15T13:00:00.000Z"
    );
    await new CampaignStore(storage).saveActive({
      ...state,
      status: "paused",
      currentRecipientIndex: 1,
      activeContactId: "r-2",
      completedRecipients: 1,
      lastCompletedContactId: "r-1",
      pauseRequested: true
    });

    const rehydrated = await new CampaignStore(storage).loadActive();
    expect(rehydrated).toMatchObject({
      campaignId: "campaign-persisted",
      status: "paused",
      currentRecipientIndex: 1,
      activeContactId: "r-2",
      completedRecipients: 1,
      lastCompletedContactId: "r-1",
      pauseRequested: true
    });
    expect(rehydrated?.recipients.map((recipient) => recipient.recipientId)).toEqual(["r-1", "r-2"]);
    expect(rehydrated?.images[0]).toEqual({ imageId: "image-1", order: 1, name: "uno.png", type: "image/png", size: 1 });
    expect(rehydrated?.images[0]).not.toHaveProperty("data");
  });
});
