import { describe, expect, it } from "vitest";
import { DEFAULT_CAMPAIGN_POLICY } from "../src/campaign/campaign-policy";
import { CampaignStore, createCampaignState } from "../src/campaign/campaign-store";
import { refreshDailyLimit } from "../src/campaign/daily-limit";
import { MAX_CAMPAIGN_RECIPIENTS, validateCampaignInput } from "../src/shared/campaign";
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

  it("persists 5000 recipients within the documented local storage budget", async () => {
    const storage = new MemoryStorage();
    const recipients = Array.from({ length: MAX_CAMPAIGN_RECIPIENTS }, (_, index) => ({
      recipientId: `recipient-${index}`,
      clientId: `client-${index}`,
      name: `Cliente ${index}`,
      phone: "5491111111111",
      source: "flor_mia" as const
    }));
    const campaign = validateCampaignInput({
      campaignId: "campaign-5000",
      campaignName: "Capacidad máxima",
      createdBy: "flor_mia",
      recipients,
      message: "Mensaje acotado",
      images: [],
      imageOrder: [],
      imageCount: 0,
      totalRecipients: recipients.length
    });
    const state = createCampaignState(
      campaign,
      DEFAULT_CAMPAIGN_POLICY,
      refreshDailyLimit(null, 1_000, new Date(2026, 7, 15, 10, 0, 0))
    );
    await new CampaignStore(storage).saveActive(state);
    const bytes = new TextEncoder().encode(JSON.stringify(storage.value)).byteLength;
    expect(bytes).toBeLessThan(5 * 1024 * 1024);
    expect((await new CampaignStore(storage).loadActive())?.recipients).toHaveLength(MAX_CAMPAIGN_RECIPIENTS);
  });

  it("migrates a legacy campaign with a new persistent run token", async () => {
    const storage = new MemoryStorage();
    const campaign = validateCampaignInput({
      campaignId: "legacy-run",
      campaignName: "Legacy",
      createdBy: "tests",
      recipients: [{ recipientId: "r-1", name: "", phone: "5491111111111", source: "flor_mia" }],
      message: "Hola",
      images: [],
      imageOrder: [],
      imageCount: 0,
      totalRecipients: 1
    });
    const state = createCampaignState(campaign, DEFAULT_CAMPAIGN_POLICY, refreshDailyLimit(null, 1_000));
    const legacy = { ...state };
    delete legacy.runToken;
    storage.value = { activeCampaign: legacy };
    const migrated = await new CampaignStore(storage).loadActive();
    expect(migrated?.runToken).toMatch(/^campaign-run-/);
    expect((storage.value.activeCampaign as { runToken?: string }).runToken).toBe(migrated?.runToken);
  });
});
